// Bookmark synchronization per docs/protocol.md §8.2. Chromium bookmark IDs
// are local-only; every node gets a HelixSync objectId via the shared
// mapping table (docs/protocol.md §1.1). Chromium's four well-known root
// folders always exist without a "create" event, so they're mapped to
// fixed, deterministic objectIds every device agrees on rather than
// device-generated random ones.
import {
  commitBookmarkBackfillBatch,
  deleteDeferredMaterialization,
  deleteDeferredMaterializationsBatch,
  deleteMappingsBatch,
  getDeferredMaterializationsWaitingOn,
  getDevice,
  getFieldState,
  getFieldStatesForObjects,
  getMappedChromiumIdsByType,
  getMappingsByLocalIds,
  getMappingsByObjectIds,
  mappingKey,
  putDeferredMaterialization,
  putMappingsBatch,
  recordConflict,
  type FieldStateRecord,
  type ObjectMappingRecord,
} from "../storage/db";
import {
  establishMapping,
  forgetMapping,
  lookupChromiumLocalId,
  lookupObjectId,
} from "../sync/mapping";
import {
  recordLocalFieldStatesBatch,
  resolveField,
  resolveFields,
  resolveFieldsBatch,
  type BatchFieldResolution,
  type FieldResolution,
  type LocalFieldStateEntry,
} from "../sync/conflict";
import { createLocalOperationsBatch, registerApplier, registerBatchApplier, scheduleLocalSync } from "../sync/engine";
import type { PendingLocalOperation } from "../sync/engine";
import { fetchSettings } from "../api/client";
import { createMicroBatchQueue, flushAllMicroBatchQueuesAndWait } from "../sync/micro-batch";
import { createSuppressionGuard } from "../sync/suppress";
import { chunk } from "../util/chunk";
import { keyBetween } from "../util/fractional-index";
import { uuidv7 } from "../util/uuid";
import { yieldToEventLoop } from "../util/yield";
import type { BookmarkPayload, ObjectType, OperationOut, OperationType } from "../sync/types";

const MAP_TYPE: ObjectType = "bookmark"; // shared local mapping namespace for all chrome.bookmarks nodes

// See sync/suppress.ts. Every chrome.bookmarks.* mutation issued from the
// remote-apply side below (materialize/applyTitle/applyUrl/applyMove/
// applyDelete) runs inside `guard.run`, and every local capture handler
// checks `guard.isSuppressed()` first — without this, applying a remote
// bookmark op re-triggers the matching onCreated/onChanged/onMoved/
// onRemoved listener, which emits a *new* operation for the same change,
// which the origin device applies right back, forever.
const guard = createSuppressionGuard();

const ROOT_OBJECT_IDS: Record<string, string> = {
  "0": "00000000-0000-7000-8000-000000000000",
  "1": "00000000-0000-7000-8000-000000000001", // Bookmarks Bar
  "2": "00000000-0000-7000-8000-000000000002", // Other Bookmarks
  "3": "00000000-0000-7000-8000-000000000003", // Mobile Bookmarks
};
const ROOT_CHROMIUM_IDS: Record<string, string> = Object.fromEntries(
  Object.entries(ROOT_OBJECT_IDS).map(([chromiumId, objectId]) => [objectId, chromiumId]),
);

/** New mappings minted during the current capture flush but not yet
 * committed — flushed once via `putMappingsBatch` after the staging loop
 * instead of one `putMapping` transaction per new node. The in-memory
 * `mappingCache` is updated immediately on mint so later events in the same
 * burst see an accurate view even before the DB commit. */
type NewMappingCollector = ObjectMappingRecord[];

async function objectIdFor(
  chromiumId: string,
  mappingCache?: Map<string, string>,
  newMappings?: NewMappingCollector,
  overlay?: Map<string, unknown>,
): Promise<string> {
  const root = ROOT_OBJECT_IDS[chromiumId];
  if (root) return root;
  const cached = mappingCache?.get(chromiumId);
  if (cached) return cached;
  const existing = await lookupObjectId(MAP_TYPE, chromiumId);
  if (existing) {
    mappingCache?.set(chromiumId, existing);
    return existing;
  }
  const objectId = uuidv7();
  mappingCache?.set(chromiumId, objectId);
  newMappings?.push({ key: mappingKey(MAP_TYPE, chromiumId), objectType: MAP_TYPE, chromiumLocalId: chromiumId, objectId });
  if (overlay) {
    // A freshly minted objectId (uuidv7) cannot have pre-existing field
    // state — no operation has ever referenced it — so seed the overlay
    // immediately. Otherwise the next `positionOf` for this sibling in the
    // same flush (measured: ~1 IndexedDB miss per node in bulk imports)
    // pays a transaction to rediscover the same `undefined`.
    // `stageCreated` overwrites its own object's entries right after, so a
    // seed here never shadows real values.
    for (const field of ["title", "url", "move"]) {
      const key = overlayKey(objectId, field);
      if (!overlay.has(key)) overlay.set(key, undefined);
    }
  }
  return objectId;
}

async function chromiumIdFor(objectId: string): Promise<string | undefined> {
  return ROOT_CHROMIUM_IDS[objectId] ?? (await lookupChromiumLocalId(objectId));
}

/** Batch counterpart to `chromiumIdFor` — one transaction covering every
 * id instead of one lookup per id, for the two call sites (`materialize`,
 * `applyMove`) that always need both an object's and its parent's
 * chromium id together. */
async function chromiumIdsFor(objectIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const needsLookup: string[] = [];
  for (const id of objectIds) {
    const root = ROOT_CHROMIUM_IDS[id];
    if (root) result.set(id, root);
    else needsLookup.push(id);
  }
  const mappings = await getMappingsByObjectIds(needsLookup);
  for (const [id, m] of mappings) result.set(id, m.chromiumLocalId);
  return result;
}

/** Per-flush overlay of field values staged earlier in the *same* batch but
 * not yet committed to IndexedDB (the actual write happens once, after the
 * whole queue is processed — see `flushBookmarkEvents`). Every
 * defense-in-depth read below goes through this instead of `getFieldState`
 * directly, so e.g. two onMoved events for the same node in one burst (a
 * move immediately followed by another) compare against each other's
 * result, not against stale pre-batch state (constraint: see EXT-4 task
 * notes on `stageChanged`/`stageMoved`'s defense-in-depth timing). */
function overlayKey(objectId: string, field: string): string {
  return `${objectId}:${field}`;
}
async function overlayOrFieldState(
  overlay: Map<string, unknown>,
  objectId: string,
  field: string,
): Promise<unknown> {
  const key = overlayKey(objectId, field);
  if (overlay.has(key)) return overlay.get(key);
  const val = (await getFieldState(objectId, field))?.value;
  overlay.set(key, val);
  return val;
}

export async function positionOf(objectId: string, overlay?: Map<string, unknown>): Promise<string | undefined> {
  if (overlay) {
    const key = overlayKey(objectId, "move");
    // An overlay hit — even a cached `undefined` (no field state when read
    // earlier in this same flush) — is authoritative for this flush: nothing
    // else commits field_state mid-flush, so falling through to a second
    // `getFieldState` read here could only ever return the same answer at
    // the cost of another IndexedDB round trip per sibling lookup.
    if (overlay.has(key)) {
      const state = overlay.get(key) as { position?: string } | undefined;
      return state?.position;
    }
  }
  const state = await getFieldState(objectId, "move");
  return (state?.value as { position?: string } | undefined)?.position;
}

export async function computePosition(
  parentChromiumId: string,
  index: number,
  overlay?: Map<string, unknown>,
  siblingCache?: Map<string, chrome.bookmarks.BookmarkTreeNode[]>,
  mappingCache?: Map<string, string>,
  newMappings?: NewMappingCollector,
): Promise<string> {
  let siblings = siblingCache?.get(parentChromiumId);
  if (!siblings) {
    siblings = await chrome.bookmarks.getChildren(parentChromiumId);
    siblingCache?.set(parentChromiumId, siblings);
  }
  const beforeId = siblings[index - 1]?.id;
  const afterId = siblings[index + 1]?.id;
  const [beforeObjectId, afterObjectId] = await Promise.all([
    beforeId ? objectIdFor(beforeId, mappingCache, newMappings, overlay) : Promise.resolve(undefined),
    afterId ? objectIdFor(afterId, mappingCache, newMappings, overlay) : Promise.resolve(undefined),
  ]);
  const [lo, hi] = await Promise.all([
    beforeObjectId ? positionOf(beforeObjectId, overlay) : Promise.resolve(undefined),
    afterObjectId ? positionOf(afterObjectId, overlay) : Promise.resolve(undefined),
  ]);
  return keyBetween(lo ?? null, hi ?? null);
}

