// Bookmark sync (docs/protocol.md §8.2). Chromium bookmark ids are local, so
// every node gets a HelixSync objectId through the mapping table (§1.1).
// The built-in root folders exist on every device without a "create" event,
// so they map to fixed objectIds that all devices agree on (roots.ts).
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
  putDeferredMaterializationsBatch,
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
  resolveFields,
  resolveFieldsBatch,
  type BatchFieldResolution,
  type FieldResolution,
  type LocalFieldStateEntry,
  type ResolveResult,
} from "../sync/conflict";
import { createLocalOperationsBatch, registerApplier, registerBatchApplier, scheduleLocalSync } from "../sync/engine";
import type { CreatedOperation, PendingLocalOperation } from "../sync/engine";
import { isSyncableUrl } from "../util/url-scheme";
import { fetchSettings } from "../api/client";
import { createMicroBatchQueue, flushAllMicroBatchQueuesAndWait } from "../sync/micro-batch";
import { createSuppressionGuard } from "../sync/suppress";
import {
  bookmarkRoots,
  ensureStandInRoot,
  invalidateBookmarkRoots,
  isLazyRootObjectId,
  isNativeRootId,
  standInRootObjectId,
  type BookmarkRoots,
} from "./roots";
import { isFirefox } from "../util/browser";
import { chunk } from "../util/chunk";
import { keyBetween } from "../util/fractional-index";
import { uuidv7 } from "../util/uuid";
import { yieldToEventLoop } from "../util/yield";
import type { BookmarkPayload, ObjectType, OperationOut, OperationType } from "../sync/types";
import type { BookmarkChangeInfo, BookmarkMoveInfo, BookmarkRemoveInfo } from "../util/chrome-types";

// One mapping namespace for all chrome.bookmarks nodes, folders included.
const MAP_TYPE: ObjectType = "bookmark";

// Remote-apply mutations run inside guard.run and capture listeners skip
// suppressed events; otherwise every applied remote change would be
// re-captured, re-uploaded and bounce between devices forever.
const guard = createSuppressionGuard();

const roots = (): Promise<BookmarkRoots> => bookmarkRoots(guard);

type BookmarkMove = { parent: string; position: string };
type RecordedMove = { parent?: string | null; position?: string };

// Firefox has bookmark separators; Chromium doesn't. A separator syncs as a
// bookmark with this URL (floccus's convention, so the two interoperate):
// Chromium shows it as a plain bookmark, Firefox turns it back into a
// separator. Firefox's own separator nodes carry `url: "data:"`.
export const SEPARATOR_URL = "https://separator.floccus.org/";
export const SEPARATOR_TITLE = "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯";

type NodeLike = { url?: string; title?: string; type?: string };

export function isSeparatorNode(node: NodeLike): boolean {
  return node.type === "separator";
}

export function isSeparatorUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === "separator.floccus.org";
  } catch {
    return false;
  }
}

/** The URL a node syncs with: a separator's marker, else its own. */
export function syncedUrl(node: NodeLike): string | undefined {
  return isSeparatorNode(node) ? SEPARATOR_URL : node.url;
}

/** The title a node syncs with. */
export function syncedTitle(node: NodeLike): string {
  return isSeparatorNode(node) ? SEPARATOR_TITLE : (node.title ?? "");
}

function bookmarkObjectType(node: NodeLike): ObjectType {
  return syncedUrl(node) ? "bookmark" : "bookmarkFolder";
}

function byPosition(a: { position: string }, b: { position: string }): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
}

/** Mappings minted during a capture flush, committed in one batch after
 * staging. The flush's `mappingCache` is updated immediately, so later
 * events in the same burst already see them. */
type NewMappingCollector = ObjectMappingRecord[];

async function objectIdFor(
  chromiumId: string,
  mappingCache?: Map<string, string>,
  newMappings?: NewMappingCollector,
  overlay?: Map<string, unknown>,
): Promise<string> {
  const root = (await roots()).objectIdByChromiumId.get(chromiumId);
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
    // A freshly minted id can't have field state yet; seeding the overlay
    // saves a pointless IndexedDB miss when it's read as a sibling later.
    for (const field of ["title", "url", "move"]) {
      const key = overlayKey(objectId, field);
      if (!overlay.has(key)) overlay.set(key, undefined);
    }
  }
  return objectId;
}

/** Existing mapping only; never mints. */
async function cachedObjectId(chromiumId: string, mappingCache?: Map<string, string>): Promise<string | undefined> {
  let objectId = mappingCache?.get(chromiumId);
  if (!objectId) {
    objectId = await lookupObjectId(MAP_TYPE, chromiumId);
    if (objectId) mappingCache?.set(chromiumId, objectId);
  }
  return objectId;
}

async function chromiumIdFor(objectId: string): Promise<string | undefined> {
  return (await roots()).chromiumIdByObjectId.get(objectId) ?? (await lookupChromiumLocalId(objectId));
}

async function chromiumIdsFor(objectIds: string[]): Promise<Map<string, string>> {
  const { chromiumIdByObjectId } = await roots();
  const result = new Map<string, string>();
  const needsLookup: string[] = [];
  for (const id of objectIds) {
    const root = chromiumIdByObjectId.get(id);
    if (root) result.set(id, root);
    else needsLookup.push(id);
  }
  const mappings = await getMappingsByObjectIds(needsLookup);
  for (const [id, m] of mappings) result.set(id, m.chromiumLocalId);
  return result;
}

// Per-flush overlay of field values staged earlier in the same batch but not
// yet committed, so e.g. a second move of a node in one burst compares
// against the first move's result rather than stale stored state.
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
    // Any overlay hit, even a cached `undefined`, is authoritative for the
    // flush: nothing else writes field state mid-flush.
    const key = overlayKey(objectId, "move");
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
  // A stand-in root has no position, so the neighbours are the nearest
  // siblings that aren't one.
  const { standInIds } = await roots();
  const isStandIn = (i: number) => standInIds.has(siblings[i]?.id ?? "");
  let before = index - 1;
  while (before >= 0 && isStandIn(before)) before--;
  let after = index + 1;
  while (after < siblings.length && isStandIn(after)) after++;
  const beforeId = siblings[before]?.id;
  const afterId = siblings[after]?.id;
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
// Listeners only do the synchronous guard check (it must run at event-fire
// time) and queue the event. `flushBookmarkEvents` turns each burst into one
// batched encrypt and one batched field-state write.

