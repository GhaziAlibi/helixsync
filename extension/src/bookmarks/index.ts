// Bookmark synchronization per docs/protocol.md §8.2. Chromium bookmark IDs
// are local-only; every node gets a HelixSync objectId via the shared
// mapping table (docs/protocol.md §1.1). Chromium's four well-known root
// folders always exist without a "create" event, so they're mapped to
// fixed, deterministic objectIds every device agrees on rather than
// device-generated random ones.
import {
  deleteDeferredMaterialization,
  getDeferredMaterializationsWaitingOn,
  getFieldState,
  getFieldStatesForObjects,
  getMappedChromiumIdsByType,
  getMappingsByLocalIds,
  getMappingsByObjectIds,
  mappingKey,
  putDeferredMaterialization,
  putMappingsBatch,
  recordConflict,
} from "../storage/db";
import {
  establishMapping,
  forgetMapping,
  getOrCreateObjectId,
  lookupChromiumLocalId,
  lookupObjectId,
} from "../sync/mapping";
import {
  recordLocalFieldStatesBatch,
  resolveField,
  resolveFields,
  type FieldResolution,
  type LocalFieldStateEntry,
} from "../sync/conflict";
import { createLocalOperationsBatch, registerApplier } from "../sync/engine";
import type { PendingLocalOperation } from "../sync/engine";
import { createMicroBatchQueue } from "../sync/micro-batch";
import { createSuppressionGuard } from "../sync/suppress";
import { keyBetween } from "../util/fractional-index";
import { uuidv7 } from "../util/uuid";
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