function opKey(lamportTimestamp: number, deviceId: string, operationId: string, operationType: OperationType) {
  return { lamportTimestamp, deviceId, operationId, operationType };
}

// --- Local capture: browser event -> operation --------------------------
//
// EXT-4: a burst of chrome.bookmarks events (e.g. dragging a 100-child
// folder, which fires one onMoved per child) used to pay createLocalOperation
// + recordLocalFieldState's full WebCrypto/lamport/IndexedDB overhead once
// per event. Listeners below now do only the synchronous guard check (see
// the module-level comment on `guard` — this MUST stay synchronous, at
// event-fire time, or the suppression window closes before it's checked)
// and push the rest of the work onto a shared micro-batch queue
// (sync/micro-batch.ts); `flushBookmarkEvents` then turns the whole queue
// into one createLocalOperationsBatch + one recordLocalFieldStatesBatch
// call, the same batch primitives EXT-1's backfill uses.

export type QueuedBookmarkEvent =
  | { kind: "created"; id: string; node: chrome.bookmarks.BookmarkTreeNode }
  | { kind: "removed"; id: string; removeInfo: chrome.bookmarks.BookmarkRemoveInfo }
  | { kind: "changed"; id: string; changeInfo: chrome.bookmarks.BookmarkChangeInfo }
  | { kind: "moved"; id: string; moveInfo: chrome.bookmarks.BookmarkMoveInfo };

interface StagedBookmarkOp {
  objectType: ObjectType;
  objectId: string;
  operationType: OperationType;
  payload: unknown;
  fields: Array<{ field: string; value: unknown }>;
}

async function stageCreated(
  id: string,
  node: chrome.bookmarks.BookmarkTreeNode,
  overlay: Map<string, unknown>,
  siblingCache?: Map<string, chrome.bookmarks.BookmarkTreeNode[]>,
  mappingCache?: Map<string, string>,
  newMappings?: NewMappingCollector,
): Promise<StagedBookmarkOp> {
  let objectId = mappingCache?.get(id);
  if (!objectId) {
    objectId = await objectIdFor(id, mappingCache, newMappings, overlay);
  }
  const objectType: ObjectType = node.url ? "bookmark" : "bookmarkFolder";
  const parentObjectId = node.parentId ? await objectIdFor(node.parentId, mappingCache, newMappings, overlay) : null;
  // EXT-03: computePosition reuses siblingCache across the batch and checks
  // overlay when resolving sibling positions so sequential inserts don't
  // degrade position keys or re-query Chrome IPC.
  const position = node.parentId
    ? await computePosition(node.parentId, node.index ?? 0, overlay, siblingCache, mappingCache, newMappings)
    : keyBetween(null, null);

  const payload: BookmarkPayload = {
    title: node.title,
    url: node.url ?? null,
    parent: parentObjectId,
    position,
  };
  overlay.set(overlayKey(objectId, "title"), payload.title);
  overlay.set(overlayKey(objectId, "url"), payload.url);
  overlay.set(overlayKey(objectId, "move"), { parent: payload.parent, position: payload.position });

  return {
    objectType,
    objectId,
    operationType: "create",
    payload,
    fields: [
      { field: "title", value: payload.title },
      { field: "url", value: payload.url },
      { field: "move", value: { parent: payload.parent, position: payload.position } },
      { field: "liveness", value: "live" },
    ],
  };
}

async function stageRemoved(
  id: string,
  removeInfo: chrome.bookmarks.BookmarkRemoveInfo,
  mappingCache?: Map<string, string>,
  deletedLocalIds?: string[],
): Promise<StagedBookmarkOp | null> {
  let objectId = mappingCache?.get(id);
  if (!objectId) {
    objectId = await lookupObjectId(MAP_TYPE, id);
    if (objectId) mappingCache?.set(id, objectId);
  }
  if (!objectId) return null;
  const objectType: ObjectType = removeInfo.node.url ? "bookmark" : "bookmarkFolder";
  // Cache is updated immediately so a later event in the same burst sees an
  // accurate view; the DB delete is deferred to the batch flush below (one
  // `deleteMappingsBatch` instead of one transaction per removed node).
  mappingCache?.delete(id);
  deletedLocalIds?.push(id);
  return {
    objectType,
    objectId,
    operationType: "delete",
    payload: {},
    fields: [{ field: "liveness", value: "deleted" }],
  };
}

async function stageChanged(
  id: string,
  changeInfo: chrome.bookmarks.BookmarkChangeInfo,
  overlay: Map<string, unknown>,
  mappingCache?: Map<string, string>,
  nodeCache?: ReadonlyMap<string, chrome.bookmarks.BookmarkTreeNode>,
): Promise<StagedBookmarkOp | null> {
  let objectId = mappingCache?.get(id);
  if (!objectId) {
    objectId = await lookupObjectId(MAP_TYPE, id);
    if (objectId) mappingCache?.set(id, objectId);
  }
  if (!objectId) return null;
  const node = nodeCache?.get(id) ?? (await chrome.bookmarks.get(id))[0];
  const objectType: ObjectType = node.url ? "bookmark" : "bookmarkFolder";

  const payload: Partial<BookmarkPayload> = {};
  if (changeInfo.title !== undefined) payload.title = changeInfo.title;
  if (changeInfo.url !== undefined) payload.url = changeInfo.url;
  if (Object.keys(payload).length === 0) return null;

  // Defense in depth alongside the guard above: if this exactly matches
  // what's already recorded (e.g. a stray event surviving past the
  // guard's synchronous window, or an earlier event this same burst), skip
  // rather than re-emitting an identical operation.
  const [titleCurrent, urlCurrent] = await Promise.all([
    payload.title !== undefined ? overlayOrFieldState(overlay, objectId, "title") : undefined,
    payload.url !== undefined ? overlayOrFieldState(overlay, objectId, "url") : undefined,
  ]);
  if (
    (payload.title === undefined || titleCurrent === payload.title) &&
    (payload.url === undefined || urlCurrent === payload.url)
  ) {
    return null;
  }

  const fields: Array<{ field: string; value: unknown }> = [];
  if (payload.title !== undefined) fields.push({ field: "title", value: payload.title });
  if (payload.url !== undefined) fields.push({ field: "url", value: payload.url });
  for (const f of fields) overlay.set(overlayKey(objectId, f.field), f.value);

  return { objectType, objectId, operationType: "update", payload, fields };
}

async function stageMoved(
  id: string,
  moveInfo: chrome.bookmarks.BookmarkMoveInfo,
  overlay: Map<string, unknown>,
  siblingCache?: Map<string, chrome.bookmarks.BookmarkTreeNode[]>,
  mappingCache?: Map<string, string>,
  nodeCache?: ReadonlyMap<string, chrome.bookmarks.BookmarkTreeNode>,
  newMappings?: NewMappingCollector,
): Promise<StagedBookmarkOp | null> {
  let objectId = mappingCache?.get(id);
  if (!objectId) {
    objectId = await lookupObjectId(MAP_TYPE, id);
    if (objectId) mappingCache?.set(id, objectId);
  }
  if (!objectId) return null;
  const node = nodeCache?.get(id) ?? (await chrome.bookmarks.get(id))[0];
  const objectType: ObjectType = node.url ? "bookmark" : "bookmarkFolder";

  const parentObjectId = await objectIdFor(moveInfo.parentId, mappingCache, newMappings, overlay);
  const position = await computePosition(moveInfo.parentId, moveInfo.index, overlay, siblingCache, mappingCache, newMappings);
  const payload = { parent: parentObjectId, position };

  // Defense in depth alongside the guard above (see stageChanged) — reads
  // through the overlay so a second move of the same node later in this
  // same burst compares against the first move's *result*, not stale
  // pre-batch state (that staleness is what could otherwise wrongly skip
  // or wrongly double-apply a real chronological sequence of moves).
  const current = (await overlayOrFieldState(overlay, objectId, "move")) as
    | { parent?: string | null; position?: string }
    | undefined;
  if (current?.parent === payload.parent && current?.position === payload.position) return null;

  overlay.set(overlayKey(objectId, "move"), payload);
  return {
    objectType,
    objectId,
    operationType: "move",
    payload,
    fields: [{ field: "move", value: payload }],
  };
}

// Bounds the `getChildren`/`bookmarks.get` prefetch sweeps in
// `flushBookmarkEvents` (see its second prefetch phase): high enough to
// overlap Chromium IPC latency instead of serializing it, low enough not to
// flood the browser process — same value/rationale as history/index.ts's
// BACKFILL_URL_CONCURRENCY.
const STAGE_PREFETCH_CONCURRENCY = 25;