export type QueuedBookmarkEvent =
  | { kind: "created"; id: string; node: chrome.bookmarks.BookmarkTreeNode }
  | { kind: "removed"; id: string; removeInfo: BookmarkRemoveInfo }
  | { kind: "changed"; id: string; changeInfo: BookmarkChangeInfo }
  | { kind: "moved"; id: string; moveInfo: BookmarkMoveInfo };

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
  const objectType = bookmarkObjectType(node);
  const parentObjectId = node.parentId ? await objectIdFor(node.parentId, mappingCache, newMappings, overlay) : null;
  const position = node.parentId
    ? await computePosition(node.parentId, node.index ?? 0, overlay, siblingCache, mappingCache, newMappings)
    : keyBetween(null, null);

  const payload: BookmarkPayload = {
    title: syncedTitle(node),
    url: syncedUrl(node) ?? null,
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

/** Chromium ids of everything under `node`, not `node` itself. Iterative, so
 * a deeply nested tree can't overflow the stack. */
function descendantIds(node: chrome.bookmarks.BookmarkTreeNode): string[] {
  const ids: string[] = [];
  const stack = [...(node.children ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    ids.push(next.id);
    if (next.children) stack.push(...next.children);
  }
  return ids;
}

async function stageRemoved(
  id: string,
  removeInfo: BookmarkRemoveInfo,
  mappingCache?: Map<string, string>,
  deletedLocalIds?: string[],
): Promise<StagedBookmarkOp | null> {
  const objectId = await cachedObjectId(id, mappingCache);
  if (!objectId) return null;
  const objectType = bookmarkObjectType(removeInfo.node);
  // The DB delete is batched after staging; the cache reflects it right away.
  mappingCache?.delete(id);
  deletedLocalIds?.push(id);
  // Removing a folder emits one delete, for the folder. Its descendants stay
  // live on the account, but their nodes are gone, so their mappings must go
  // too: a later `restore` of one has to create it, not find a stale mapping.
  for (const descendantId of descendantIds(removeInfo.node)) {
    mappingCache?.delete(descendantId);
    deletedLocalIds?.push(descendantId);
  }
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
  changeInfo: BookmarkChangeInfo,
  overlay: Map<string, unknown>,
  mappingCache?: Map<string, string>,
  nodeCache?: ReadonlyMap<string, chrome.bookmarks.BookmarkTreeNode>,
): Promise<StagedBookmarkOp | null> {
  const objectId = await cachedObjectId(id, mappingCache);
  if (!objectId) return null;
  const node = nodeCache?.get(id) ?? (await chrome.bookmarks.get(id))[0];
  // A separator has nothing to change; its title and URL are fixed.
  if (isSeparatorNode(node)) return null;
  const objectType = bookmarkObjectType(node);

  const payload: Partial<BookmarkPayload> = {};
  if (changeInfo.title !== undefined) payload.title = changeInfo.title;
  if (changeInfo.url !== undefined) payload.url = changeInfo.url;
  if (Object.keys(payload).length === 0) return null;

  // Backstop for the guard: skip a change that matches what's already
  // recorded (a stray echo, or an earlier event in this burst).
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
  moveInfo: BookmarkMoveInfo,
  overlay: Map<string, unknown>,
  siblingCache?: Map<string, chrome.bookmarks.BookmarkTreeNode[]>,
  mappingCache?: Map<string, string>,
  nodeCache?: ReadonlyMap<string, chrome.bookmarks.BookmarkTreeNode>,
  newMappings?: NewMappingCollector,
): Promise<StagedBookmarkOp | null> {
  const objectId = await cachedObjectId(id, mappingCache);
  if (!objectId) return null;
  const node = nodeCache?.get(id) ?? (await chrome.bookmarks.get(id))[0];
  const objectType = bookmarkObjectType(node);

  const parentObjectId = await objectIdFor(moveInfo.parentId, mappingCache, newMappings, overlay);
  const position = await computePosition(moveInfo.parentId, moveInfo.index, overlay, siblingCache, mappingCache, newMappings);
  const payload = { parent: parentObjectId, position };

  // Same backstop as stageChanged, read through the overlay so consecutive
  // moves in one burst chain correctly.
  const current = (await overlayOrFieldState(overlay, objectId, "move")) as RecordedMove | undefined;
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

// Overlaps Chromium IPC latency without flooding the browser process.
const STAGE_PREFETCH_CONCURRENCY = 25;

// Bulk-warming sibling mappings pays off only when the batch is large
// relative to the folders it touches.
const SIBLING_WARM_RATIO = 10;

// Synchronous listener kill-switch, set from the "Bookmarks" setting. The
// flush-time settings check is the backstop for events already queued.
// Fails open so a settings fetch failure never loses bookmarks.
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

/** Warms every cache the staging loop would otherwise fill one IPC or
 * IndexedDB round trip at a time. Staging itself stays sequential in
 * event order. A failed prefetch just falls back to the live read. */
async function prefetchFlushCaches(
  events: QueuedBookmarkEvent[],
  overlay: Map<string, unknown>,
  siblingCache: Map<string, chrome.bookmarks.BookmarkTreeNode[]>,
  mappingCache: Map<string, string>,
  nodeCache: Map<string, chrome.bookmarks.BookmarkTreeNode>,
): Promise<void> {
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

  // Only creates and moves read sibling positions.
  const needsSiblingPositions = events.some((e) => e.kind === "created" || e.kind === "moved");
  const siblingIdsToWarm = new Set<string>();
  if (needsSiblingPositions) {
    for (const children of siblingCache.values()) {
      for (const sibling of children) {
        if (!mappingCache.has(sibling.id)) siblingIdsToWarm.add(sibling.id);
      }
    }
  }
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
          // Falls back to the live call in the staging loop.
        }
      }),
    );
  }

  // Seed the overlay with only the fields this burst can read; misses are
  // seeded as `undefined` so the first read doesn't re-query.
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
}

function dedupeByKey(mappings: ObjectMappingRecord[]): ObjectMappingRecord[] {
  const seen = new Set<string>();
  return mappings.filter((m) => {
    if (seen.has(m.key)) return false;
    seen.add(m.key);
    return true;
  });
}

export async function flushBookmarkEvents(events: QueuedBookmarkEvent[]): Promise<void> {
  if (!(await isBookmarkSyncEnabled())) return;
  // Capture is registered when the worker loads, before the device is known.
  if (!(await getDevice())) return;
  const overlay = new Map<string, unknown>();
  const siblingCache = new Map<string, chrome.bookmarks.BookmarkTreeNode[]>();
  const mappingCache = new Map<string, string>();
  const nodeCache = new Map<string, chrome.bookmarks.BookmarkTreeNode>();

  // A single event costs fewer round trips with live reads than with the
  // batch prefetch.
  if (events.length !== 1) {
    await prefetchFlushCaches(events, overlay, siblingCache, mappingCache, nodeCache);
  }

  const staged: StagedBookmarkOp[] = [];
  const newMappings: NewMappingCollector = [];
  const deletedLocalIds: string[] = [];
  const removedEvents: Array<Extract<QueuedBookmarkEvent, { kind: "removed" }>> = [];

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
      if (op) {
        staged.push(op);
        if (event.kind === "removed") removedEvents.push(event);
      }
    } catch (e) {
      // One bad event must not drop the rest of the burst.
      console.error(`HelixSync bookmarks capture (${event.kind})`, event.id, e);
    }
  }
  if (staged.length === 0) return;

  // Read before the mappings of the removed nodes are deleted below.
  const massDelete = await detectLocalMassDelete(removedEvents);

  // Mappings are committed before operations, so a crash between the two
  // can't leave operations referencing unknown mappings.
  if (newMappings.length > 0) {
    await putMappingsBatch(dedupeByKey(newMappings));
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
  scheduleLocalSync();
  // The removed nodes are already captured in the event, so the point can be
  // built without holding up the flush.
  if (massDelete) void runMassDelete(massDelete);
}

const enqueueBookmarkEvent = createMicroBatchQueue<QueuedBookmarkEvent>(flushBookmarkEvents);