async function objectIdFor(chromiumId: string): Promise<string> {
  return ROOT_OBJECT_IDS[chromiumId] ?? (await getOrCreateObjectId(MAP_TYPE, chromiumId));
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

async function positionOf(objectId: string): Promise<string | undefined> {
  const state = await getFieldState(objectId, "move");
  return (state?.value as { position?: string } | undefined)?.position;
}

async function computePosition(parentChromiumId: string, index: number): Promise<string> {
  const siblings = await chrome.bookmarks.getChildren(parentChromiumId);
  const beforeId = siblings[index - 1]?.id;
  const afterId = siblings[index + 1]?.id;
  const lo = beforeId ? ((await positionOf(await objectIdFor(beforeId))) ?? null) : null;
  const hi = afterId ? ((await positionOf(await objectIdFor(afterId))) ?? null) : null;
  return keyBetween(lo, hi);
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

type QueuedBookmarkEvent =
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
  return (await getFieldState(objectId, field))?.value;
}

async function stageCreated(
  id: string,
  node: chrome.bookmarks.BookmarkTreeNode,
  overlay: Map<string, unknown>,
): Promise<StagedBookmarkOp> {
  const objectId = await getOrCreateObjectId(MAP_TYPE, id);
  const objectType: ObjectType = node.url ? "bookmark" : "bookmarkFolder";
  const parentObjectId = node.parentId ? await objectIdFor(node.parentId) : null;
  // computePosition still hits chrome.bookmarks.getChildren + IndexedDB
  // live, per event — necessary for live capture (no pre-fetched tree like
  // EXT-1's backfill had) and not the bottleneck this finding targets, so
  // left as-is rather than force-batched (see EXT-4 task notes).
  const position = node.parentId
    ? await computePosition(node.parentId, node.index ?? 0)
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
): Promise<StagedBookmarkOp | null> {
  const objectId = await lookupObjectId(MAP_TYPE, id);
  if (!objectId) return null;
  const objectType: ObjectType = removeInfo.node.url ? "bookmark" : "bookmarkFolder";
  // forgetMapping runs immediately (not deferred to the batch flush like
  // operation/field-state writes) — mapping table writes stay per-event
  // throughout this file (see stageCreated's getOrCreateObjectId), so a
  // later event in the same burst always sees an accurate mapping table.
  await forgetMapping(MAP_TYPE, id);
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
): Promise<StagedBookmarkOp | null> {
  const objectId = await lookupObjectId(MAP_TYPE, id);
  if (!objectId) return null;
  const [node] = await chrome.bookmarks.get(id);
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
): Promise<StagedBookmarkOp | null> {
  const objectId = await lookupObjectId(MAP_TYPE, id);
  if (!objectId) return null;
  const [node] = await chrome.bookmarks.get(id);
  const objectType: ObjectType = node.url ? "bookmark" : "bookmarkFolder";

  const parentObjectId = await objectIdFor(moveInfo.parentId);
  const position = await computePosition(moveInfo.parentId, moveInfo.index);
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

async function flushBookmarkEvents(events: QueuedBookmarkEvent[]): Promise<void> {
  const overlay = new Map<string, unknown>();
  const staged: StagedBookmarkOp[] = [];

  for (const event of events) {
    try {
      let op: StagedBookmarkOp | null;
      switch (event.kind) {
        case "created":
          op = await stageCreated(event.id, event.node, overlay);
          break;
        case "removed":
          op = await stageRemoved(event.id, event.removeInfo);
          break;
        case "changed":
          op = await stageChanged(event.id, event.changeInfo, overlay);
          break;
        case "moved":
          op = await stageMoved(event.id, event.moveInfo, overlay);
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
 */
function flattenForBackfill(
  root: chrome.bookmarks.BookmarkTreeNode,
  alreadyMapped: ReadonlySet<string>,
  mappingsForAlreadyMapped: Map<string, { objectId: string }>,
  positionsForAlreadyMapped: Map<string, string>,
): { newMappings: BackfillMapping[]; newNodes: BackfillNode[] } {
  const newMappings: BackfillMapping[] = [];
  const newNodes: BackfillNode[] = [];

  function processChildren(children: chrome.bookmarks.BookmarkTreeNode[] | undefined, parentObjectId: string | null): void {
    // Tracks the nearest preceding sibling's resolved position, so each new
    // node's position is `keyBetween(runningLo, null)` — matching what the
    // live path effectively produces during a forward top-down walk, since
    // a not-yet-visited sibling never has a resolved position to bound
    // against either (see computePosition's live behavior).
    let runningLo: string | null = null;

    for (const child of children ?? []) {
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

        newMappings.push({ key: mappingKey(MAP_TYPE, child.id), objectType: MAP_TYPE, chromiumLocalId: child.id, objectId: ownObjectId });
        newNodes.push({
          objectType,
          objectId: ownObjectId,
          payload: { title: child.title, url: child.url ?? null, parent: parentObjectId, position },
        });
      }

      processChildren(child.children, ownObjectId);
    }
  }

  processChildren([root], null);
  return { newMappings, newNodes };
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
  const [root] = await chrome.bookmarks.getTree();
  const alreadyMapped = await getMappedChromiumIdsByType(MAP_TYPE);
  const mappingsForAlreadyMapped = await getMappingsByLocalIds(MAP_TYPE, [...alreadyMapped]);

  const moveStates = await getFieldStatesForObjects(
    [...mappingsForAlreadyMapped.values()].map((m) => m.objectId),
    "move",
  );
  const positionsForAlreadyMapped = new Map<string, string>();
  for (const [objectId, state] of moveStates) {
    const position = (state.value as { position?: string } | undefined)?.position;
    if (position) positionsForAlreadyMapped.set(objectId, position);
  }

  const { newMappings, newNodes } = flattenForBackfill(
    root,
    alreadyMapped,
    mappingsForAlreadyMapped,
    positionsForAlreadyMapped,
  );

  for (let i = 0; i < newNodes.length; i += BACKFILL_FLUSH_CHUNK) {
    const mappingChunk = newMappings.slice(i, i + BACKFILL_FLUSH_CHUNK);
    const nodeChunk = newNodes.slice(i, i + BACKFILL_FLUSH_CHUNK);

    // Mapping written before the operation exists, matching live capture's
    // getOrCreateObjectId-then-operation order in `stageCreated` above — so
    // a live event racing this backfill for one of these nodes can still
    // find its mapping even before this chunk's operations land.
    await putMappingsBatch(mappingChunk);

    const pending: PendingLocalOperation[] = nodeChunk.map((n) => ({
      objectType: n.objectType,
      objectId: n.objectId,
      operationType: "create",
      payload: n.payload,
    }));
    const created = await createLocalOperationsBatch(pending);

    const fieldStateEntries: LocalFieldStateEntry[] = [];
    created.forEach(({ operation, deviceId }, idx) => {
      const node = nodeChunk[idx];
      const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, "create");
      fieldStateEntries.push(
        { objectId: node.objectId, field: "title", key, value: node.payload.title },
        { objectId: node.objectId, field: "url", key, value: node.payload.url },
        { objectId: node.objectId, field: "move", key, value: { parent: node.payload.parent, position: node.payload.position } },
        { objectId: node.objectId, field: "liveness", key, value: "live" },
      );
    });
    await recordLocalFieldStatesBatch(fieldStateEntries);
  }
}

let captureRegistered = false;

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
    if (guard.isSuppressed()) return; // our own materialize() call, not a real local change
    enqueueBookmarkEvent({ kind: "created", id, node });
  });
  chrome.bookmarks.onRemoved.addListener((id, info) => {
    if (guard.isSuppressed()) return; // our own applyDelete() call; forgetMapping already runs there
    enqueueBookmarkEvent({ kind: "removed", id, removeInfo: info });
  });
  chrome.bookmarks.onChanged.addListener((id, info) => {
    if (guard.isSuppressed()) return; // our own applyTitle()/applyUrl() call
    enqueueBookmarkEvent({ kind: "changed", id, changeInfo: info });
  });
  chrome.bookmarks.onMoved.addListener((id, info) => {
    if (guard.isSuppressed()) return; // our own applyMove() call
    enqueueBookmarkEvent({ kind: "moved", id, moveInfo: info });
  });
}

// --- Remote apply: operation -> browser mutation -------------------------

async function materialize(objectId: string, objectType: ObjectType, p: BookmarkPayload): Promise<void> {
  // Both lookups are needed regardless of outcome, and neither is preceded
  // by a chrome.* call, so they share one transaction instead of two.
  const chromiumIds = await chromiumIdsFor(p.parent ? [objectId, p.parent] : [objectId]);

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
async function retryDeferredParent(parentObjectId: string): Promise<void> {
  const deferred = await getDeferredMaterializationsWaitingOn(parentObjectId);
  for (const record of deferred) {
    await deleteDeferredMaterialization(record.objectId);

    const liveness = await getFieldState(record.objectId, "liveness");
    if (liveness?.value !== "live") continue; // deleted (or never-live) since deferring

    const moveState = await getFieldState(record.objectId, "move");
    const move = moveState?.value as { parent?: string | null; position?: string } | undefined;

    if (await chromiumIdFor(record.objectId)) {
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
    const [titleState, urlState] = await Promise.all([
      getFieldState(record.objectId, "title"),
      getFieldState(record.objectId, "url"),
    ]);
    await materialize(record.objectId, record.objectType, {
      title: (titleState?.value as string) ?? "",
      url: (urlState?.value as string | null) ?? null,
      parent: move?.parent ?? null,
      position: move?.position ?? keyBetween(null, null),
    });
  }
}

async function applyTitle(objectId: string, title: string): Promise<void> {
  const chromiumId = await chromiumIdFor(objectId);
  if (chromiumId) await guard.run(() => chrome.bookmarks.update(chromiumId, { title }));
}

async function applyUrl(objectId: string, url: string): Promise<void> {
  const chromiumId = await chromiumIdFor(objectId);
  if (chromiumId) await guard.run(() => chrome.bookmarks.update(chromiumId, { url }));
}

async function applyMove(
  objectId: string,
  objectType: ObjectType,
  p: { parent: string; position: string },
): Promise<void> {
  // Both lookups are needed regardless of outcome, and neither is preceded
  // by a chrome.* call, so they share one transaction instead of two.
  const chromiumIds = await chromiumIdsFor([objectId, p.parent]);
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

async function applyDelete(objectId: string): Promise<void> {
  // A delete for an object that never got to materialize (still deferred,
  // waiting on a parent that itself may never arrive) has nothing further
  // to wait for — stop tracking it rather than leaving the row around
  // forever on the chance its parent eventually shows up.
  await deleteDeferredMaterialization(objectId);

  const chromiumId = await chromiumIdFor(objectId);
  if (!chromiumId) return;
  try {
    await guard.run(() => chrome.bookmarks.removeTree(chromiumId));
  } catch {
    // Already gone locally (e.g. user deleted it manually too) — fine.
  }
  await forgetMapping(MAP_TYPE, chromiumId);
}

async function applyRemote(op: OperationOut, payload: unknown): Promise<void> {
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
    if (liveness.applied) await materialize(op.objectId, op.objectType, p);
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
    if (p.title !== undefined && byField.get("title")!.applied) await applyTitle(op.objectId, p.title);
    if (typeof p.url === "string" && byField.get("url")!.applied) await applyUrl(op.objectId, p.url);
    return;
  }

  if (op.operationType === "move") {
    const p = payload as { parent: string; position: string };
    const [moveResult, liveness] = await resolveFields(op.objectId, [
      { field: "move", incoming: { ...key, value: p } },
      { field: "liveness", incoming: { ...key, value: "live" } },
    ]);
    if (moveResult.applied && liveness.value === "live") {
      await applyMove(op.objectId, op.objectType, p);
    }
    return;
  }

  if (op.operationType === "delete") {
    const r = await resolveField(op.objectId, "liveness", { ...key, value: "deleted" });
    if (r.applied) await applyDelete(op.objectId);
    return;
  }
}

registerApplier("bookmark", applyRemote);
registerApplier("bookmarkFolder", applyRemote);