// Same kill-switch shape as history/index.ts's historyCaptureEnabled (see
// its comment): synchronous listener check + async flush/backstop,
// fail-open so a settings fetch failure never loses user bookmarks.
let bookmarkCaptureEnabled = true;

export function setBookmarkCaptureEnabled(enabled: boolean): void {
  bookmarkCaptureEnabled = enabled;
}

async function isBookmarkSyncEnabled(): Promise<boolean> {
  try {
    const settings = await fetchSettings();
    return settings.syncBookmarks !== false;
  } catch {
    return true;
  }
}

export async function flushBookmarkEvents(events: QueuedBookmarkEvent[]): Promise<void> {
  if (!(await isBookmarkSyncEnabled())) return;
  const overlay = new Map<string, unknown>();
  const siblingCache = new Map<string, chrome.bookmarks.BookmarkTreeNode[]>();
  const mappingCache = new Map<string, string>();

  // Singleton fast path: one event needs at most a couple of point reads
  // (one mapping lookup, one node read, one or two field reads). The three
  // prefetch phases below would spend up to 1 mapping batch + 1 node sweep +
  // 3 field-state batch reads (5 round trips) to serve that single event —
  // measured at 2 mapping batches + 3 field-state batches + 1 getChildren
  // for one isolated create. Creates/moves need no prefetch either:
  // computePosition's sibling reads fall back to live per-event calls
  // (1 getChildren + point lookups for the two neighbors), strictly fewer
  // round trips than warming the whole folder. Multi-event batches keep
  // prefetching (amortized). With empty caches the staging loop simply falls
  // back to its existing per-event live reads.
  const isSingleton = events.length === 1;
  const nodeCache = new Map<string, chrome.bookmarks.BookmarkTreeNode>();

  if (!isSingleton) {
  // Pre-fetch mappings for all local IDs known from the events up front in one batch transaction (EXT-04)
  const localIdsToPrefetch = new Set<string>();
  for (const event of events) {
    localIdsToPrefetch.add(event.id);
    if (event.kind === "created" && event.node.parentId) {
      localIdsToPrefetch.add(event.node.parentId);
    }
    if (event.kind === "moved" && event.moveInfo.parentId) {
      localIdsToPrefetch.add(event.moveInfo.parentId);
    }
  }
  if (localIdsToPrefetch.size > 0) {
    const prefetched = await getMappingsByLocalIds(MAP_TYPE, [...localIdsToPrefetch]);
    for (const [id, record] of prefetched) {
      mappingCache.set(id, record.objectId);
    }
  }

  // Second prefetch phase: everything `computePosition` and the changed/
  // moved stagings would otherwise fetch one at a time mid-loop. Staging
  // itself stays strictly sequential in event-fire order (the overlay's
  // chronological chaining depends on it), but every read it needs is
  // warmed into a cache first:
  // - one bounded-concurrency `getChildren` sweep per touched parent folder
  //   (seeding `siblingCache`) plus a single batched mapping lookup for all
  //   siblings seen, so per-node `objectIdFor(beforeId/afterId)` calls hit
  //   `mappingCache` instead of paying an IndexedDB round trip each;
  // - one bounded-concurrency `bookmarks.get` sweep for changed/moved nodes
  //   (seeding `nodeCache`), so per-event node-type lookups skip their IPC.
  // Per-item failures here fall back to the live call in the staging loop,
  // preserving the old per-event error isolation.
  const parentIdsToWarm = new Set<string>();
  const nodeIdsToWarm = new Set<string>();
  for (const event of events) {
    if (event.kind === "created" && event.node.parentId) {
      parentIdsToWarm.add(event.node.parentId);
    } else if (event.kind === "moved") {
      parentIdsToWarm.add(event.moveInfo.parentId);
      nodeIdsToWarm.add(event.id);
    } else if (event.kind === "changed") {
      nodeIdsToWarm.add(event.id);
    }
  }
  const uncachedParents = [...parentIdsToWarm].filter((p) => !siblingCache.has(p));
  for (const batch of chunk(uncachedParents, STAGE_PREFETCH_CONCURRENCY)) {
    const fetched = await Promise.all(
      batch.map(async (parentId) => {
        try {
          return { parentId, children: await chrome.bookmarks.getChildren(parentId) } as const;
        } catch {
          return { parentId, children: undefined } as const;
        }
      }),
    );
    for (const { parentId, children } of fetched) {
      if (children) siblingCache.set(parentId, children);
    }
  }
  // Warming every sibling's mapping up front only pays off for batches
  // that actually need sibling positions (creates/moves — changed/removed
  // events never touch siblings): a single isolated create in a 1k-child
  // folder needs exactly its two neighbors' mappings, not all 1k. A lone
  // move still needs its destination's full sibling set for the index
  // sort, but applyMove already loads that per folder in one batch — so
  // warming here as well would load it twice.
  const needsSiblingPositions = events.some((e) => e.kind === "created" || e.kind === "moved");
  const siblingIdsToWarm = new Set<string>();
  if (needsSiblingPositions) {
    for (const children of siblingCache.values()) {
      for (const sibling of children) {
        if (!mappingCache.has(sibling.id)) siblingIdsToWarm.add(sibling.id);
      }
    }
  }
  // Heuristic: bulk-warming N sibling mappings to serve E events is worth
  // it when the batch is large relative to the sibling set; for a tiny
  // batch in a huge folder, on-demand lookups (two neighbors for a create,
  // applyMove's own per-folder batch for a move) touch far fewer rows than
  // warming the whole folder.
  const SIBLING_WARM_RATIO = 10;
  if (siblingIdsToWarm.size > 0 && siblingIdsToWarm.size <= events.length * SIBLING_WARM_RATIO) {
    const siblingMappings = await getMappingsByLocalIds(MAP_TYPE, [...siblingIdsToWarm]);
    for (const [id, record] of siblingMappings) {
      mappingCache.set(id, record.objectId);
    }
  }
  for (const batch of chunk([...nodeIdsToWarm], STAGE_PREFETCH_CONCURRENCY)) {
    await Promise.all(
      batch.map(async (id) => {
        try {
          const [node] = await chrome.bookmarks.get(id);
          if (node) nodeCache.set(id, node);
        } catch {
          // Falls back to the live call in the staging loop below.
        }
      }),
    );
  }

  // Third prefetch phase: field-state overlay seeding. The staging loop's
  // defense-in-depth reads (stageChanged title/url, stageMoved move,
  // computePosition sibling positions) would otherwise each pay one
  // sequential `getFieldState` transaction per distinct object. Batched
  // fetches collapse those to at most 3 transactions total; the staging loop
  // then hits `overlay` instead of IndexedDB. Missing records are seeded as
  // `undefined` too so the first touch doesn't re-pay for a DB miss.
  // Scoped to the fields this burst can actually read (measured: a 20-move
  // burst fetched 42 title/url rows it never touched) — an unneeded field
  // is simply left unseeded and falls back to the same per-event live read
  // the staging loop always had, so scoping can only ever cost a live read,
  // never change a result.
  if (mappingCache.size > 0) {
    const needsMove = events.some((e) => e.kind === "created" || e.kind === "moved");
    const needsTitleUrl = events.some((e) => e.kind === "changed");
    const prefetchObjectIds = [...new Set(mappingCache.values())];
    const [titleStates, urlStates, moveStates] = await Promise.all([
      needsTitleUrl ? getFieldStatesForObjects(prefetchObjectIds, "title") : Promise.resolve(undefined),
      needsTitleUrl ? getFieldStatesForObjects(prefetchObjectIds, "url") : Promise.resolve(undefined),
      needsMove ? getFieldStatesForObjects(prefetchObjectIds, "move") : Promise.resolve(undefined),
    ]);
    const titleMap = titleStates ?? new Map();
    const urlMap = urlStates ?? new Map();
    const moveMap = moveStates ?? new Map();
    for (const objectId of prefetchObjectIds) {
      if (needsTitleUrl) {
        overlay.set(overlayKey(objectId, "title"), titleMap.get(objectId)?.value);
        overlay.set(overlayKey(objectId, "url"), urlMap.get(objectId)?.value);
      }
      if (needsMove) {
        overlay.set(overlayKey(objectId, "move"), moveMap.get(objectId)?.value);
      }
    }
  }
  } // end if (!isSingleton): singletons of any kind skip all prefetch

  const staged: StagedBookmarkOp[] = [];
  // Mapping writes minted/discovered mid-flush are collected here and
  // committed once below instead of one transaction per event. The
  // in-memory `mappingCache` is kept in lockstep during staging so later
  // events in the same burst always see an accurate view.
  const newMappings: NewMappingCollector = [];
  const deletedLocalIds: string[] = [];

  for (const event of events) {
    try {
      let op: StagedBookmarkOp | null;
      switch (event.kind) {
        case "created":
          op = await stageCreated(event.id, event.node, overlay, siblingCache, mappingCache, newMappings);
          break;
        case "removed":
          op = await stageRemoved(event.id, event.removeInfo, mappingCache, deletedLocalIds);
          break;
        case "changed":
          op = await stageChanged(event.id, event.changeInfo, overlay, mappingCache, nodeCache);
          break;
        case "moved":
          op = await stageMoved(event.id, event.moveInfo, overlay, siblingCache, mappingCache, nodeCache, newMappings);
          break;
      }
      if (op) staged.push(op);
    } catch (e) {
      // Per-event error isolation, matching the old per-listener .catch:
      // one bad event in a burst must not drop or corrupt the rest of the
      // batch's operations.
      console.error(`HelixSync bookmarks capture (${event.kind})`, event.id, e);
    }
  }
  if (staged.length === 0) return;

  // Commit mapping mutations before operations/field states so a crash
  // between them can't leave operations referencing unknown mappings.
  // Dedupe defensively: the same id can't be both created and removed in
  // one flush without the cache reflecting the final state, but a double
  // mint would otherwise put() twice.
  if (newMappings.length > 0) {
    const seen = new Set<string>();
    const deduped = newMappings.filter((m) => {
      if (seen.has(m.key)) return false;
      seen.add(m.key);
      return true;
    });
    await putMappingsBatch(deduped);
  }
  if (deletedLocalIds.length > 0) {
    await deleteMappingsBatch(MAP_TYPE, [...new Set(deletedLocalIds)]);
  }

  const pending: PendingLocalOperation[] = staged.map((op) => ({
    objectType: op.objectType,
    objectId: op.objectId,
    operationType: op.operationType,
    payload: op.payload,
  }));
  // Reserves one contiguous device-sequence/lamport range for the whole
  // batch — `staged` (and therefore `pending`) is in original event-fire
  // order, so the range is assigned in that same chronological order too.
  const created = await createLocalOperationsBatch(pending);

  const fieldStateEntries: LocalFieldStateEntry[] = [];
  created.forEach(({ operation, deviceId }, idx) => {
    const op = staged[idx];
    const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, op.operationType);
    for (const f of op.fields) {
      fieldStateEntries.push({ objectId: op.objectId, field: f.field, key, value: f.value });
    }
  });
  await recordLocalFieldStatesBatch(fieldStateEntries);
  // EXT-1: operations are now durably in pending_operations — nudge a sync
  // cycle instead of leaving them for the next alarm/push (see
  // scheduleLocalSync's doc comment in sync/engine.ts).
  scheduleLocalSync();
}

