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
  putDeferredMaterialization,
  recordConflict,
} from "../storage/db";
import {
  establishMapping,
  forgetMapping,
  getOrCreateObjectId,
  lookupChromiumLocalId,
  lookupObjectId,
} from "../sync/mapping";
import { recordLocalFieldState, resolveField, resolveFields, type FieldResolution } from "../sync/conflict";
import { createLocalOperation, registerApplier } from "../sync/engine";
import { createSuppressionGuard } from "../sync/suppress";
import { keyBetween } from "../util/fractional-index";
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

async function handleCreated(id: string, node: chrome.bookmarks.BookmarkTreeNode): Promise<void> {
  if (guard.isSuppressed()) return; // our own materialize() call, not a real local change
  const objectId = await getOrCreateObjectId(MAP_TYPE, id);
  const objectType: ObjectType = node.url ? "bookmark" : "bookmarkFolder";
  const parentObjectId = node.parentId ? await objectIdFor(node.parentId) : null;
  const position = node.parentId
    ? await computePosition(node.parentId, node.index ?? 0)
    : keyBetween(null, null);

  const payload: BookmarkPayload = {
    title: node.title,
    url: node.url ?? null,
    parent: parentObjectId,
    position,
  };

  const { operation, deviceId } = await createLocalOperation(objectType, objectId, "create", payload);
  const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, "create");
  await recordLocalFieldState(objectId, "title", key, payload.title);
  await recordLocalFieldState(objectId, "url", key, payload.url);
  await recordLocalFieldState(objectId, "move", key, { parent: payload.parent, position: payload.position });
  await recordLocalFieldState(objectId, "liveness", key, "live");
}

async function handleRemoved(
  id: string,
  removeInfo: chrome.bookmarks.BookmarkRemoveInfo,
): Promise<void> {
  if (guard.isSuppressed()) return; // our own applyDelete() call; forgetMapping already runs there
  const objectId = await lookupObjectId(MAP_TYPE, id);
  if (!objectId) return;
  const objectType: ObjectType = removeInfo.node.url ? "bookmark" : "bookmarkFolder";

  const { operation, deviceId } = await createLocalOperation(objectType, objectId, "delete", {});
  const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, "delete");
  await recordLocalFieldState(objectId, "liveness", key, "deleted");
  await forgetMapping(MAP_TYPE, id);
}

async function handleChanged(
  id: string,
  changeInfo: chrome.bookmarks.BookmarkChangeInfo,
): Promise<void> {
  if (guard.isSuppressed()) return; // our own applyTitle()/applyUrl() call
  const objectId = await lookupObjectId(MAP_TYPE, id);
  if (!objectId) return;
  const [node] = await chrome.bookmarks.get(id);
  const objectType: ObjectType = node.url ? "bookmark" : "bookmarkFolder";

  const payload: Partial<BookmarkPayload> = {};
  if (changeInfo.title !== undefined) payload.title = changeInfo.title;
  if (changeInfo.url !== undefined) payload.url = changeInfo.url;
  if (Object.keys(payload).length === 0) return;

  // Defense in depth alongside the guard above: if this exactly matches
  // what's already recorded (e.g. a stray event surviving past the
  // guard's synchronous window), skip rather than re-emitting an
  // identical operation.
  const [titleState, urlState] = await Promise.all([
    payload.title !== undefined ? getFieldState(objectId, "title") : undefined,
    payload.url !== undefined ? getFieldState(objectId, "url") : undefined,
  ]);
  if (
    (payload.title === undefined || titleState?.value === payload.title) &&
    (payload.url === undefined || urlState?.value === payload.url)
  ) {
    return;
  }

  const { operation, deviceId } = await createLocalOperation(objectType, objectId, "update", payload);
  const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, "update");
  if (payload.title !== undefined) await recordLocalFieldState(objectId, "title", key, payload.title);
  if (payload.url !== undefined) await recordLocalFieldState(objectId, "url", key, payload.url);
}

async function handleMoved(id: string, moveInfo: chrome.bookmarks.BookmarkMoveInfo): Promise<void> {
  if (guard.isSuppressed()) return; // our own applyMove() call
  const objectId = await lookupObjectId(MAP_TYPE, id);
  if (!objectId) return;
  const [node] = await chrome.bookmarks.get(id);
  const objectType: ObjectType = node.url ? "bookmark" : "bookmarkFolder";

  const parentObjectId = await objectIdFor(moveInfo.parentId);
  const position = await computePosition(moveInfo.parentId, moveInfo.index);
  const payload = { parent: parentObjectId, position };

  // Defense in depth alongside the guard above (see handleChanged).
  const moveState = await getFieldState(objectId, "move");
  const current = moveState?.value as { parent?: string | null; position?: string } | undefined;
  if (current?.parent === payload.parent && current?.position === payload.position) return;

  const { operation, deviceId } = await createLocalOperation(objectType, objectId, "move", payload);
  const key = opKey(operation.lamportTimestamp, deviceId, operation.operationId, "move");
  await recordLocalFieldState(objectId, "move", key, payload);
}

async function walkAndCapture(node: chrome.bookmarks.BookmarkTreeNode, alreadyMapped: ReadonlySet<string>): Promise<void> {
  if (!(node.id in ROOT_OBJECT_IDS) && !alreadyMapped.has(node.id)) {
    await handleCreated(node.id, node);
  }
  for (const child of node.children ?? []) {
    await walkAndCapture(child, alreadyMapped);
  }
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
 * The "already mapped" set is snapshotted once, up front, rather than
 * checked live per node during the walk: `handleCreated` -> `computePosition`
 * looks up each sibling's position via `objectIdFor`, which mints (and
 * persists) a mapping for any not-yet-visited sibling as a side effect.
 * A live per-node lookup would see that side-effect mapping once the walk
 * reached the sibling and skip it — losing it from sync entirely, since no
 * create operation was ever emitted for it. Snapshotting before any
 * `handleCreated` call runs means a sibling mapped only as that side
 * effect is *not* in the snapshot, so the walk still calls `handleCreated`
 * for it when it gets there (harmlessly reusing the already-minted
 * objectId via `getOrCreateObjectId`, keeping it stable) rather than
 * silently dropping it.
 */
export async function backfillExisting(): Promise<void> {
  const [root] = await chrome.bookmarks.getTree();
  const alreadyMapped = await getMappedChromiumIdsByType(MAP_TYPE);
  await walkAndCapture(root, alreadyMapped);
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

  chrome.bookmarks.onCreated.addListener((id, node) => {
    handleCreated(id, node).catch((e) => console.error("HelixSync bookmarks onCreated", e));
  });
  chrome.bookmarks.onRemoved.addListener((id, info) => {
    handleRemoved(id, info).catch((e) => console.error("HelixSync bookmarks onRemoved", e));
  });
  chrome.bookmarks.onChanged.addListener((id, info) => {
    handleChanged(id, info).catch((e) => console.error("HelixSync bookmarks onChanged", e));
  });
  chrome.bookmarks.onMoved.addListener((id, info) => {
    handleMoved(id, info).catch((e) => console.error("HelixSync bookmarks onMoved", e));
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