// --- Backfill -------------------------------------------------------------

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

const BACKFILL_FLUSH_CHUNK = 500;
const BACKFILL_WALK_YIELD_CHUNK = 500;

// A real sleep between committed chunks lowers the sustained CPU duty cycle
// on first login; yields alone only keep the worker responsive.
const BACKFILL_CHUNK_COOLDOWN_MS = 150;

/** Walks the tree top-down and emits a create for every node not in
 * `alreadyMapped`, computing positions in memory from the tree itself. Each
 * new node goes after its nearest preceding sibling, as live capture would
 * place it. Emits in walk order so the caller can commit in streaming
 * chunks. */
async function flattenForBackfill(
  root: chrome.bookmarks.BookmarkTreeNode,
  rootObjectIdByChromiumId: ReadonlyMap<string, string>,
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
    const siblings = children ?? [];
    const existingPositionOf = (node: chrome.bookmarks.BookmarkTreeNode): string | undefined => {
      if (rootObjectIdByChromiumId.has(node.id) || !alreadyMapped.has(node.id)) return undefined;
      return positionsForAlreadyMapped.get(mappingsForAlreadyMapped.get(node.id)!.objectId);
    };
    // The nearest following sibling's existing position bounds each new
    // node from above, so a new node between two existing ones (linked to
    // the account's, or left by an interrupted run) keeps the folder's
    // order.
    const nextExistingPosition: Array<string | null> = new Array(siblings.length).fill(null);
    for (let i = siblings.length - 2; i >= 0; i--) {
      nextExistingPosition[i] = existingPositionOf(siblings[i + 1]) ?? nextExistingPosition[i + 1];
    }
    let runningLo: string | null = null;

    let i = -1;
    for (const child of siblings) {
      i++;
      if (++visited % BACKFILL_WALK_YIELD_CHUNK === 0) await yieldToEventLoop();
      const rootObjectId = rootObjectIdByChromiumId.get(child.id);
      const isAlreadyMapped = !rootObjectId && alreadyMapped.has(child.id);

      let ownObjectId: string;
      if (rootObjectId) {
        ownObjectId = rootObjectId;
      } else if (isAlreadyMapped) {
        ownObjectId = mappingsForAlreadyMapped.get(child.id)!.objectId;
        const existingPosition = positionsForAlreadyMapped.get(ownObjectId);
        if (existingPosition !== undefined) runningLo = existingPosition;
      } else {
        ownObjectId = uuidv7();
        const hi = nextExistingPosition[i] ?? null;
        // Existing siblings already out of order leave no gap to fill.
        const position = keyBetween(runningLo, hi !== null && (runningLo === null || runningLo < hi) ? hi : null);
        runningLo = position;

        await emit(
          { key: mappingKey(MAP_TYPE, child.id), objectType: MAP_TYPE, chromiumLocalId: child.id, objectId: ownObjectId },
          {
            objectType: bookmarkObjectType(child),
            objectId: ownObjectId,
            payload: { title: syncedTitle(child), url: syncedUrl(child) ?? null, parent: parentObjectId, position },
          },
        );
      }

      await processChildren(child.children, ownObjectId);
    }
  }

  await processChildren([root], null);
}

/** One-time import of bookmarks that existed before HelixSync was installed
 * (onCreated only fires going forward). Safe to re-run: nodes mapped before
 * this run started are skipped. That set is snapshotted up front, since a
 * live per-node check could see a mapping this very walk just minted and
 * skip the node without ever emitting its create. */
export async function backfillExisting(): Promise<void> {
  if (!(await isBookmarkSyncEnabled())) return;
  // Live capture is already registered, and a queued event hasn't written
  // its mapping yet; draining first keeps such a node from being minted twice.
  await flushAllMicroBatchQueuesAndWait();
  // Before the tree is read, so stand-in roots it creates are in it.
  const { objectIdByChromiumId: rootObjectIdByChromiumId } = await roots();
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

  // A committed backfill or live create always writes a "move" field state.
  // A mapping without one is a remnant of an interrupted non-atomic write
  // and gets re-captured.
  const alreadyMapped = new Set<string>();
  for (const [chromiumId, mapping] of mappingsForAlreadyMapped) {
    if (moveStates.has(mapping.objectId)) {
      alreadyMapped.add(chromiumId);
    }
  }

  let pendingMappings: BackfillMapping[] = [];
  let pendingNodes: BackfillNode[] = [];

  const backfillCooldown = () => new Promise<void>((r) => setTimeout(r, BACKFILL_CHUNK_COOLDOWN_MS));

  async function flushBackfillChunk(): Promise<void> {
    if (pendingNodes.length === 0) return;
    // Disconnected mid-import: the committed prefix stays valid and the
    // disconnect path wipes the rest.
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
    // Not enqueued here: operations, mappings and field states are committed
    // together in one transaction below.
    const created = await createLocalOperationsBatch(pending, { enqueue: false });

    const fieldStates: Array<Omit<FieldStateRecord, "key">> = [];
    created.forEach(({ operation, deviceId }, idx) => {
      const { objectId, payload } = nodeChunk[idx];
      const fieldValues: Array<[string, unknown]> = [
        ["title", payload.title],
        ["url", payload.url],
        ["move", { parent: payload.parent, position: payload.position }],
        ["liveness", "live"],
      ];
      for (const [field, value] of fieldValues) {
        fieldStates.push({
          objectId,
          field,
          lamportTimestamp: operation.lamportTimestamp,
          deviceId,
          operationId: operation.operationId,
          operationType: "create",
          value,
        });
      }
    });

    await commitBookmarkBackfillBatch({
      mappings: mappingChunk,
      operations: created.map((c) => c.operation),
      fieldStates,
    });
    await yieldToEventLoop();
    await backfillCooldown();
  }

  await flattenForBackfill(root, rootObjectIdByChromiumId, alreadyMapped, mappingsForAlreadyMapped, positionsForAlreadyMapped, async (mapping, node) => {
    pendingMappings.push(mapping);
    pendingNodes.push(node);
    if (pendingNodes.length >= BACKFILL_FLUSH_CHUNK) await flushBackfillChunk();
  });
  await flushBackfillChunk();
}

let captureRegistered = false;

// A cached remote-reorder plan is valid only while nobody but the remote
// applier has changed the tree. Unsuppressed events bump this synchronously.
let bookmarkLayoutGeneration = 0;