const enqueueBookmarkEvent = createMicroBatchQueue<QueuedBookmarkEvent>(flushBookmarkEvents);

interface BackfillNode {
  objectType: ObjectType;
  objectId: string;
  payload: BookmarkPayload;
}

interface BackfillMapping {
  key: string;
  objectType: ObjectType;
  chromiumLocalId: string;
  objectId: string;
}

// Matches history/index.ts's BACKFILL_FLUSH_CHUNK convention: bounds memory
// and per-transaction size for accounts with thousands of bookmarks, while
// still batching far more than one node's worth of writes per transaction.
const BACKFILL_FLUSH_CHUNK = 500;

/** Synchronous flatten of the bookmark tree into create-ops for backfill,
 * mirroring what the live per-node path (`stageCreated` + `computePosition`)
 * would produce, but computed entirely in memory from data already fetched
 * up front — no `chrome.bookmarks.getChildren` IPC or IndexedDB round trip
 * per node, since the full sibling list for every folder is already sitting
 * right here in `node.children`.
 *
 * `mappingsForAlreadyMapped`/`positionsForAlreadyMapped` cover every node in
 * `alreadyMapped` — see `backfillExisting` for why that snapshot is taken up
 * front. Walking top-down (a parent's `children` array is processed before
 * recursing into each child) means a child's own parent objectId, and every
 * already-resolved sibling's position, is always available in memory by the
 * time it's needed — no different from how the old per-node path relied on
 * the walk itself always visiting a parent before its children.
 *
 * `newMappings`/`newNodes` grow in lockstep (one entry pushed to each per
 * new node, at the same point) so the caller can chunk both arrays by the
 * same index range and know a chunk's mappings line up with its nodes.
 *
 * Streaming: `emit` is invoked once per new node, in walk order, and the
 * caller flushes every BACKFILL_FLUSH_CHUNK emissions. The whole tree is
 * therefore never materialized at once — peak memory stays at one chunk plus
 * the live tree itself, instead of O(tree). Positions are unaffected: each
 * node's position resolves from in-walk state (runningLo / up-front
 * snapshots) at emit time, independent of when earlier emissions commit.
 */
const BACKFILL_WALK_YIELD_CHUNK = 500;

async function flattenForBackfill(
  root: chrome.bookmarks.BookmarkTreeNode,
  alreadyMapped: ReadonlySet<string>,
  mappingsForAlreadyMapped: Map<string, { objectId: string }>,
  positionsForAlreadyMapped: Map<string, string>,
  emit: (mapping: BackfillMapping, node: BackfillNode) => Promise<void>,
): Promise<void> {
  let visited = 0;

  async function processChildren(
    children: chrome.bookmarks.BookmarkTreeNode[] | undefined,
    parentObjectId: string | null,
  ): Promise<void> {
    // Tracks the nearest preceding sibling's resolved position, so each new
    // node's position is `keyBetween(runningLo, null)` — matching what the
    // live path effectively produces during a forward top-down walk, since
    // a not-yet-visited sibling never has a resolved position to bound
    // against either (see computePosition's live behavior).
    let runningLo: string | null = null;

    for (const child of children ?? []) {
      if (++visited % BACKFILL_WALK_YIELD_CHUNK === 0) await yieldToEventLoop();
      const isRoot = child.id in ROOT_OBJECT_IDS;
      const isAlreadyMapped = !isRoot && alreadyMapped.has(child.id);

      let ownObjectId: string;
      if (isRoot) {
        ownObjectId = ROOT_OBJECT_IDS[child.id]; // never gets a create op or a position of its own
      } else if (isAlreadyMapped) {
        ownObjectId = mappingsForAlreadyMapped.get(child.id)!.objectId;
        const existingPosition = positionsForAlreadyMapped.get(ownObjectId);
        if (existingPosition !== undefined) runningLo = existingPosition;
      } else {
        ownObjectId = uuidv7();
        const objectType: ObjectType = child.url ? "bookmark" : "bookmarkFolder";
        const position = keyBetween(runningLo, null);
        runningLo = position;

        await emit(
          { key: mappingKey(MAP_TYPE, child.id), objectType: MAP_TYPE, chromiumLocalId: child.id, objectId: ownObjectId },
          {
            objectType,
            objectId: ownObjectId,
            payload: { title: child.title, url: child.url ?? null, parent: parentObjectId, position },
          },
        );
      }

      await processChildren(child.children, ownObjectId);
    }
  }

  await processChildren([root], null);
}

/** One-time import of bookmarks that already existed before HelixSync was
 * installed — chrome.bookmarks.onCreated only fires for changes going
 * forward, so anything already in the tree would otherwise never reach
 * the server (docs/protocol.md §8.2 assumes capture starts from an empty
 * tree). Safe to call more than once: any node that already had a mapping
 * *before this run started* — because it was captured by a prior run of
 * this function, by a real onCreated event, or materialized locally from a
 * remote device — is skipped rather than re-sent.
 *
 * The "already mapped" set (and the mapping/position snapshots derived from
 * it below) is taken once, up front, rather than checked live per node
 * during the walk — same reasoning as before this was batched: a live
 * per-node lookup could see a mapping minted moments earlier by this very
 * walk and skip that node, losing it from sync entirely since no create
 * operation was ever emitted for it. `flattenForBackfill` resolves every
 * objectId/position synchronously from these up-front snapshots (plus
 * whatever it mints itself in-order during the walk), so there is no
 * window for that race to begin with.
 */
export async function backfillExisting(): Promise<void> {
  if (!(await isBookmarkSyncEnabled())) return;
  // registerCapture's live listeners are already active by the time this
  // runs (background/index.ts registers capture before calling this), and a
  // live chrome.bookmarks event sits in the micro-batch queue for up to
  // FLUSH_DELAY_MS before its mapping actually lands in IndexedDB. A
  // bookmark touched in that window is already visible in `getTree()` below
  // but would still read as unmapped by `getMappedChromiumIdsByType`,
  // minting it a second objectId — a real duplicate. Awaiting the drain
  // (not the onSuspend-style fire-and-forget variant) closes that window,
  // short of a live event firing in the exact instant between this line and
  // `getTree()`, which is not closable and is effectively never hit in
  // practice.
  await flushAllMicroBatchQueuesAndWait();
  const [root] = await chrome.bookmarks.getTree();
  const rawMapped = await getMappedChromiumIdsByType(MAP_TYPE);
  const mappingsForAlreadyMapped = await getMappingsByLocalIds(MAP_TYPE, [...rawMapped]);

  const moveStates = await getFieldStatesForObjects(
    [...mappingsForAlreadyMapped.values()].map((m) => m.objectId),
    "move",
  );
  const positionsForAlreadyMapped = new Map<string, string>();
  for (const [objectId, state] of moveStates) {
    const position = (state.value as { position?: string } | undefined)?.position;
    if (position) positionsForAlreadyMapped.set(objectId, position);
  }

  // EXT-05: A node is only considered already-mapped if its backfill or live-create
  // transaction committed durably — which always writes a "move" field_state.
  // Any mapping lacking field state is an orphaned remnant of a crashed
  // non-atomic backfill from prior versions; treating it as unmapped allows
  // backfillExisting to re-capture and commit it atomically.
  const alreadyMapped = new Set<string>();
  for (const [chromiumId, mapping] of mappingsForAlreadyMapped) {
    if (moveStates.has(mapping.objectId)) {
      alreadyMapped.add(chromiumId);
    }
  }

  // Streaming commit: emissions buffer up to one chunk, then encrypt + commit
  // atomically mid-walk. Chunks land in walk order, identical to slicing a
  // pre-flattened array — but the walk never holds more than one chunk past
  // what the tree itself already retains.
  let pendingMappings: BackfillMapping[] = [];
  let pendingNodes: BackfillNode[] = [];

  // Same first-login duty-cycle guard as history/index.ts's backfill: each
  // chunk's pure-TS AEAD encrypts would otherwise run back-to-back at 100%
  // of the MV3 thread. A real timer sleep between committed chunks lets the
  // CPU cool; yields alone only preserve responsiveness, not thermals.
  const BACKFILL_CHUNK_COOLDOWN_MS = 150;
  const backfillCooldown = () => new Promise<void>((r) => setTimeout(r, BACKFILL_CHUNK_COOLDOWN_MS));

  async function flushBackfillChunk(): Promise<void> {
    if (pendingNodes.length === 0) return;
    // Abort cleanly on mid-import disconnect (see history backfill): the
    // committed prefix stays durable and idempotent via `alreadyMapped`,
    // and the disconnect path wipes the rest.
    if (!(await getDevice())) {
      pendingMappings = [];
      pendingNodes = [];
      return;
    }
    const mappingChunk = pendingMappings;
    const nodeChunk = pendingNodes;
    pendingMappings = [];
    pendingNodes = [];

    const pending: PendingLocalOperation[] = nodeChunk.map((n) => ({
      objectType: n.objectType,
      objectId: n.objectId,
      operationType: "create",
      payload: n.payload,
    }));
    // EXT-05: Prepare encrypted operations without enqueuing into IndexedDB immediately,
    // so mappings, pending operations, and field states are committed together in a single
    // atomic IndexedDB transaction below.
    const created = await createLocalOperationsBatch(pending, { enqueue: false });

    const fieldStates: Array<Omit<FieldStateRecord, "key">> = [];
    created.forEach(({ operation, deviceId }, idx) => {
      const node = nodeChunk[idx];
      fieldStates.push(
        {
          objectId: node.objectId,
          field: "title",
          lamportTimestamp: operation.lamportTimestamp,
          deviceId,
          operationId: operation.operationId,
          operationType: "create",
          value: node.payload.title,
        },
        {
          objectId: node.objectId,
          field: "url",
          lamportTimestamp: operation.lamportTimestamp,
          deviceId,
          operationId: operation.operationId,
          operationType: "create",
          value: node.payload.url,
        },
        {
          objectId: node.objectId,
          field: "move",
          lamportTimestamp: operation.lamportTimestamp,
          deviceId,
          operationId: operation.operationId,
          operationType: "create",
          value: { parent: node.payload.parent, position: node.payload.position },
        },
        {
          objectId: node.objectId,
          field: "liveness",
          lamportTimestamp: operation.lamportTimestamp,
          deviceId,
          operationId: operation.operationId,
          operationType: "create",
          value: "live",
        },
      );
    });

    await commitBookmarkBackfillBatch({
      mappings: mappingChunk,
      operations: created.map((c) => c.operation),
      fieldStates,
    });
    // Let popup messages and other chrome.* callbacks run between chunks —
    // each chunk's commit above is already atomic, so yielding here only
    // spaces out chunks, never widens a commit. The cooldown after it drops
    // the sustained CPU duty cycle (see BACKFILL_CHUNK_COOLDOWN_MS above).
    await yieldToEventLoop();
    await backfillCooldown();
  }

  await flattenForBackfill(root, alreadyMapped, mappingsForAlreadyMapped, positionsForAlreadyMapped, async (mapping, node) => {
    pendingMappings.push(mapping);
    pendingNodes.push(node);
    if (pendingNodes.length >= BACKFILL_FLUSH_CHUNK) await flushBackfillChunk();
  });
  await flushBackfillChunk(); // tail below one full chunk
}

let captureRegistered = false;

// A cached remote-reorder plan is valid only while Chrome's bookmark tree has
// not been changed by somebody other than the remote applier.  Event handlers
// increment this synchronously, before their async local-capture work starts.
// Our own mutations remain suppressed and therefore do not invalidate a plan.
let bookmarkLayoutGeneration = 0;

export function registerCapture(): void {
  // `initializeCaptureForSettings` (background/index.ts) calls this on
  // every startup *and* every REFRESH_CAPTURE_CONFIG message (sent on
  // device connect and on every settings save) — without this guard,
  // saving settings twice in one service worker lifetime would register
  // the same listener function twice, doubling (then tripling, ...) every
  // captured bookmark event into duplicate operations.
  if (captureRegistered) return;
  captureRegistered = true;

  // Each listener below does only the synchronous guard.isSuppressed()
  // check here, at event-fire time — this MUST NOT move into
  // flushBookmarkEvents (see the local-capture section's top comment):
  // the guard's suppression window is only valid synchronously around our
  // own chrome.* mutating call, and would have already closed by the time
  // a deferred flush ran, silently breaking loop prevention.
  chrome.bookmarks.onCreated.addListener((id, node) => {
    if (!bookmarkCaptureEnabled) return; // "Bookmarks" toggled off in settings
    if (guard.isSuppressed()) return; // our own materialize() call, not a real local change
    bookmarkLayoutGeneration++;
    enqueueBookmarkEvent({ kind: "created", id, node });
  });
  chrome.bookmarks.onRemoved.addListener((id, info) => {
    if (!bookmarkCaptureEnabled) return;
    if (guard.isSuppressed()) return; // our own applyDelete() call; forgetMapping already runs there
    bookmarkLayoutGeneration++;
    enqueueBookmarkEvent({ kind: "removed", id, removeInfo: info });
  });
  chrome.bookmarks.onChanged.addListener((id, info) => {
    if (!bookmarkCaptureEnabled) return;
    if (guard.isSuppressed()) return; // our own applyTitle()/applyUrl() call
    enqueueBookmarkEvent({ kind: "changed", id, changeInfo: info });
  });
  chrome.bookmarks.onMoved.addListener((id, info) => {
    if (!bookmarkCaptureEnabled) return;
    if (guard.isSuppressed()) return; // our own applyMove() call
    bookmarkLayoutGeneration++;
    enqueueBookmarkEvent({ kind: "moved", id, moveInfo: info });
  });
}

// --- Remote apply: operation -> browser mutation -------------------------

async function materialize(
  objectId: string,
  objectType: ObjectType,
  p: BookmarkPayload,
  prefetched?: ReadonlyMap<string, string>,
): Promise<void> {
  // Both lookups are needed regardless of outcome, and neither is preceded
  // by a chrome.* call, so they share one transaction instead of two — or
  // reuse the batch prefetch when called from `applyRemoteBatch`.
  const chromiumIds =
    prefetched && prefetched.has(objectId) && (!p.parent || prefetched.has(p.parent))
      ? prefetched
      : await chromiumIdsFor(p.parent ? [objectId, p.parent] : [objectId]);

  if (chromiumIds.has(objectId)) {
    await deleteDeferredMaterialization(objectId); // resolved via some other path already
    return;
  }

  const parentChromiumId = p.parent ? chromiumIds.get(p.parent) : undefined;
  if (!parentChromiumId) {
    // Parent hasn't been materialized locally yet (operations for
    // different objects can arrive in any order relative to each other).
    // Per the conflict invariant (docs/protocol.md §8.7) this must stay
    // recoverable rather than silently dropped — `retryDeferredParent`
    // retries this the moment `p.parent` itself finishes materializing.
    if (p.parent) {
      await putDeferredMaterialization({
        objectId,
        objectType,
        waitingOnParent: p.parent,
        createdAt: new Date().toISOString(),
      });
    }
    await recordConflict({
      objectType,
      objectId,
      description: "parent folder not yet available locally; bookmark deferred",
      createdAt: new Date().toISOString(),
      resolved: false,
    });
    return;
  }

  const created = await guard.run(() =>
    chrome.bookmarks.create({
      parentId: parentChromiumId,
      title: p.title,
      url: p.url ?? undefined,
    }),
  );
  await establishMapping(MAP_TYPE, created.id, objectId);
  if (prefetched instanceof Map) prefetched.set(objectId, created.id);
  await deleteDeferredMaterialization(objectId);
  await retryDeferredParent(objectId);
}