export function registerCapture(): void {
  // Called on every startup and settings save; registering twice would
  // duplicate every captured event.
  if (captureRegistered) return;
  captureRegistered = true;

  chrome.bookmarks.onCreated.addListener((id, node) => {
    // A built-in root fires onCreated when it's shown and onRemoved when
    // it's hidden. Re-resolved before the queued events that follow, which
    // may be the root's first child.
    if (isNativeRootId(id)) {
      invalidateBookmarkRoots();
      return;
    }
    if (!bookmarkCaptureEnabled) return;
    if (guard.isSuppressed()) return;
    bookmarkLayoutGeneration++;
    enqueueBookmarkEvent({ kind: "created", id, node });
  });
  chrome.bookmarks.onRemoved.addListener((id, info) => {
    if (isNativeRootId(id)) {
      invalidateBookmarkRoots();
      return;
    }
    if (guard.isSuppressed()) return;
    // Whether or not bookmark sync is on: a stand-in root, like a real one,
    // can't be removed. The event is still queued; it maps to nothing.
    void restoreIfStandInRoot(id, info);
    if (!bookmarkCaptureEnabled) return;
    bookmarkLayoutGeneration++;
    enqueueBookmarkEvent({ kind: "removed", id, removeInfo: info });
  });
  chrome.bookmarks.onChanged.addListener((id, info) => {
    if (!bookmarkCaptureEnabled) return;
    if (guard.isSuppressed()) return;
    enqueueBookmarkEvent({ kind: "changed", id, changeInfo: info });
  });
  chrome.bookmarks.onMoved.addListener((id, info) => {
    if (!bookmarkCaptureEnabled) return;
    if (guard.isSuppressed()) return;
    bookmarkLayoutGeneration++;
    enqueueBookmarkEvent({ kind: "moved", id, moveInfo: info });
  });
}

/** Recreates a stand-in root removed on this device and rebuilds what was
 * in it from local field state. Nothing is deleted on other devices. */
async function restoreIfStandInRoot(chromiumId: string, removeInfo: BookmarkRemoveInfo): Promise<void> {
  try {
    const rootObjectId = await standInRootObjectId(chromiumId);
    if (!rootObjectId) return;

    // removeInfo.node carries the whole removed subtree.
    const removed: Array<{ node: chrome.bookmarks.BookmarkTreeNode; parentChromiumId: string }> = [];
    const collect = (parent: chrome.bookmarks.BookmarkTreeNode) => {
      for (const child of parent.children ?? []) {
        removed.push({ node: child, parentChromiumId: parent.id });
        collect(child);
      }
    };
    collect(removeInfo.node);
    const mappings = await getMappingsByLocalIds(MAP_TYPE, removed.map(({ node }) => node.id));

    // Each node waits on its parent, so recreating the stand-in cascades
    // through retryDeferredParent.
    const createdAt = new Date().toISOString();
    const deferred = [];
    for (const { node, parentChromiumId } of removed) {
      const objectId = mappings.get(node.id)?.objectId;
      const waitingOnParent =
        parentChromiumId === chromiumId ? rootObjectId : mappings.get(parentChromiumId)?.objectId;
      if (objectId && waitingOnParent) {
        deferred.push({ objectId, objectType: bookmarkObjectType(node), waitingOnParent, createdAt });
      }
    }
    await putDeferredMaterializationsBatch(deferred);
    await deleteMappingsBatch(MAP_TYPE, [...mappings.keys()]);

    invalidateBookmarkRoots();
    await roots();
    await retryDeferredParent(rootObjectId);
  } catch (e) {
    console.error("HelixSync: could not restore a removed stand-in bookmark root", chromiumId, e);
  }
}

// --- Remote apply: operation -> browser mutation -------------------------

// On while a newly connected device downloads the account, before its first
// bookmark import. A remote bookmark then links to a matching one this
// browser already has (same folder, title and URL) instead of being created
// next to it, and the import uploads only what didn't match. Two browsers
// that each had the same bookmarks would otherwise both end up with two of
// each.
let linkExistingBookmarks = false;

export function setLinkExistingBookmarks(enabled: boolean): void {
  linkExistingBookmarks = enabled;
}

/** A child of `parentChromiumId` matching `p` that isn't linked to any
 * object yet. */
async function findUnlinkedMatch(parentChromiumId: string, p: BookmarkPayload): Promise<string | undefined> {
  const { standInIds } = await roots();
  const candidates = (await chrome.bookmarks.getChildren(parentChromiumId)).filter(
    (node) => !standInIds.has(node.id) && syncedTitle(node) === p.title && (syncedUrl(node) ?? null) === (p.url ?? null),
  );
  if (candidates.length === 0) return undefined;
  const linked = await getMappingsByLocalIds(
    MAP_TYPE,
    candidates.map((node) => node.id),
  );
  return candidates.find((node) => !linked.has(node.id))?.id;
}

function deferUntilParentMaterializes(objectId: string, objectType: ObjectType, parent: string): Promise<void> {
  return putDeferredMaterialization({
    objectId,
    objectType,
    waitingOnParent: parent,
    createdAt: new Date().toISOString(),
  });
}

/** Roots always exist; any other mapping is checked against the browser. */
async function mappedNodeExists(objectId: string, chromiumId: string): Promise<boolean> {
  if ((await roots()).chromiumIdByObjectId.has(objectId)) return true;
  try {
    const nodes = await chrome.bookmarks.get(chromiumId);
    return Array.isArray(nodes) && nodes.length > 0;
  } catch {
    return false;
  }
}