/** Called whenever `objectId` finishes materializing (create/restore) —
 * retries every bookmark/bookmarkFolder that was deferred waiting
 * specifically on it, whether that's a create/restore waiting on its
 * parent or a move waiting on its destination folder (dispatched below by
 * whether the object already has a local mapping). A retry that's still
 * blocked (on some *other* still-missing object) simply re-defers via the
 * same `materialize`/`applyMove` path — this recurses naturally: if one of
 * these retries is itself a folder that successfully materializes, its own
 * `retryDeferredParent` call unblocks whatever was waiting on *it*, and so
 * on down the tree. */
// Matches sync/engine.ts's CRYPTO_YIELD_CHUNK convention (see yieldToEventLoop's
// doc comment for why a MessageChannel round-trip rather than a microtask or
// setTimeout): a smaller chunk than that constant's 25, since each iteration
// here does chrome.bookmarks IPC work (materialize's create call, plus a
// recursive retryDeferredParent for every child that's itself a folder) that
// can be sizeable, rather than pure in-process crypto.
const DEFERRED_RETRY_YIELD_CHUNK = 10;

async function retryDeferredParent(parentObjectId: string): Promise<void> {
  const deferred = await getDeferredMaterializationsWaitingOn(parentObjectId);
  if (deferred.length === 0) return;

  // Batch every lookup the loop below needs, up front, in one shared
  // transaction each — instead of up to 6 sequential IDB round trips per
  // deferred record (deleteDeferredMaterialization, getFieldState x4,
  // chromiumIdFor), which made a folder with N deferred children cost
  // ~6N sequential transactions. Prefetching title/url for every record
  // (not just the subset that turns out to be unmaterialized) is a
  // deliberate, small amount of wasted work in exchange for keeping this
  // O(1) transactions instead of O(N).
  const deferredObjectIds = deferred.map((record) => record.objectId);
  const [livenessByObjectId, moveByObjectId, titleByObjectId, urlByObjectId, chromiumIdByObjectId] =
    await Promise.all([
      getFieldStatesForObjects(deferredObjectIds, "liveness"),
      getFieldStatesForObjects(deferredObjectIds, "move"),
      getFieldStatesForObjects(deferredObjectIds, "title"),
      getFieldStatesForObjects(deferredObjectIds, "url"),
      chromiumIdsFor(deferredObjectIds),
    ]);
  await deleteDeferredMaterializationsBatch(deferredObjectIds);

  let sinceYield = 0;
  for (const record of deferred) {
    if (++sinceYield >= DEFERRED_RETRY_YIELD_CHUNK) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
    const liveness = livenessByObjectId.get(record.objectId);
    if (liveness?.value !== "live") continue; // deleted (or never-live) since deferring

    const moveState = moveByObjectId.get(record.objectId);
    const move = moveState?.value as { parent?: string | null; position?: string } | undefined;

    if (chromiumIdByObjectId.has(record.objectId)) {
      // Already materialized — this was a move waiting on its destination.
      if (move?.parent) {
        await applyMove(record.objectId, record.objectType, {
          parent: move.parent,
          position: move.position ?? keyBetween(null, null),
        });
      }
      continue;
    }

    // Not yet materialized — this was a create/restore waiting on its parent.
    const titleState = titleByObjectId.get(record.objectId);
    const urlState = urlByObjectId.get(record.objectId);
    await materialize(record.objectId, record.objectType, {
      title: (titleState?.value as string) ?? "",
      url: (urlState?.value as string | null) ?? null,
      parent: move?.parent ?? null,
      position: move?.position ?? keyBetween(null, null),
    });
  }
}

async function applyTitle(objectId: string, title: string, prefetched?: ReadonlyMap<string, string>): Promise<void> {
  const chromiumId = prefetched?.get(objectId) ?? (await chromiumIdFor(objectId));
  if (chromiumId) await guard.run(() => chrome.bookmarks.update(chromiumId, { title }));
}

async function applyUrl(objectId: string, url: string, prefetched?: ReadonlyMap<string, string>): Promise<void> {
  const chromiumId = prefetched?.get(objectId) ?? (await chromiumIdFor(objectId));
  if (chromiumId) await guard.run(() => chrome.bookmarks.update(chromiumId, { url }));
}

async function applyMove(
  objectId: string,
  objectType: ObjectType,
  p: { parent: string; position: string },
  prefetched?: ReadonlyMap<string, string>,
): Promise<void> {
  // Both lookups are needed regardless of outcome, and neither is preceded
  // by a chrome.* call, so they share one transaction instead of two — or
  // reuse the batch prefetch when called from `applyRemoteBatch`.
  const chromiumIds =
    prefetched && prefetched.has(objectId) && prefetched.has(p.parent)
      ? prefetched
      : await chromiumIdsFor([objectId, p.parent]);
  const chromiumId = chromiumIds.get(objectId);
  if (!chromiumId) {
    // The object itself isn't materialized yet — nothing to move. Not a
    // deferral in its own right: once it does materialize (via
    // `retryDeferredParent`), it reads the *current* resolved "move"
    // field state directly, so it lands in the right place immediately
    // without ever needing this move applied separately.
    return;
  }

  const parentChromiumId = chromiumIds.get(p.parent);
  if (!parentChromiumId) {
    // Destination folder isn't materialized yet — defer exactly like a
    // create/restore waiting on its parent (docs/protocol.md §8.7): retried
    // by `retryDeferredParent` once `p.parent` itself materializes.
    await putDeferredMaterialization({
      objectId,
      objectType,
      waitingOnParent: p.parent,
      createdAt: new Date().toISOString(),
    });
    return;
  }
  await deleteDeferredMaterialization(objectId);

  // Sorting siblings by position previously looked up each one's mapping
  // and "move" field state sequentially — up to 2 IndexedDB transactions
  // per sibling, so a folder with N items cost up to 2N transactions on
  // every single move within it. Both lookups are now one batch each,
  // regardless of N.
  //
  // A one-off move intentionally reads Chrome's live tree. Consecutive remote
  // moves use `applyMovesBatch` below, whose cache is invalidated whenever an
  // unsuppressed bookmark-tree event arrives.
  const siblings = await chrome.bookmarks.getChildren(parentChromiumId);
  const siblingChromiumIds = siblings.filter((s) => s.id !== chromiumId).map((s) => s.id);
  const mappingBySiblingId = await getMappingsByLocalIds(MAP_TYPE, siblingChromiumIds);
  const siblingObjectIds = siblingChromiumIds
    .map((id) => mappingBySiblingId.get(id)?.objectId)
    .filter((id): id is string => !!id);
  const moveStateByObjectId = await getFieldStatesForObjects(siblingObjectIds, "move");

  const withPositions: Array<{ chromiumId: string; position: string }> = [];
  for (const siblingChromiumId of siblingChromiumIds) {
    const siblingObjectId = mappingBySiblingId.get(siblingChromiumId)?.objectId;
    if (!siblingObjectId) continue;
    const position = (moveStateByObjectId.get(siblingObjectId)?.value as { position?: string } | undefined)
      ?.position;
    if (position) withPositions.push({ chromiumId: siblingChromiumId, position });
  }
  withPositions.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
  let index = withPositions.findIndex((s) => s.position > p.position);
  if (index === -1) index = withPositions.length;

  await guard.run(() => chrome.bookmarks.move(chromiumId, { parentId: parentChromiumId, index }));
}

interface RemoteMove {
  objectId: string;
  objectType: ObjectType;
  parent: string;
  position: string;
}

interface CachedParentOrder {
  generation: number;
  childChromiumIds: Set<string>;
  objectIdByChromiumId: Map<string, string>;
  positionByObjectId: Map<string, string>;
  // Siblings with known positions, ascending by position, excluding nothing:
  // the mover is removed and re-inserted around each move so later moves in
  // the same run binary-search an up-to-date order without re-sorting.
  sorted: Array<{ chromiumId: string; position: string }>;
}

/** Insertion index for `position` in a position-ascending array — the same
 * slot the legacy `sort-then-findIndex(first position > target)` computes:
 * strictly after any existing equals (upper bound), in O(log N) instead of
 * O(N log N). Exported for unit testing. */
export function sortedInsertIndex(
  sorted: ReadonlyArray<{ position: string }>,
  position: string,
): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].position <= position) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Applies a consecutive run of already-resolved moves. Chrome has no bulk
 * move API, so moves remain sequential, but each destination folder's child
 * list and field-state lookup are shared for the run. The cache tracks this
 * function's own mutations and is thrown away as soon as a real local change
 * is observed, preserving the live-tree correctness of `applyMove`. */
async function applyMovesBatch(moves: RemoteMove[]): Promise<void> {
  if (moves.length === 0) return;

  const chromiumIds = await chromiumIdsFor([...new Set(moves.flatMap((move) => [move.objectId, move.parent]))]);
  const cacheByParent = new Map<string, CachedParentOrder>();
  const incomingPositionByObjectId = new Map(moves.map((move) => [move.objectId, move.position]));

  const getParentOrder = async (parentChromiumId: string): Promise<CachedParentOrder> => {
    const cached = cacheByParent.get(parentChromiumId);
    if (cached && cached.generation === bookmarkLayoutGeneration) return cached;

    const siblings = await chrome.bookmarks.getChildren(parentChromiumId);
    const childChromiumIds = siblings.map((sibling) => sibling.id);
    const mappings = await getMappingsByLocalIds(MAP_TYPE, childChromiumIds);
    const objectIds = childChromiumIds
      .map((id) => mappings.get(id)?.objectId)
      .filter((id): id is string => !!id);
    const states = await getFieldStatesForObjects(objectIds, "move");
    const objectIdByChromiumId = new Map<string, string>();
    const positionByObjectId = new Map<string, string>();
    for (const chromiumId of childChromiumIds) {
      const objectId = mappings.get(chromiumId)?.objectId;
      if (objectId) objectIdByChromiumId.set(chromiumId, objectId);
    }
    for (const objectId of objectIds) {
      const position = (states.get(objectId)?.value as { position?: string } | undefined)?.position;
      if (position) positionByObjectId.set(objectId, position);
    }
    // Sorted once per parent per run (with this batch's incoming positions
    // overlaid, exactly as the per-move loop below used to see them):
    // per-move work drops from rebuild+sort to remove+binary-search.
    const sorted: Array<{ chromiumId: string; position: string }> = [];
    for (const siblingChromiumId of childChromiumIds) {
      const siblingObjectId = objectIdByChromiumId.get(siblingChromiumId);
      if (!siblingObjectId) continue;
      const position =
        incomingPositionByObjectId.get(siblingObjectId) ?? positionByObjectId.get(siblingObjectId);
      if (position) sorted.push({ chromiumId: siblingChromiumId, position });
    }
    sorted.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    const order: CachedParentOrder = {
      generation: bookmarkLayoutGeneration,
      childChromiumIds: new Set(childChromiumIds),
      objectIdByChromiumId,
      positionByObjectId,
      sorted,
    };
    cacheByParent.set(parentChromiumId, order);
    return order;
  };

  for (const move of moves) {
    const chromiumId = chromiumIds.get(move.objectId);
    if (!chromiumId) continue; // it will be placed correctly when materialized
    const parentChromiumId = chromiumIds.get(move.parent);
    if (!parentChromiumId) {
      await putDeferredMaterialization({
        objectId: move.objectId,
        objectType: move.objectType,
        waitingOnParent: move.parent,
        createdAt: new Date().toISOString(),
      });
      continue;
    }
    await deleteDeferredMaterialization(move.objectId);

    const order = await getParentOrder(parentChromiumId);
    // Remove the mover from the cached order (in place), find its target
    // slot by binary search, and re-insert it there — the cached order stays
    // coherent for later moves in this run with no rebuild or re-sort.
    // `sortedInsertIndex` reproduces the legacy sort+findIndex slot exactly,
    // including placement after pre-existing equal positions.
    const cur = order.sorted.findIndex((s) => s.chromiumId === chromiumId);
    if (cur !== -1) order.sorted.splice(cur, 1);
    const index = sortedInsertIndex(order.sorted, move.position);

    await guard.run(() => chrome.bookmarks.move(chromiumId, { parentId: parentChromiumId, index }));
    // Keep cached membership coherent for later moves in this run. Position
    // values are read from `incomingPositionByObjectId`, so no DB reread is
    // needed for items moved earlier in the same batch.
    for (const cached of cacheByParent.values()) {
      cached.childChromiumIds.delete(chromiumId);
      // A mover leaving for a *different* parent must also leave that
      // parent's sorted order (same-window case is already handled by the
      // removal above, which then no-ops here).
      const at = cached.sorted.findIndex((s) => s.chromiumId === chromiumId);
      if (at !== -1) cached.sorted.splice(at, 1);
    }
    order.childChromiumIds.add(chromiumId);
    order.objectIdByChromiumId.set(chromiumId, move.objectId);
    order.positionByObjectId.set(move.objectId, move.position);
    order.sorted.splice(index, 0, { chromiumId, position: move.position });
  }
}

async function applyDelete(objectId: string, prefetched?: Map<string, string>): Promise<void> {
  // A delete for an object that never got to materialize (still deferred,
  // waiting on a parent that itself may never arrive) has nothing further
  // to wait for — stop tracking it rather than leaving the row around
  // forever on the chance its parent eventually shows up.
  await deleteDeferredMaterialization(objectId);

  const chromiumId = prefetched?.get(objectId) ?? (await chromiumIdFor(objectId));
  if (!chromiumId) return;
  try {
    await guard.run(() => chrome.bookmarks.removeTree(chromiumId));
  } catch {
    // Already gone locally (e.g. user deleted it manually too) — fine.
  }
  await forgetMapping(MAP_TYPE, chromiumId);
  prefetched?.delete(objectId);
}

async function applyRemote(
  op: OperationOut,
  payload: unknown,
  prefetched?: Map<string, string>,
): Promise<void> {
  const key = opKey(op.lamportTimestamp, op.deviceId, op.operationId, op.operationType);

  if (op.operationType === "create" || op.operationType === "restore") {
    const p = payload as BookmarkPayload;
    // These 4 fields have no chrome.* call between them, so they resolve
    // safely in one shared transaction instead of one each — `materialize`
    // (the only chrome.* call here) only runs after all 4 are settled.
    const [liveness] = await resolveFields(op.objectId, [
      { field: "liveness", incoming: { ...key, value: "live" } },
      { field: "title", incoming: { ...key, value: p.title } },
      { field: "url", incoming: { ...key, value: p.url } },
      { field: "move", incoming: { ...key, value: { parent: p.parent, position: p.position } } },
    ]);
    if (liveness.applied) await materialize(op.objectId, op.objectType, p, prefetched);
    return;
  }

  if (op.operationType === "update") {
    const p = payload as Partial<BookmarkPayload>;
    // Resolve every field first (order between title/url/liveness doesn't
    // matter — each field's LWW result only depends on its own prior
    // state), then apply the chrome.* mutations for whichever actually won.
    const entries: FieldResolution[] = [{ field: "liveness", incoming: { ...key, value: "live" } }];
    if (p.title !== undefined) entries.push({ field: "title", incoming: { ...key, value: p.title } });
    if (typeof p.url === "string") entries.push({ field: "url", incoming: { ...key, value: p.url } });
    const results = await resolveFields(op.objectId, entries);
    const byField = new Map(entries.map((e, i) => [e.field, results[i]]));
    if (p.title !== undefined && byField.get("title")!.applied) await applyTitle(op.objectId, p.title, prefetched);
    if (typeof p.url === "string" && byField.get("url")!.applied) await applyUrl(op.objectId, p.url, prefetched);
    return;
  }

  if (op.operationType === "move") {
    const p = payload as { parent: string; position: string };
    const [moveResult, liveness] = await resolveFields(op.objectId, [
      { field: "move", incoming: { ...key, value: p } },
      { field: "liveness", incoming: { ...key, value: "live" } },
    ]);
    if (moveResult.applied && liveness.value === "live") {
      await applyMove(op.objectId, op.objectType, p, prefetched);
    }
    return;
  }

  if (op.operationType === "delete") {
    const r = await resolveField(op.objectId, "liveness", { ...key, value: "deleted" });
    if (r.applied) await applyDelete(op.objectId, prefetched);
    return;
  }
}