async function materialize(
  objectId: string,
  objectType: ObjectType,
  p: BookmarkPayload,
  prefetched?: Map<string, string>,
): Promise<void> {
  const chromiumIds =
    prefetched && prefetched.has(objectId) && (!p.parent || prefetched.has(p.parent))
      ? prefetched
      : await chromiumIdsFor(p.parent ? [objectId, p.parent] : [objectId]);

  const mappedChromiumId = chromiumIds.get(objectId);
  if (mappedChromiumId !== undefined) {
    if (await mappedNodeExists(objectId, mappedChromiumId)) {
      await deleteDeferredMaterialization(objectId);
      return;
    }
    // A mapping whose node is gone (a folder deleted on this device left its
    // descendants' mappings behind) must not block re-creating the node.
    await forgetMapping(MAP_TYPE, mappedChromiumId);
    chromiumIds.delete(objectId);
    prefetched?.delete(objectId);
  }

  const parentChromiumId = p.parent ? chromiumIds.get(p.parent) : undefined;
  if (!parentChromiumId && p.parent && isLazyRootObjectId(p.parent)) {
    // A root this device makes a folder for only on demand: wait on it like
    // on any parent, then make it, which applies everything waiting.
    await deferUntilParentMaterializes(objectId, objectType, p.parent);
    await materializeLazyRoot(p.parent);
    return;
  }
  if (!parentChromiumId) {
    // Operations for different objects arrive in any order. This must stay
    // recoverable (docs/protocol.md §8.7), so it's retried once the parent
    // materializes.
    if (p.parent) {
      await deferUntilParentMaterializes(objectId, objectType, p.parent);
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

  if (p.url && !isSyncableUrl(p.url)) {
    await recordConflict({
      objectType,
      objectId,
      description: "bookmark URL uses a disallowed scheme; not created locally",
      createdAt: new Date().toISOString(),
      resolved: false,
    });
    return;
  }

  if (linkExistingBookmarks) {
    const linkedId = await findUnlinkedMatch(parentChromiumId, p);
    if (linkedId) {
      await establishMapping(MAP_TYPE, linkedId, objectId);
      prefetched?.set(objectId, linkedId);
      await deleteDeferredMaterialization(objectId);
      // Where the account has it, so the folder's order matches positions.
      await applyMove(objectId, objectType, { parent: p.parent!, position: p.position });
      await retryDeferredParent(objectId);
      return;
    }
  }

  const created = await guard.run(() =>
    isFirefox() && isSeparatorUrl(p.url)
      ? chrome.bookmarks.create({ parentId: parentChromiumId, type: "separator" } as chrome.bookmarks.CreateDetails)
      : chrome.bookmarks.create({
          parentId: parentChromiumId,
          title: p.title,
          url: p.url ?? undefined,
        }),
  );
  await establishMapping(MAP_TYPE, created.id, objectId);
  prefetched?.set(objectId, created.id);
  await deleteDeferredMaterialization(objectId);
  await retryDeferredParent(objectId);
}

/** Creates the on-demand folder for a lazy root and applies everything
 * waiting on it. */
async function materializeLazyRoot(rootObjectId: string): Promise<void> {
  const { chromiumIdByObjectId } = await ensureStandInRoot(guard, rootObjectId);
  if (chromiumIdByObjectId.has(rootObjectId)) await retryDeferredParent(rootObjectId);
}

/** On Firefox, true when the node is a separator, whose title and URL can't
 * be set. */
async function isLocalSeparator(chromiumId: string): Promise<boolean> {
  if (!isFirefox()) return false;
  try {
    const [node] = await chrome.bookmarks.get(chromiumId);
    return !!node && isSeparatorNode(node);
  } catch {
    return false;
  }
}

// IPC-heavy iterations (each may create a bookmark and recurse), so this
// yields more often than the crypto loops do.
const DEFERRED_RETRY_YIELD_CHUNK = 10;

/** Retries everything deferred on `parentObjectId` once it materializes: a
 * create waiting on its parent, or a move waiting on its destination.
 * Still-blocked retries simply defer again; successful folders recurse via
 * their own materialize call. */
async function retryDeferredParent(parentObjectId: string): Promise<void> {
  const deferred = await getDeferredMaterializationsWaitingOn(parentObjectId);
  if (deferred.length === 0) return;

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

  // Each create goes at the end of its parent, so creating in position order
  // keeps the synced order.
  const positionOfRecord = (objectId: string) =>
    (moveByObjectId.get(objectId)?.value as RecordedMove | undefined)?.position ?? "";
  const ordered = [...deferred].sort((a, b) =>
    byPosition({ position: positionOfRecord(a.objectId) }, { position: positionOfRecord(b.objectId) }),
  );

  let sinceYield = 0;
  for (const record of ordered) {
    if (++sinceYield >= DEFERRED_RETRY_YIELD_CHUNK) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
    const liveness = livenessByObjectId.get(record.objectId);
    if (liveness?.value !== "live") continue;

    const moveState = moveByObjectId.get(record.objectId);
    const move = moveState?.value as RecordedMove | undefined;

    if (chromiumIdByObjectId.has(record.objectId)) {
      // Already materialized: this was a move waiting on its destination.
      if (move?.parent) {
        await applyMove(record.objectId, record.objectType, {
          parent: move.parent,
          position: move.position ?? keyBetween(null, null),
        });
      }
      continue;
    }

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
  if (chromiumId && !(await isLocalSeparator(chromiumId))) {
    await guard.run(() => chrome.bookmarks.update(chromiumId, { title }));
  }
}

async function applyUrl(objectId: string, url: string, prefetched?: ReadonlyMap<string, string>): Promise<void> {
  if (!isSyncableUrl(url)) return;
  const chromiumId = prefetched?.get(objectId) ?? (await chromiumIdFor(objectId));
  if (chromiumId && !(await isLocalSeparator(chromiumId))) {
    await guard.run(() => chrome.bookmarks.update(chromiumId, { url }));
  }
}

async function applyMove(
  objectId: string,
  objectType: ObjectType,
  p: BookmarkMove,
  prefetched?: ReadonlyMap<string, string>,
): Promise<void> {
  const chromiumIds =
    prefetched && prefetched.has(objectId) && prefetched.has(p.parent)
      ? prefetched
      : await chromiumIdsFor([objectId, p.parent]);
  const chromiumId = chromiumIds.get(objectId);
  // Not materialized yet: it will read the current "move" state when it is.
  if (!chromiumId) return;

  const parentChromiumId = chromiumIds.get(p.parent);
  if (!parentChromiumId) {
    await deferUntilParentMaterializes(objectId, objectType, p.parent);
    if (isLazyRootObjectId(p.parent)) await materializeLazyRoot(p.parent);
    return;
  }
  await deleteDeferredMaterialization(objectId);

  // A one-off move reads the live tree; consecutive moves go through
  // applyMovesBatch's cache instead.
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
  withPositions.sort(byPosition);
  const before = withPositions.find((s) => s.position > p.position)?.chromiumId;
  const index = moveIndex(
    siblings.map((s) => s.id),
    chromiumId,
    before,
  );

  await guard.run(() => chrome.bookmarks.move(chromiumId, { parentId: parentChromiumId, index }));
}

/** The chrome.bookmarks.move index that puts `moverId` just before
 * `beforeId` among `liveOrder` (the destination's current children), or
 * last when `beforeId` is undefined. Siblings without a position (stand-in
 * roots, nodes not yet imported) are stepped over rather than counted.
 * Chromium reads the index as if the mover were still in place when it's
 * already in that folder. */
export function moveIndex(liveOrder: readonly string[], moverId: string, beforeId: string | undefined): number {
  const others = liveOrder.filter((id) => id !== moverId);
  const at = beforeId === undefined ? -1 : others.indexOf(beforeId);
  const target = at === -1 ? others.length : at;
  const oldIndex = liveOrder.indexOf(moverId);
  return oldIndex !== -1 && target >= oldIndex ? target + 1 : target;
}

interface RemoteMove extends BookmarkMove {
  objectId: string;
  objectType: ObjectType;
}

interface CachedParentOrder {
  generation: number;
  childChromiumIds: Set<string>;
  // Live child order, kept current like `sorted`; move indexes are counted
  // in it.
  liveOrder: string[];
  objectIdByChromiumId: Map<string, string>;
  positionByObjectId: Map<string, string>;
  // Siblings with known positions, ascending. Movers are removed and
  // re-inserted so later moves binary-search an up-to-date order.
  sorted: Array<{ chromiumId: string; position: string }>;
}

/** Insertion index for `position`, after any equal positions: the same slot
 * as sort + findIndex(first position > target), in O(log N). */
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

/** Applies a run of already-resolved moves. Chrome has no bulk move, so the
 * moves stay sequential, but each destination's child order is loaded once
 * and kept up to date. The cache is dropped as soon as a real local change
 * is observed. */
async function applyMovesBatch(moves: RemoteMove[]): Promise<void> {
  if (moves.length === 0) return;

  const chromiumIds = await chromiumIdsFor([...new Set(moves.flatMap((move) => [move.objectId, move.parent]))]);
  const cacheByParent = new Map<string, CachedParentOrder>();
  // Made after the loop, so creating them can't stale the cached orders.
  const lazyRootsWanted = new Set<string>();
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
    // This batch's incoming positions take precedence over stored ones.
    const sorted: Array<{ chromiumId: string; position: string }> = [];
    for (const siblingChromiumId of childChromiumIds) {
      const siblingObjectId = objectIdByChromiumId.get(siblingChromiumId);
      if (!siblingObjectId) continue;
      const position =
        incomingPositionByObjectId.get(siblingObjectId) ?? positionByObjectId.get(siblingObjectId);
      if (position) sorted.push({ chromiumId: siblingChromiumId, position });
    }
    sorted.sort(byPosition);
    const order: CachedParentOrder = {
      generation: bookmarkLayoutGeneration,
      childChromiumIds: new Set(childChromiumIds),
      liveOrder: childChromiumIds,
      objectIdByChromiumId,
      positionByObjectId,
      sorted,
    };
    cacheByParent.set(parentChromiumId, order);
    return order;
  };

  for (const move of moves) {
    const chromiumId = chromiumIds.get(move.objectId);
    if (!chromiumId) continue;
    const parentChromiumId = chromiumIds.get(move.parent);
    if (!parentChromiumId) {
      await deferUntilParentMaterializes(move.objectId, move.objectType, move.parent);
      if (isLazyRootObjectId(move.parent)) lazyRootsWanted.add(move.parent);
      continue;
    }
    await deleteDeferredMaterialization(move.objectId);

    const order = await getParentOrder(parentChromiumId);
    const cur = order.sorted.findIndex((s) => s.chromiumId === chromiumId);
    if (cur !== -1) order.sorted.splice(cur, 1);
    const index = sortedInsertIndex(order.sorted, move.position);
    const before = order.sorted[index]?.chromiumId;
    const liveIndex = moveIndex(order.liveOrder, chromiumId, before);

    await guard.run(() => chrome.bookmarks.move(chromiumId, { parentId: parentChromiumId, index: liveIndex }));
    // The mover has left whichever cached parent it was in before.
    for (const cached of cacheByParent.values()) {
      cached.childChromiumIds.delete(chromiumId);
      const at = cached.sorted.findIndex((s) => s.chromiumId === chromiumId);
      if (at !== -1) cached.sorted.splice(at, 1);
      const atLive = cached.liveOrder.indexOf(chromiumId);
      if (atLive !== -1) cached.liveOrder.splice(atLive, 1);
    }
    order.childChromiumIds.add(chromiumId);
    const beforeAt = before === undefined ? -1 : order.liveOrder.indexOf(before);
    order.liveOrder.splice(beforeAt === -1 ? order.liveOrder.length : beforeAt, 0, chromiumId);
    order.objectIdByChromiumId.set(chromiumId, move.objectId);
    order.positionByObjectId.set(move.objectId, move.position);
    order.sorted.splice(index, 0, { chromiumId, position: move.position });
  }
  for (const rootObjectId of lazyRootsWanted) await materializeLazyRoot(rootObjectId);
}

async function applyDelete(objectId: string, prefetched?: Map<string, string>): Promise<void> {
  // Anything still deferred for this object has nothing left to wait for.
  await deleteDeferredMaterialization(objectId);

  const chromiumId = prefetched?.get(objectId) ?? (await chromiumIdFor(objectId));
  if (!chromiumId) return;
  // The folder's descendants lose their nodes with it and stay live on the
  // account (only the folder gets a delete), so their mappings go too.
  // Read before the removal.
  let descendants: string[] = [];
  try {
    const [subtree] = await chrome.bookmarks.getSubTree(chromiumId);
    if (subtree) descendants = descendantIds(subtree);
  } catch {
    // Already removed locally, or a leaf with nothing to forget.
  }
  try {
    await guard.run(() => chrome.bookmarks.removeTree(chromiumId));
  } catch {
    // Already removed locally.
  }
  await forgetMapping(MAP_TYPE, chromiumId);
  prefetched?.delete(objectId);
  if (descendants.length > 0) {
    if (prefetched) {
      const forgotten = await getMappingsByLocalIds(MAP_TYPE, descendants);
      for (const mapping of forgotten.values()) prefetched.delete(mapping.objectId);
    }
    await deleteMappingsBatch(MAP_TYPE, descendants);
  }
}

type RemoteOpKind = "create" | "update" | "move" | "delete" | "unknown";

/** The field slots a remote operation resolves, at fixed positions:
 * create [liveness, title, url, move]; update [liveness, title?, url?]
 * (null when absent); move [move, liveness]; delete [liveness]. */
function remoteFieldResolutions(
  op: OperationOut,
  payload: unknown,
): { kind: RemoteOpKind; fields: Array<FieldResolution | null> } {
  const key = opKey(op.lamportTimestamp, op.deviceId, op.operationId, op.operationType);
  switch (op.operationType) {
    case "create":
    case "restore": {
      const p = payload as BookmarkPayload;
      return {
        kind: "create",
        fields: [
          { field: "liveness", incoming: { ...key, value: "live" } },
          { field: "title", incoming: { ...key, value: p.title } },
          { field: "url", incoming: { ...key, value: p.url } },
          { field: "move", incoming: { ...key, value: { parent: p.parent, position: p.position } } },
        ],
      };
    }
    case "update": {
      const p = payload as Partial<BookmarkPayload>;
      return {
        kind: "update",
        fields: [
          { field: "liveness", incoming: { ...key, value: "live" } },
          p.title !== undefined ? { field: "title", incoming: { ...key, value: p.title } } : null,
          typeof p.url === "string" ? { field: "url", incoming: { ...key, value: p.url } } : null,
        ],
      };
    }
    case "move":
      return {
        kind: "move",
        fields: [
          { field: "move", incoming: { ...key, value: payload as BookmarkMove } },
          { field: "liveness", incoming: { ...key, value: "live" } },
        ],
      };
    case "delete":
      return { kind: "delete", fields: [{ field: "liveness", incoming: { ...key, value: "deleted" } }] };
    default:
      return { kind: "unknown", fields: [] };
  }
}

/** Single-operation path; in practice only reached by snapshot tombstones,
 * which bypass batch appliers. */
async function applyRemote(op: OperationOut, payload: unknown): Promise<void> {
  const { kind, fields } = remoteFieldResolutions(op, payload);
  if (kind === "unknown") return;
  // No chrome.* call happens between these fields, so they share one
  // transaction.
  const resolved = await resolveFields(
    op.objectId,
    fields.filter((f): f is FieldResolution => f !== null),
  );
  let next = 0;
  const res = fields.map((f) => (f ? resolved[next++] : undefined));

  switch (kind) {
    case "create":
      if (res[0]!.applied) {
        await materialize(op.objectId, op.objectType, payload as BookmarkPayload);
        // A restored node is created at the end of its folder; put it where
        // the point had it.
        if (op.operationType === "restore") await placeRestored(op.objectId, op.objectType, payload as BookmarkPayload);
      }
      return;
    case "update": {
      const p = payload as Partial<BookmarkPayload>;
      if (p.title !== undefined && res[1]!.applied) await applyTitle(op.objectId, p.title);
      if (typeof p.url === "string" && res[2]!.applied) await applyUrl(op.objectId, p.url);
      return;
    }
    case "move":
      if (res[0]!.applied && res[1]!.value === "live") {
        await applyMove(op.objectId, op.objectType, payload as BookmarkMove);
      }
      return;
    case "delete":
      if (res[0]!.applied) await applyDelete(op.objectId);
      return;
  }
}

async function placeRestored(objectId: string, objectType: ObjectType, p: BookmarkPayload): Promise<void> {
  if (p.parent) await applyMove(objectId, objectType, { parent: p.parent, position: p.position });
}

const REMOTE_BATCH_YIELD_CHUNK = 10;

// Title/url updates never change the sibling set or the mapping table, so
// they can run concurrently. Creates and deletes stay strictly sequential,
// and moves are coalesced by applyMovesBatch.
const REMOTE_TITLE_URL_CONCURRENCY = 10;

// Ops whose field resolutions share one transaction. Keeps the
// resolve-then-mutate crash window and write-lock hold bounded.
const REMOTE_RESOLVE_SLICE = 50;

/** Resolves every slot of a slice in one transaction, in wire order, and
 * returns each op's results at the positions `remoteFieldResolutions`
 * defines. */
async function resolveRemoteSlice(
  slice: Array<{ op: OperationOut; payload: unknown }>,
): Promise<Array<{ kind: RemoteOpKind; res: Array<ResolveResult | undefined> }>> {
  const entries: BatchFieldResolution[] = [];
  const plans = slice.map(({ op, payload }) => {
    const { kind, fields } = remoteFieldResolutions(op, payload);
    const positions = fields.map((f) => (f ? entries.push({ objectId: op.objectId, ...f }) - 1 : -1));
    return { kind, positions };
  });
  const results = await resolveFieldsBatch(entries);
  return plans.map(({ kind, positions }) => ({
    kind,
    res: positions.map((p) => (p >= 0 ? results[p] : undefined)),
  }));
}

/** Batch path used by the sync engine. Fields are resolved in wire order;
 * consecutive winning moves are coalesced, and creates/deletes flush pending
 * moves first because they change the live sibling set. Mapping lookups are
 * prefetched once and kept current as creates and deletes land. */
async function applyRemoteBatch(items: Array<{ op: OperationOut; payload: unknown }>): Promise<void> {
  const involved = new Set<string>();
  for (const { op, payload } of items) {
    involved.add(op.objectId);
    if (op.operationType === "create" || op.operationType === "restore") {
      const parent = (payload as BookmarkPayload).parent;
      if (parent) involved.add(parent);
    } else if (op.operationType === "move") {
      involved.add((payload as BookmarkMove).parent);
    }
  }
  const prefetched = await chromiumIdsFor([...involved]);

  // Before anything is applied, so the point still holds what is about to go.
  if (massDeleteHandler) {
    const count = await countRemoteDeletes(items, prefetched);
    if (count >= MASS_DELETE_THRESHOLD) await runMassDelete({ origin: "remote", count });
  }

  let pendingMoves: RemoteMove[] = [];
  // Restored nodes are created at the end of their folder. They are placed
  // together once the batch is done, so one folder's cache serves them all
  // instead of being rebuilt after every create.
  const restorePlacements: RemoteMove[] = [];
  const flushMoves = async () => {
    if (pendingMoves.length === 0) return;
    const moves = pendingMoves;
    pendingMoves = [];
    await applyMovesBatch(moves);
  };

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

  for (let start = 0; start < items.length; start += REMOTE_RESOLVE_SLICE) {
    const slice = items.slice(start, start + REMOTE_RESOLVE_SLICE);
    const resolved = await resolveRemoteSlice(slice);

    for (let k = 0; k < slice.length; k++) {
      const { op, payload } = slice[k];
      const { kind, res } = resolved[k];
      switch (kind) {
        case "create": {
          await flushMoves();
          await flushTitleUrl();
          if (res[0]!.applied) {
            await materialize(op.objectId, op.objectType, payload as BookmarkPayload, prefetched);
            // As in applyRemote: restored nodes go where the point had them.
            const restored = payload as BookmarkPayload;
            if (op.operationType === "restore" && restored.parent) {
              restorePlacements.push({
                objectId: op.objectId,
                objectType: op.objectType,
                parent: restored.parent,
                position: restored.position,
              });
            }
          }
          break;
        }
        case "update": {
          const p = payload as Partial<BookmarkPayload>;
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
          if (res[0]!.applied && res[1]!.value === "live") {
            pendingMoves.push({ objectId: op.objectId, objectType: op.objectType, ...(payload as BookmarkMove) });
          }
          break;
        }
        case "delete": {
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
    // Title/url winners are applied before the next slice resolves, bounding
    // the crash window to one slice. A trailing move run carries over so a
    // same-parent run keeps its shared child-order cache.
    await flushTitleUrl();
  }
  await flushTitleUrl();
  await flushMoves();
  await applyMovesBatch(restorePlacements);
}

// --- Restore points: reading and applying the tree -------------------------

/** Removals (a folder counted with everything in it) from one capture flush,
 * or in one remote batch, that make a `mass_delete` restore point. */
export const MASS_DELETE_THRESHOLD = 50;

/** One bookmark or folder as the restore-point code needs it. */
export interface LiveBookmarkNode {
  chromiumId: string;
  objectId: string;
  kind: "b" | "f";
  title: string;
  url?: string;
  /** A root's objectId for top-level nodes. */
  parentObjectId: string;
  /** From the node's recorded `move` field, if it has one. */
  position?: string;
  /** Managed by browser policy, so never restored or removed. */
  unmodifiable: boolean;
}

export interface LiveBookmarkTree {
  /** Parents before children; siblings in browser order. */
  nodes: LiveBookmarkNode[];
  /** Nodes left out for having no mapping (capture not flushed, backfill
   * unfinished), counted with everything under them. */
  unmapped: number;
}

export type MassDeleteEvent =
  | { origin: "local"; count: number; removed: LiveBookmarkNode[] }
  | { origin: "remote"; count: number };

let massDeleteHandler: ((event: MassDeleteEvent) => Promise<void> | void) | undefined;

/** Called when a flush or remote batch removes `MASS_DELETE_THRESHOLD` or more
 * bookmarks. A remote event is delivered before the batch is applied. */
export function setMassDeleteHandler(handler: ((event: MassDeleteEvent) => Promise<void> | void) | undefined): void {
  massDeleteHandler = handler;
}

async function runMassDelete(event: MassDeleteEvent): Promise<void> {
  if (!massDeleteHandler) return;
  try {
    await massDeleteHandler(event);
  } catch (e) {
    console.error("HelixSync: mass-delete restore point failed", e);
  }
}

function countSubtree(node: chrome.bookmarks.BookmarkTreeNode): number {
  return 1 + descendantIds(node).length;
}

async function detectLocalMassDelete(
  removedEvents: Array<Extract<QueuedBookmarkEvent, { kind: "removed" }>>,
): Promise<Extract<MassDeleteEvent, { origin: "local" }> | undefined> {
  if (!massDeleteHandler || removedEvents.length === 0) return undefined;
  let count = 0;
  for (const event of removedEvents) count += countSubtree(event.removeInfo.node);
  if (count < MASS_DELETE_THRESHOLD) return undefined;

  // Mappings are still in the database here; the caller deletes them next.
  const localIds = removedEvents.flatMap((e) => [e.id, ...descendantIds(e.removeInfo.node)]);
  const mappings = await getMappingsByLocalIds(MAP_TYPE, localIds);
  const moveStates = await getFieldStatesForObjects(
    [...mappings.values()].map((m) => m.objectId),
    "move",
  );
  const rootIds = (await roots()).objectIdByChromiumId;
  const parentMappings = await getMappingsByLocalIds(
    MAP_TYPE,
    removedEvents.map((e) => e.removeInfo.parentId).filter((id) => !rootIds.has(id)),
  );

  const removed: LiveBookmarkNode[] = [];
  const visit = (node: chrome.bookmarks.BookmarkTreeNode, parentObjectId: string | undefined) => {
    const objectId = mappings.get(node.id)?.objectId;
    if (!objectId || !parentObjectId) return;
    removed.push({
      chromiumId: node.id,
      objectId,
      kind: syncedUrl(node) ? "b" : "f",
      title: syncedTitle(node),
      ...(syncedUrl(node) ? { url: syncedUrl(node) } : {}),
      parentObjectId,
      position: (moveStates.get(objectId)?.value as { position?: string } | undefined)?.position,
      unmodifiable: false,
    });
    for (const child of node.children ?? []) visit(child, objectId);
  };
  for (const event of removedEvents) {
    const parentChromiumId = event.removeInfo.parentId;
    visit(event.removeInfo.node, rootIds.get(parentChromiumId) ?? parentMappings.get(parentChromiumId)?.objectId);
  }
  return { origin: "local", count, removed };
}

async function countRemoteDeletes(
  items: Array<{ op: OperationOut; payload: unknown }>,
  prefetched: ReadonlyMap<string, string>,
): Promise<number> {
  let count = 0;
  for (const { op } of items) {
    if (op.operationType !== "delete") continue;
    if (op.objectType !== "bookmarkFolder") {
      count++;
    } else {
      const chromiumId = prefetched.get(op.objectId);
      if (!chromiumId) continue;
      try {
        const [subtree] = await chrome.bookmarks.getSubTree(chromiumId);
        count += subtree ? countSubtree(subtree) : 1;
      } catch {
        // Already gone.
      }
    }
    if (count >= MASS_DELETE_THRESHOLD) break;
  }
  return count;
}

const LIVE_READ_YIELD_CHUNK = 2000;

/** The browser's bookmark tree with each node's objectId and recorded
 * position, for building a restore point or planning a restore. Capture
 * queues are drained first so a just-made change is included. */
export async function readLiveBookmarks(): Promise<LiveBookmarkTree> {
  await flushAllMicroBatchQueuesAndWait();
  const { objectIdByChromiumId: rootObjectIds } = await roots();
  const [tree] = await chrome.bookmarks.getTree();

  // Preorder walk. A node's parent always precedes it in `walk`.
  const walk: Array<{ node: chrome.bookmarks.BookmarkTreeNode; parentChromiumId: string }> = [];
  const stack: Array<{ node: chrome.bookmarks.BookmarkTreeNode; parentChromiumId: string }> = [];
  for (let i = (tree?.children?.length ?? 0) - 1; i >= 0; i--) {
    stack.push({ node: tree.children![i], parentChromiumId: tree.id });
  }
  let visited = 0;
  while (stack.length > 0) {
    const entry = stack.pop()!;
    walk.push(entry);
    const children = entry.node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], parentChromiumId: entry.node.id });
    }
    if (++visited % LIVE_READ_YIELD_CHUNK === 0) await yieldToEventLoop();
  }

  const nonRootIds = walk.map((w) => w.node.id).filter((id) => !rootObjectIds.has(id));
  const mappings = new Map<string, ObjectMappingRecord>();
  for (const batch of chunk(nonRootIds, 5000)) {
    for (const [id, record] of await getMappingsByLocalIds(MAP_TYPE, batch)) mappings.set(id, record);
    await yieldToEventLoop();
  }
  const moveStates = new Map<string, FieldStateRecord>();
  const objectIds = [...mappings.values()].map((m) => m.objectId);
  for (const batch of chunk(objectIds, 5000)) {
    for (const [id, state] of await getFieldStatesForObjects(batch, "move")) moveStates.set(id, state);
    await yieldToEventLoop();
  }

  const nodes: LiveBookmarkNode[] = [];
  const objectIdOf = new Map<string, string>(); // chromium id -> objectId, for kept nodes
  let unmapped = 0;
  for (const { node, parentChromiumId } of walk) {
    const rootObjectId = rootObjectIds.get(node.id);
    if (rootObjectId) {
      objectIdOf.set(node.id, rootObjectId);
      continue;
    }
    const parentObjectId = objectIdOf.get(parentChromiumId);
    // Under a root of the tree itself ("0" holds the roots), or under a
    // skipped node.
    if (!parentObjectId) {
      unmapped++;
      continue;
    }
    const objectId = mappings.get(node.id)?.objectId;
    if (!objectId) {
      unmapped++;
      continue;
    }
    objectIdOf.set(node.id, objectId);
    nodes.push({
      chromiumId: node.id,
      objectId,
      kind: syncedUrl(node) ? "b" : "f",
      title: syncedTitle(node),
      ...(syncedUrl(node) ? { url: syncedUrl(node) } : {}),
      parentObjectId,
      position: (moveStates.get(objectId)?.value as { position?: string } | undefined)?.position,
      unmodifiable: (node as { unmodifiable?: string }).unmodifiable === "managed",
    });
  }
  return { nodes, unmapped };
}

/** Removes mappings whose Chromium node no longer exists. A folder deleted on
 * a device that predates the descendant-mapping fix left such mappings, and
 * they stop `restore` from re-creating the node. */
export async function sweepStaleBookmarkMappings(): Promise<number> {
  await flushAllMicroBatchQueuesAndWait();
  // Mappings first, tree second: a node created in between is in the tree
  // but not in `mapped`, whereas the other order could drop a fresh mapping.
  const mapped = await getMappedChromiumIdsByType(MAP_TYPE);
  const [tree] = await chrome.bookmarks.getTree();
  const present = new Set<string>();
  const stack = tree ? [tree] : [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    present.add(node.id);
    if (node.children) stack.push(...node.children);
  }
  const stale = [...mapped].filter((id) => !present.has(id));
  for (const batch of chunk(stale, 5000)) {
    await deleteMappingsBatch(MAP_TYPE, batch);
    await yieldToEventLoop();
  }
  return stale.length;
}

const STALE_SWEEP_DONE_KEY = "bookmarkMappingSweepDone";

/** Runs the sweep once per browser profile. */
export async function sweepStaleBookmarkMappingsOnce(): Promise<void> {
  const stored = await chrome.storage.local.get(STALE_SWEEP_DONE_KEY);
  if (stored[STALE_SWEEP_DONE_KEY] === true) return;
  await sweepStaleBookmarkMappings();
  await chrome.storage.local.set({ [STALE_SWEEP_DONE_KEY]: true });
}

/** Applies operations this device just created (a restore's), through the
 * code that applies other devices' operations: field state is recorded, a
 * deferred parent waits, URLs are scheme-checked, moves are batched. The
 * browser changes happen under the suppression guard, so nothing is
 * captured a second time. */
export async function applyRestoreOperations(
  created: CreatedOperation[],
  payloads: unknown[],
): Promise<void> {
  const createdAt = new Date().toISOString();
  const items = created.map(({ operation, deviceId }, i) => ({
    op: { ...operation, deviceId, serverCursor: 0, createdAt } as OperationOut,
    payload: payloads[i],
  }));
  await applyRemoteBatch(items);
}

registerApplier("bookmark", applyRemote);
registerApplier("bookmarkFolder", applyRemote);
registerBatchApplier("bookmark", applyRemoteBatch);
registerBatchApplier("bookmarkFolder", applyRemoteBatch);