/** Batch path used by the sync engine for a bounded page/chunk. Field-state
 * resolution still happens in wire order; only the browser mutations for a
 * consecutive run of winning moves are coalesced. A create/update/delete
 * flushes the run first because it can change the live sibling set.
 *
 * Mapping lookups for the whole batch are prefetched once up front (one
 * transaction instead of up to two per create/move), and the map is kept in
 * lockstep as creates/deletes land so later items in the same batch see
 * mappings minted earlier in it without re-reading. Yields every few items
 * so a full snapshot chunk doesn't monopolize the MV3 thread. */
const REMOTE_BATCH_YIELD_CHUNK = 10;

// Bounded concurrency for title/url mutations: unlike creates/deletes/moves
// they never change the live sibling set or mapping table, so winners from
// across a slice can share IPC round trips safely. Creates/deletes stay
// strictly sequential in wire order (parent-before-child and sibling-set
// hazards), moves stay coalesced via applyMovesBatch.
const REMOTE_TITLE_URL_CONCURRENCY = 10;

// Bounds how many ops' field resolutions share one IndexedDB transaction in
// `applyRemoteBatch`: small enough to keep the resolve-then-mutate crash
// window (and the write-lock hold) bounded like MARK_APPLIED_CHUNK's own
// tradeoff in sync/engine.ts, large enough that a 500-op page costs ~10
// resolution transactions instead of ~500.
const REMOTE_RESOLVE_SLICE = 50;

type RemoteBatchItemKind = "create" | "update" | "move" | "delete" | "unknown";

async function applyRemoteBatch(items: Array<{ op: OperationOut; payload: unknown }>): Promise<void> {
  const involved = new Set<string>();
  for (const { op, payload } of items) {
    involved.add(op.objectId);
    if (op.operationType === "create" || op.operationType === "restore") {
      const parent = (payload as BookmarkPayload).parent;
      if (parent) involved.add(parent);
    } else if (op.operationType === "move") {
      involved.add((payload as { parent: string }).parent);
    }
  }
  const prefetched = await chromiumIdsFor([...involved]);

  let pendingMoves: RemoteMove[] = [];
  const flushMoves = async () => {
    if (pendingMoves.length === 0) return;
    const moves = pendingMoves;
    pendingMoves = [];
    await applyMovesBatch(moves);
  };

  // Title/url-only mutations buffered across a slice and flushed with
  // bounded concurrency (see REMOTE_TITLE_URL_CONCURRENCY). Safe to defer
  // past moves/creates in the same slice: they touch neither the sibling
  // order nor the mapping table that those depend on.
  let pendingTitleUrl: Array<() => Promise<void>> = [];
  const flushTitleUrl = async () => {
    if (pendingTitleUrl.length === 0) return;
    const batch = pendingTitleUrl;
    pendingTitleUrl = [];
    for (const group of chunk(batch, REMOTE_TITLE_URL_CONCURRENCY)) {
      await Promise.all(group.map((fn) => fn()));
    }
  };

  let sinceYield = 0;
  const maybeYield = async () => {
    if (++sinceYield >= REMOTE_BATCH_YIELD_CHUNK) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  };

  // Two phases per slice, mirroring the tabs batch appliers: phase 1
  // resolves every touched slot in one transaction (entries in wire order,
  // so same-object repeats arbitrate exactly as sequential `resolveFields`
  // calls would); phase 2 replays `applyRemote`'s mutate branches for the
  // winners. The single-op `applyRemote` stays for snapshot tombstones,
  // which bypass batch appliers via applyOneRemote.
  for (let start = 0; start < items.length; start += REMOTE_RESOLVE_SLICE) {
    const slice = items.slice(start, start + REMOTE_RESOLVE_SLICE);
    const entries: BatchFieldResolution[] = [];
    const kinds: RemoteBatchItemKind[] = [];
    const entryIndex: number[][] = [];
    for (const { op, payload } of slice) {
      const key = opKey(op.lamportTimestamp, op.deviceId, op.operationId, op.operationType);
      const idx: number[] = [];
      if (op.operationType === "create" || op.operationType === "restore") {
        const p = payload as BookmarkPayload;
        kinds.push("create");
        idx.push(entries.length);
        entries.push({ objectId: op.objectId, field: "liveness", incoming: { ...key, value: "live" } });
        idx.push(entries.length);
        entries.push({ objectId: op.objectId, field: "title", incoming: { ...key, value: p.title } });
        idx.push(entries.length);
        entries.push({ objectId: op.objectId, field: "url", incoming: { ...key, value: p.url } });
        idx.push(entries.length);
        entries.push({
          objectId: op.objectId,
          field: "move",
          incoming: { ...key, value: { parent: p.parent, position: p.position } },
        });
      } else if (op.operationType === "update") {
        kinds.push("update");
        idx.push(entries.length);
        entries.push({ objectId: op.objectId, field: "liveness", incoming: { ...key, value: "live" } });
        const p = payload as Partial<BookmarkPayload>;
        if (p.title !== undefined) {
          idx.push(entries.length);
          entries.push({ objectId: op.objectId, field: "title", incoming: { ...key, value: p.title } });
        } else {
          idx.push(-1);
        }
        if (typeof p.url === "string") {
          idx.push(entries.length);
          entries.push({ objectId: op.objectId, field: "url", incoming: { ...key, value: p.url } });
        } else {
          idx.push(-1);
        }
      } else if (op.operationType === "move") {
        const p = payload as { parent: string; position: string };
        kinds.push("move");
        idx.push(entries.length);
        entries.push({ objectId: op.objectId, field: "move", incoming: { ...key, value: p } });
        idx.push(entries.length);
        entries.push({ objectId: op.objectId, field: "liveness", incoming: { ...key, value: "live" } });
      } else if (op.operationType === "delete") {
        kinds.push("delete");
        idx.push(entries.length);
        entries.push({ objectId: op.objectId, field: "liveness", incoming: { ...key, value: "deleted" } });
      } else {
        kinds.push("unknown");
      }
      entryIndex.push(idx);
    }
    const results = await resolveFieldsBatch(entries);

    for (let k = 0; k < slice.length; k++) {
      const { op, payload } = slice[k];
      const res = entryIndex[k].map((e) => (e >= 0 ? results[e] : undefined));
      switch (kinds[k]) {
        case "create": {
          const p = payload as BookmarkPayload;
          await flushMoves();
          await flushTitleUrl();
          if (res[0]!.applied) await materialize(op.objectId, op.objectType, p, prefetched);
          break;
        }
        case "update": {
          const p = payload as Partial<BookmarkPayload>;
          // Creates/deletes flush pending moves (sibling-set hazard), but
          // title/url mutations do not — buffer them for concurrent flush
          // instead of paying one IPC round trip each.
          if (p.title !== undefined && res[1]!.applied) {
            const title = p.title;
            pendingTitleUrl.push(() => applyTitle(op.objectId, title, prefetched));
          }
          if (typeof p.url === "string" && res[2]!.applied) {
            const url = p.url;
            pendingTitleUrl.push(() => applyUrl(op.objectId, url, prefetched));
          }
          if (pendingTitleUrl.length >= REMOTE_TITLE_URL_CONCURRENCY * 2) await flushTitleUrl();
          break;
        }
        case "move": {
          const p = payload as { parent: string; position: string };
          if (res[0]!.applied && res[1]!.value === "live") {
            pendingMoves.push({ objectId: op.objectId, objectType: op.objectType, ...p });
          }
          break;
        }
        case "delete": {
          // Same flush-before-mutation ordering as the other structural kinds.
          await flushMoves();
          await flushTitleUrl();
          if (res[0]!.applied) await applyDelete(op.objectId, prefetched);
          break;
        }
        case "unknown": {
          await flushMoves();
          await flushTitleUrl();
          console.warn("HelixSync: no applier registered for operation type", op.operationType);
          break;
        }
      }
      await maybeYield();
    }
    // Flush title/url winners for this slice before the next slice's
    // resolution (bounds the resolve-then-mutate crash window to one slice,
    // mirroring MARK_APPLIED_CHUNK's tradeoff). Trailing moves still carry
    // across slices to preserve the shared child-list cache.
    await flushTitleUrl();
    // Carry a trailing move run into the next slice rather than flushing
    // here: flushing per slice would split a same-parent run across two
    // applyMovesBatch calls and lose the shared child-list cache. The
    // final flush after the loop covers the tail.
  }
  await flushTitleUrl();
  await flushMoves();
}

registerApplier("bookmark", applyRemote);
registerApplier("bookmarkFolder", applyRemote);
registerBatchApplier("bookmark", applyRemoteBatch);
registerBatchApplier("bookmarkFolder", applyRemoteBatch);
