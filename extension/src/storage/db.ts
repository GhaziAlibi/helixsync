import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { HistoryVisitPayload, LocalOperation, ObjectType } from "../sync/types";
import {
  selectFieldStateGcCandidates,
  selectPendingTabRestores,
  selectRecentHistoryVisits,
  type PendingTabRestore,
} from "./selectors";

export type PendingState = "LOCAL_QUEUED" | "UPLOAD_IN_FLIGHT";

export interface PendingOperationRecord {
  operation: LocalOperation;
  state: PendingState;
  createdAt: string;
  attempts: number;
}

export interface DeviceRecord {
  id: "self";
  serverUrl: string;
  deviceId: string;
  userId: string;
  email: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  // The user's encryption root key (base64), derived from the password at
  // connect time via crypto/index.ts::deriveRekFromPassword — see
  // docs/encryption.md §2. Always present once a device is connected.
  encryptionRootKey: string;
  encryptionRootKeyVersion: number;
  // Set once the one-time post-registration import of bookmarks/history
  // that already existed before HelixSync was installed has completed, so
  // it runs exactly once per device registration rather than on every
  // service worker restart.
  initialImportCompletedAt?: string;
}

export interface SyncStateRecord {
  id: "self";
  cursor: number;
  lamportClock: number;
  deviceSequence: number;
  lastSyncAt?: string;
  // Last time the daily storage-maintenance pass (background/index.ts's
  // `runMaintenanceIfDue`) ran — checked so pruning only actually happens
  // once a day rather than on every sync cycle.
  lastMaintenanceAt?: string;
}

export interface ObjectMappingRecord {
  key: string; // `${objectType}:${chromiumLocalId}`
  objectType: ObjectType;
  chromiumLocalId: string;
  objectId: string;
}

export interface ConflictRecord {
  id?: number;
  objectType: ObjectType;
  objectId: string;
  description: string;
  createdAt: string;
  resolved: boolean;
}

/** Tracks a bookmark/bookmarkFolder that resolved its field state (title/
 * url/move/liveness — see field_state above) but couldn't yet be reflected
 * into the real Chromium bookmark tree, because whatever local Chromium
 * node it depends on (its parent folder for a create/restore, or a move's
 * destination folder) doesn't have a local mapping yet — operations for
 * different objects can arrive in any order relative to each other
 * (docs/protocol.md §8.7's conflict invariant: never silently drop this).
 * Indexed by `waitingOnParent` so that whenever some *other* object
 * finishes materializing, every record waiting on it can be retried in
 * one lookup — see bookmarks/index.ts::retryDeferredParent. */
export interface DeferredMaterializationRecord {
  objectId: string; // key
  objectType: ObjectType;
  waitingOnParent: string;
  createdAt: string;
}

/** A materialized view of a remote tab/window/tabGroup (docs/protocol.md
 * §8.4): tracked for display ("tabs from other devices") independent of
 * whether it was ever actually materialized as a real local browser tab —
 * see the "Sync tabs" vs "Restore remote tabs" distinction in settings. */
export interface RemoteObjectRecord {
  objectId: string;
  objectType: ObjectType;
  originDeviceId: string;
  payload: unknown;
  deleted: boolean;
  updatedAt: string;
}

/** Per-(object, field) provenance: which operation last "won" this field,
 * per docs/protocol.md §8.1's universal ordering. This is what lets the
 * client apply the same deterministic merge rules regardless of the order
 * operations actually arrive in (server_cursor order is delivery order,
 * not causal order — see docs/protocol.md §4.3). */
export interface FieldStateRecord {
  key: string; // `${objectId}:${field}`
  objectId: string;
  field: string;
  lamportTimestamp: number;
  deviceId: string;
  operationId: string;
  operationType: string;
  value: unknown;
  // Wall-clock time (Date.now()) this record was last written. This is
  // NEVER read by any LWW arbitration logic (compareOrderingKey/
  // resolveFieldInTx in sync/conflict.ts stay purely Lamport-ordered, per
  // docs/protocol.md §8.1) — it exists solely so `gcFieldStates` below can
  // tell how long a "liveness: deleted" record has stood without needing
  // to (wrongly) infer age from lamportTimestamp or from operationId/
  // objectId, whose UUIDv7 time bits are explicitly documented (see
  // util/uuid.ts) as unsafe for anything conflict-resolution-adjacent.
  // Optional because records written before this field existed have none
  // — `gcFieldStates` treats that as "unknown age" and leaves them alone
  // rather than guessing.
  recordedAt?: number;
}

export interface HelixSyncDB extends DBSchema {
  device: {
    key: "self";
    value: DeviceRecord;
  };
  sync_state: {
    key: "self";
    value: SyncStateRecord;
  };
  pending_operations: {
    key: string; // operationId
    value: PendingOperationRecord;
    indexes: { "by-state": PendingState; "by-sequence": number };
  };
  applied_operations: {
    key: string; // operationId
    value: { operationId: string; appliedAt: string };
    indexes: { "by-applied-at": string };
  };
  object_mappings: {
    key: string;
    value: ObjectMappingRecord;
    indexes: { "by-object-id": string; "by-type": ObjectType };
  };
  conflicts: {
    key: number;
    value: ConflictRecord;
  };
  field_state: {
    key: string;
    value: FieldStateRecord;
    indexes: { "by-object-id": string };
  };
  remote_objects: {
    key: string; // objectId
    value: RemoteObjectRecord;
    indexes: { "by-type": ObjectType; "by-type-updated": [ObjectType, string] };
  };
  deferred_materializations: {
    key: string; // objectId
    value: DeferredMaterializationRecord;
    indexes: { "by-waiting-on-parent": string };
  };
}

let dbPromise: Promise<IDBPDatabase<HelixSyncDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<HelixSyncDB>> {
  if (!dbPromise) {
    dbPromise = openDB<HelixSyncDB>("helixsync", 4, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          db.createObjectStore("device", { keyPath: "id" });
          db.createObjectStore("sync_state", { keyPath: "id" });

          const pending = db.createObjectStore("pending_operations", {
            keyPath: "operation.operationId",
          });
          pending.createIndex("by-state", "state");

          db.createObjectStore("applied_operations", { keyPath: "operationId" });

          const mappings = db.createObjectStore("object_mappings", { keyPath: "key" });
          mappings.createIndex("by-object-id", "objectId");

          db.createObjectStore("conflicts", { keyPath: "id", autoIncrement: true });

          const fieldState = db.createObjectStore("field_state", { keyPath: "key" });
          fieldState.createIndex("by-object-id", "objectId");

          const remoteObjects = db.createObjectStore("remote_objects", { keyPath: "objectId" });
          remoteObjects.createIndex("by-type", "objectType");
        }

        if (oldVersion < 2) {
          // `getPendingOperations` previously loaded the entire store via
          // `getAll()` and sorted in memory to get ascending device-sequence
          // order — fine at queue sizes in the tens, but with backfill able
          // to enqueue tens of thousands of operations at once, that became
          // a full-table scan + sort on every batch of every sync cycle.
          // This index lets it page in sequence order via a cursor instead.
          transaction.objectStore("pending_operations").createIndex("by-sequence", "operation.deviceSequence");
        }

        if (oldVersion < 3) {
          // `getPendingTabRestores` previously loaded the *entire*
          // object_mappings store (every bookmark/tab/window/group mapping
          // ever created) just to build a Set of materialized objectIds —
          // this index lets it fetch only the "tab" slice.
          transaction.objectStore("object_mappings").createIndex("by-type", "objectType");

          // `getSyncedHistoryVisits` previously loaded every "historyVisit"
          // remote_objects row (via the by-type index) and sorted in memory
          // to find the most recent `limit` — these rows are never
          // tombstoned/pruned (docs/protocol.md §6: each visit is its own
          // permanent object), so on an account with a large synced history
          // this was an unbounded load to return 20 rows. This compound
          // index lets it walk in (objectType, updatedAt) order via a
          // cursor bounded to `limit` instead.
          transaction.objectStore("remote_objects").createIndex("by-type-updated", ["objectType", "updatedAt"]);

          // `applied_operations` grows by one row per remote operation ever
          // applied and had no prune path at all — see `pruneAppliedOperations`.
          transaction.objectStore("applied_operations").createIndex("by-applied-at", "appliedAt");
        }

        if (oldVersion < 4) {
          // Previously, a bookmark/bookmarkFolder whose parent (or, for a
          // move, destination folder) wasn't locally mapped yet got
          // recorded as a conflict and then permanently marked applied —
          // with nothing that ever retried it, the object was silently
          // lost from this device until a full snapshot resync. This
          // store is the actual retry queue: see
          // bookmarks/index.ts::retryDeferredParent.
          const deferred = db.createObjectStore("deferred_materializations", { keyPath: "objectId" });
          deferred.createIndex("by-waiting-on-parent", "waitingOnParent");
        }
      },
    });
  }
  return dbPromise;
}

export function mappingKey(objectType: ObjectType, chromiumLocalId: string): string {
  return `${objectType}:${chromiumLocalId}`;
}

// `getDevice` is called on nearly every operation created or applied
// (createLocalOperation, history's flushVisitEvents, tabs' per-op
// restorePolicy path, etc.) — an in-memory cache turns most of those into a
// cheap lookup instead of an IndexedDB round trip. Safe because this
// service worker is the only writer of the "device" store; `putDevice`/
// `clearDevice` below keep the cache in lockstep with every write.
//
// This module-level mirror is reset by every MV3 service worker restart,
// same as the IndexedDB round trip it exists to avoid — so it's backed by
// chrome.storage.session, which specifically survives that restart. Unlike
// `settingsCache`/`reconnectDelayMs` elsewhere, IndexedDB (not
// storage.session) stays the source of truth here: storage.session is only
// ever a "was this already loaded this browser session" shortcut, so
// there's no correctness reason for it to survive a full browser restart —
// chrome.storage.local would gain nothing over the IndexedDB "device" store
// that already persists across those.
const DEVICE_CACHE_STORAGE_KEY = "deviceCache";
let deviceCache: DeviceRecord | undefined;
let deviceCacheLoaded = false;

export async function getDevice(): Promise<DeviceRecord | undefined> {
  if (deviceCacheLoaded) return deviceCache;

  const stored = await chrome.storage.session.get(DEVICE_CACHE_STORAGE_KEY);
  const sessionCached = stored[DEVICE_CACHE_STORAGE_KEY] as DeviceRecord | undefined;
  if (sessionCached !== undefined) {
    deviceCache = sessionCached;
    deviceCacheLoaded = true;
    return deviceCache;
  }

  deviceCache = await (await getDb()).get("device", "self");
  deviceCacheLoaded = true;
  if (deviceCache) {
    await chrome.storage.session.set({ [DEVICE_CACHE_STORAGE_KEY]: deviceCache });
  }
  return deviceCache;
}

export async function putDevice(record: DeviceRecord): Promise<void> {
  await (await getDb()).put("device", record);
  deviceCache = record;
  deviceCacheLoaded = true;
  await chrome.storage.session.set({ [DEVICE_CACHE_STORAGE_KEY]: record });
}

export async function clearDevice(): Promise<void> {
  await (await getDb()).delete("device", "self");
  deviceCache = undefined;
  deviceCacheLoaded = true;
  await chrome.storage.session.remove(DEVICE_CACHE_STORAGE_KEY);
}

export async function getSyncState(): Promise<SyncStateRecord> {
  const db = await getDb();
  const existing = await db.get("sync_state", "self");
  if (existing) return existing;
  const initial: SyncStateRecord = { id: "self", cursor: 0, lamportClock: 0, deviceSequence: 0 };
  await db.put("sync_state", initial);
  return initial;
}

export async function putSyncState(state: SyncStateRecord): Promise<void> {
  await (await getDb()).put("sync_state", state);
}

/** Reserve the next device sequence number, persisting immediately so it is
 * never reused even if the process crashes before the operation is used
 * (docs/protocol.md §4.1). */
export async function nextDeviceSequence(): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("sync_state", "readwrite");
  const store = tx.objectStore("sync_state");
  const state = (await store.get("self")) ?? {
    id: "self" as const,
    cursor: 0,
    lamportClock: 0,
    deviceSequence: 0,
  };
  state.deviceSequence += 1;
  await store.put(state);
  await tx.done;
  return state.deviceSequence;
}

/** Advance and persist the Lamport clock per docs/protocol.md §4.2. */
export async function tickLamportClock(observed?: number): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("sync_state", "readwrite");
  const store = tx.objectStore("sync_state");
  const state = (await store.get("self")) ?? {
    id: "self" as const,
    cursor: 0,
    lamportClock: 0,
    deviceSequence: 0,
  };
  state.lamportClock = Math.max(state.lamportClock, observed ?? 0) + 1;
  await store.put(state);
  await tx.done;
  return state.lamportClock;
}

export async function enqueueOperation(operation: LocalOperation): Promise<void> {
  const db = await getDb();
  await db.put("pending_operations", {
    operation,
    state: "LOCAL_QUEUED",
    createdAt: new Date().toISOString(),
    attempts: 0,
  });
}

/** Reserve `count` consecutive device-sequence numbers and lamport ticks in
 * one transaction, returning the values immediately *before* the reserved
 * range (i.e. caller assigns `start + 1 .. start + count`) — the batch
 * counterpart to calling `nextDeviceSequence`/`tickLamportClock` in a loop,
 * for high-volume callers (e.g. backfill) where a separate transaction per
 * item is pure overhead since nothing else observes the clock in between. */
export async function reserveSequenceBatch(
  count: number,
): Promise<{ startDeviceSequence: number; startLamport: number }> {
  const db = await getDb();
  const tx = db.transaction("sync_state", "readwrite");
  const store = tx.objectStore("sync_state");
  const state = (await store.get("self")) ?? {
    id: "self" as const,
    cursor: 0,
    lamportClock: 0,
    deviceSequence: 0,
  };
  const startDeviceSequence = state.deviceSequence;
  const startLamport = state.lamportClock;
  state.deviceSequence += count;
  state.lamportClock += count;
  await store.put(state);
  await tx.done;
  return { startDeviceSequence, startLamport };
}

/** Batch counterpart to `enqueueOperation` — one transaction for the whole
 * array instead of one per item. */
export async function enqueueOperationsBatch(operations: LocalOperation[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("pending_operations", "readwrite");
  const createdAt = new Date().toISOString();
  for (const operation of operations) {
    await tx.store.put({ operation, state: "LOCAL_QUEUED", createdAt, attempts: 0 });
  }
  await tx.done;
}

/** Returns up to `limit` pending operations in ascending device-sequence
 * order, via the `by-sequence` index cursor — cost proportional to `limit`,
 * not to the total size of the queue (unlike a `getAll()` + in-memory
 * sort, which `uploadPending` would otherwise re-pay on every batch of
 * every sync cycle).
 *
 * Only returns `LOCAL_QUEUED` records — `UPLOAD_IN_FLIGHT` ones are skipped
 * (without counting toward `limit`) so a batch already being uploaded is
 * never handed out a second time concurrently. This is only a safe filter
 * because `resetInFlightOperations` (below) guarantees `UPLOAD_IN_FLIGHT`
 * never survives across a service-worker restart — otherwise a
 * crash-orphaned in-flight record would become permanently invisible here
 * and simply never sync again. */
export async function getPendingOperations(limit = 200): Promise<PendingOperationRecord[]> {
  const db = await getDb();
  const results: PendingOperationRecord[] = [];
  let cursor = await db.transaction("pending_operations").store.index("by-sequence").openCursor();
  while (cursor && results.length < limit) {
    if (cursor.value.state === "LOCAL_QUEUED") {
      results.push(cursor.value);
    }
    cursor = await cursor.continue();
  }
  return results;
}

/** Resets every `UPLOAD_IN_FLIGHT` operation back to `LOCAL_QUEUED`, via the
 * `by-state` index. Called once at service-worker startup
 * (background/index.ts) — see its call site for why this is always safe to
 * do unconditionally there: a restart proves any `fetch` that was genuinely
 * in flight is now dead, so nothing still legitimately holds that state. */
export async function resetInFlightOperations(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("pending_operations", "readwrite");
  let cursor = await tx.store
    .index("by-state")
    .openCursor(IDBKeyRange.only("UPLOAD_IN_FLIGHT" satisfies PendingState));
  while (cursor) {
    await cursor.update({ ...cursor.value, state: "LOCAL_QUEUED" });
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function countPendingOperations(): Promise<number> {
  return (await getDb()).count("pending_operations");
}

export async function markUploadInFlight(operationIds: string[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("pending_operations", "readwrite");
  for (const id of operationIds) {
    const record = await tx.store.get(id);
    if (record) {
      record.state = "UPLOAD_IN_FLIGHT";
      record.attempts += 1;
      await tx.store.put(record);
    }
  }
  await tx.done;
}

/** Return in-flight operations to LOCAL_QUEUED, e.g. after a failed request
 * (docs/protocol.md §15.2) — retried later with the same operationId. */
export async function requeueInFlight(operationIds: string[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("pending_operations", "readwrite");
  for (const id of operationIds) {
    const record = await tx.store.get(id);
    if (record) {
      record.state = "LOCAL_QUEUED";
      await tx.store.put(record);
    }
  }
  await tx.done;
}

/** Remove operations from the local pending queue — only ever called after
 * durable server acceptance (docs/protocol.md §15.4). */
export async function removeFromQueue(operationIds: string[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("pending_operations", "readwrite");
  for (const id of operationIds) {
    await tx.store.delete(id);
  }
  await tx.done;
}

export async function hasAppliedOperation(operationId: string): Promise<boolean> {
  return (await (await getDb()).get("applied_operations", operationId)) !== undefined;
}

/** Batch counterpart to `hasAppliedOperation` — one transaction covering
 * every id in a downloaded page instead of one transaction per operation.
 * Used only as an upfront pre-filter (skip operations already applied by a
 * prior page/cycle); it does NOT replace the chunked `markAppliedBatch`
 * flush that must still happen every `MARK_APPLIED_CHUNK` operations, in
 * sync/engine.ts's `downloadAndApply` (docs/protocol.md §15.6 / AI rule #8:
 * an operation must never be double-applied, so the crash-safety window
 * between "applied" and "recorded as applied" has to stay bounded to a
 * small chunk of operations, not widened to a whole page). */
export async function getAppliedOperationIds(operationIds: string[]): Promise<Set<string>> {
  if (operationIds.length === 0) return new Set();
  const db = await getDb();
  const tx = db.transaction("applied_operations");
  const results = await Promise.all(operationIds.map((id) => tx.store.get(id)));
  await tx.done;
  const applied = new Set<string>();
  results.forEach((r, i) => {
    if (r) applied.add(operationIds[i]);
  });
  return applied;
}

export async function markApplied(operationId: string): Promise<void> {
  await (await getDb()).put("applied_operations", {
    operationId,
    appliedAt: new Date().toISOString(),
  });
}

/** Batch counterpart to `markApplied` — one transaction covering a chunk of
 * operation ids instead of one transaction per id. Callers (sync/engine.ts)
 * deliberately flush this in small bounded chunks rather than once per
 * download page — see `MARK_APPLIED_CHUNK` there for why the chunk size
 * itself is a crash-safety tradeoff, not just a performance knob. */
export async function markAppliedBatch(operationIds: string[]): Promise<void> {
  if (operationIds.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("applied_operations", "readwrite");
  const appliedAt = new Date().toISOString();
  for (const operationId of operationIds) {
    await tx.store.put({ operationId, appliedAt });
  }
  await tx.done;
}

// Once a downloaded operation's cursor has been persisted past it
// (`putSyncState` in sync/engine.ts), the server will never redeliver that
// same operationId to this device again — its `applied_operations` entry
// only exists to guard against re-processing the same still-in-flight page
// after a crash, so entries this old serve no further purpose. Kept well
// short of the server's own tombstone/compaction retention window (default
// 30 days, server/src/sync/compaction.rs) so nothing here is ever pruned
// before the corresponding server-side data could plausibly still resend.
const APPLIED_OPERATIONS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Deletes `applied_operations` rows older than the retention window via
 * the `by-applied-at` index, bounding the walk to just the rows actually
 * due for deletion rather than the whole (otherwise never-pruned) store. */
export async function pruneAppliedOperations(): Promise<void> {
  const cutoff = new Date(Date.now() - APPLIED_OPERATIONS_RETENTION_MS).toISOString();
  const db = await getDb();
  const tx = db.transaction("applied_operations", "readwrite");
  let cursor = await tx.store.index("by-applied-at").openCursor(IDBKeyRange.upperBound(cutoff));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function getMappingByLocalId(
  objectType: ObjectType,
  chromiumLocalId: string,
): Promise<ObjectMappingRecord | undefined> {
  return (await getDb()).get("object_mappings", mappingKey(objectType, chromiumLocalId));
}

export async function getMappingByObjectId(
  objectId: string,
): Promise<ObjectMappingRecord | undefined> {
  return (await getDb()).getFromIndex("object_mappings", "by-object-id", objectId);
}

/** Batch counterpart to `getMappingByObjectId` — one transaction covering
 * every id instead of one transaction per lookup. Used where a hot loop
 * (e.g. bookmarks/index.ts's sibling-position sort on every move) would
 * otherwise open one IndexedDB transaction per sibling. */
export async function getMappingsByObjectIds(
  objectIds: string[],
): Promise<Map<string, ObjectMappingRecord>> {
  if (objectIds.length === 0) return new Map();
  const db = await getDb();
  const tx = db.transaction("object_mappings");
  const index = tx.store.index("by-object-id");
  const results = await Promise.all(objectIds.map((id) => index.get(id)));
  await tx.done;
  const map = new Map<string, ObjectMappingRecord>();
  results.forEach((r, i) => {
    if (r) map.set(objectIds[i], r);
  });
  return map;
}

/** Batch counterpart to `getMappingByLocalId`. */
export async function getMappingsByLocalIds(
  objectType: ObjectType,
  chromiumLocalIds: string[],
): Promise<Map<string, ObjectMappingRecord>> {
  if (chromiumLocalIds.length === 0) return new Map();
  const db = await getDb();
  const tx = db.transaction("object_mappings");
  const results = await Promise.all(
    chromiumLocalIds.map((id) => tx.store.get(mappingKey(objectType, id))),
  );
  await tx.done;
  const map = new Map<string, ObjectMappingRecord>();
  results.forEach((r, i) => {
    if (r) map.set(chromiumLocalIds[i], r);
  });
  return map;
}

/** All chromiumLocalIds currently mapped for one object type, via the
 * `by-type` index — used by bookmarks/index.ts's backfill to snapshot
 * "already mapped" state once up front rather than re-checking live
 * per-node mid-walk (see backfillExisting's docs for why that distinction
 * matters). */
export async function getMappedChromiumIdsByType(objectType: ObjectType): Promise<Set<string>> {
  const rows = await (await getDb()).getAllFromIndex("object_mappings", "by-type", objectType);
  return new Set(rows.map((r) => r.chromiumLocalId));
}

export async function putMapping(record: ObjectMappingRecord): Promise<void> {
  await (await getDb()).put("object_mappings", record);
}

/** Batch counterpart to `putMapping` — one transaction for the whole array
 * instead of one per record. Used by bookmarks/index.ts's backfill, which
 * otherwise minted+persisted one mapping per node via its own transaction. */
export async function putMappingsBatch(records: ObjectMappingRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("object_mappings", "readwrite");
  for (const record of records) {
    await tx.store.put(record);
  }
  await tx.done;
}

export async function deleteMappingByLocalId(
  objectType: ObjectType,
  chromiumLocalId: string,
): Promise<void> {
  await (await getDb()).delete("object_mappings", mappingKey(objectType, chromiumLocalId));
}

export async function recordConflict(conflict: Omit<ConflictRecord, "id">): Promise<void> {
  await (await getDb()).add("conflicts", conflict as ConflictRecord);
}

export async function getConflicts(): Promise<ConflictRecord[]> {
  return (await getDb()).getAll("conflicts");
}

/** Caps the diagnostic conflict log at `maxCount`, deleting the oldest by
 * key (the store's `id` is autoIncrement, so ascending key order is
 * insertion order — no separate index needed). Low-volume in practice
 * (most deferred materializations now self-resolve via
 * `retryDeferredParent` rather than staying conflicts forever), but still
 * unbounded over a long enough install lifetime without this. */
export async function pruneConflicts(maxCount: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("conflicts", "readwrite");
  const total = await tx.store.count();
  let toDelete = total - maxCount;
  if (toDelete <= 0) {
    await tx.done;
    return;
  }
  let cursor = await tx.store.openCursor(); // ascending id = oldest first
  while (cursor && toDelete > 0) {
    await cursor.delete();
    toDelete--;
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function putDeferredMaterialization(record: DeferredMaterializationRecord): Promise<void> {
  await (await getDb()).put("deferred_materializations", record);
}

export async function getDeferredMaterializationsWaitingOn(
  parentObjectId: string,
): Promise<DeferredMaterializationRecord[]> {
  return (await getDb()).getAllFromIndex(
    "deferred_materializations",
    "by-waiting-on-parent",
    parentObjectId,
  );
}

export async function deleteDeferredMaterialization(objectId: string): Promise<void> {
  await (await getDb()).delete("deferred_materializations", objectId);
}

/** Batch counterpart to `deleteDeferredMaterialization` — one transaction
 * for the whole array instead of one per record, following the same
 * shared-transaction pattern as `putRemoteObjectsBatch`. Used by
 * `retryDeferredParent` (bookmarks/index.ts), which otherwise deleted each
 * retried record's deferred-materialization row one at a time. */
export async function deleteDeferredMaterializationsBatch(objectIds: string[]): Promise<void> {
  if (objectIds.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("deferred_materializations", "readwrite");
  for (const objectId of objectIds) {
    await tx.store.delete(objectId);
  }
  await tx.done;
}

export async function putRemoteObject(record: RemoteObjectRecord): Promise<void> {
  await (await getDb()).put("remote_objects", record);
}

/** Batch counterpart to `putRemoteObject` — one transaction for the whole
 * array instead of one per record. Used during snapshot resync
 * (sync/engine.ts) for object types with a registered batch applier, where
 * a large account can otherwise open thousands of individual transactions
 * purely for this bookkeeping write. */
export async function putRemoteObjectsBatch(records: RemoteObjectRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("remote_objects", "readwrite");
  for (const record of records) {
    await tx.store.put(record);
  }
  await tx.done;
}

export async function getRemoteObjectsByType(objectType: ObjectType): Promise<RemoteObjectRecord[]> {
  return (await getDb()).getAllFromIndex("remote_objects", "by-type", objectType);
}

/** Walks the `by-type-updated` index newest-first, bounded to `maxCount`
 * rows, instead of loading every "historyVisit" row in the store (which —
 * unlike bookmarks/tabs — never shrinks, since visits are never
 * tombstoned). `maxCount` is intentionally larger than the final `limit`
 * `selectRecentHistoryVisits` returns, since this cursor walk (unlike that
 * function) can't yet exclude tombstoned/payload-less rows before counting
 * towards the bound. */
async function getRecentRemoteObjectsByType(
  objectType: ObjectType,
  maxCount: number,
): Promise<RemoteObjectRecord[]> {
  const db = await getDb();
  const results: RemoteObjectRecord[] = [];
  let cursor = await db
    .transaction("remote_objects")
    .store.index("by-type-updated")
    .openCursor(IDBKeyRange.bound([objectType, ""], [objectType, "\uffff"]), "prev");
  while (cursor && results.length < maxCount) {
    results.push(cursor.value);
    cursor = await cursor.continue();
  }
  return results;
}

export async function getSyncedHistoryVisits(limit = 20): Promise<HistoryVisitPayload[]> {
  const candidates = await getRecentRemoteObjectsByType("historyVisit", limit * 3);
  return selectRecentHistoryVisits(candidates, limit);
}

/** Caps how many `remote_objects` rows of one type are kept, deleting the
 * oldest (by `updatedAt`, via the `by-type-updated` index) past `maxCount`.
 * Every write to this store (`putRemoteObject`) is a `put`, never followed
 * by any delete — a closed tab/window/tabGroup or an old historyVisit just
 * gets `deleted: true` and stays forever otherwise, so without this the
 * store only ever grows for the lifetime of the install. Cheap when
 * already under the cap: one `count()` on the index range, no cursor walk
 * at all. */
export async function pruneRemoteObjectsByType(objectType: ObjectType, maxCount: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("remote_objects", "readwrite");
  const index = tx.store.index("by-type-updated");
  const range = IDBKeyRange.bound([objectType, ""], [objectType, "\uffff"]);
  const total = await index.count(range);
  let toDelete = total - maxCount;
  if (toDelete <= 0) {
    await tx.done;
    return;
  }
  let cursor = await index.openCursor(range, "next"); // ascending updatedAt = oldest first
  while (cursor && toDelete > 0) {
    await cursor.delete();
    toDelete--;
    cursor = await cursor.continue();
  }
  await tx.done;
}

/** Remote tabs tracked for display but not yet restored as a real local
 * browser tab — see `selectPendingTabRestores` for the filtering rule. */
export async function getPendingTabRestores(): Promise<PendingTabRestore[]> {
  const db = await getDb();
  const [records, tabMappings] = await Promise.all([
    getRemoteObjectsByType("tab"),
    db.getAllFromIndex("object_mappings", "by-type", "tab"),
  ]);
  const materializedObjectIds = new Set(tabMappings.map((m) => m.objectId));
  return selectPendingTabRestores(records, materializedObjectIds);
}

export function fieldStateKey(objectId: string, field: string): string {
  return `${objectId}:${field}`;
}

export async function getFieldState(
  objectId: string,
  field: string,
): Promise<FieldStateRecord | undefined> {
  return (await getDb()).get("field_state", fieldStateKey(objectId, field));
}

/** Batch counterpart to `getFieldState` for the *same* field across many
 * objects — one transaction instead of one per object. Used by
 * bookmarks/index.ts's sibling-position sort, which otherwise looked up
 * the "move" field for every sibling sequentially on every move. */
export async function getFieldStatesForObjects(
  objectIds: string[],
  field: string,
): Promise<Map<string, FieldStateRecord>> {
  if (objectIds.length === 0) return new Map();
  const db = await getDb();
  const tx = db.transaction("field_state");
  const results = await Promise.all(objectIds.map((id) => tx.store.get(fieldStateKey(id, field))));
  await tx.done;
  const map = new Map<string, FieldStateRecord>();
  results.forEach((r, i) => {
    if (r) map.set(objectIds[i], r);
  });
  return map;
}

export async function putFieldState(record: Omit<FieldStateRecord, "key">): Promise<void> {
  await (await getDb()).put("field_state", {
    ...record,
    key: fieldStateKey(record.objectId, record.field),
    recordedAt: Date.now(), // always stamped fresh here — see FieldStateRecord's doc comment
  });
}

/** Batch counterpart to `putFieldState` — one transaction for the whole
 * array instead of one per record. Used by bookmarks/index.ts's backfill,
 * which otherwise wrote 4 field_state rows (title/url/move/liveness) per
 * node in 4 separate transactions. */
export async function putFieldStatesBatch(records: Array<Omit<FieldStateRecord, "key">>): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("field_state", "readwrite");
  const recordedAt = Date.now(); // one timestamp for the whole batch, matching createdAt's per-batch stamping elsewhere in this file
  for (const record of records) {
    await tx.store.put({ ...record, key: fieldStateKey(record.objectId, record.field), recordedAt });
  }
  await tx.done;
}

export async function getAllFieldStates(objectId: string): Promise<FieldStateRecord[]> {
  return (await getDb()).getAllFromIndex("field_state", "by-object-id", objectId);
}

export async function deleteFieldStates(objectId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("field_state", "readwrite");
  const index = tx.store.index("by-object-id");
  for await (const cursor of index.iterate(objectId)) {
    await cursor.delete();
  }
  await tx.done;
}

// `field_state` is the LWW provenance store (sync/conflict.ts's
// resolveFieldInTx): for every (objectId, field) pair it holds the
// ordering key that last won, with NO time bound on how much later a
// legitimately-ordered incoming operation for that same field can still
// arrive and be correctly arbitrated against it (docs/protocol.md §8.1 is
// purely logical/Lamport, not wall-clock). If a deleted object's
// field_state were purged immediately, a late-arriving remote operation
// for that object (e.g. from a device that was offline a long time) would
// hit `resolveFieldInTx`'s `!current` branch and win unconditionally,
// silently resurrecting something the user deleted — even if the delete
// should have won per the real Lamport ordering.
//
// The server has the identical tension and resolves it with time-bounded
// retention: a tombstone-creating operation's row is kept for
// `tombstone_retention_secs` (default 30 days — server/src/config.rs,
// enforced in server/src/sync/compaction.rs) past the delete before it's
// eligible for permanent removal, on the theory that any legitimately
// in-flight concurrent operation should have arrived by then. This mirrors
// that exact value on the client: field_state for a deleted object is only
// purged once at least this long has passed since the delete was recorded,
// which should always be far longer than the server itself would still let
// a genuinely concurrent operation through.
const FIELD_STATE_GC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matching tombstone_retention_secs's default

/**
 * Purges `field_state` for every object whose "liveness" field has read
 * "deleted" for at least `FIELD_STATE_GC_RETENTION_MS` — see the retention
 * comment above for why this can never run immediately after a delete.
 * Once an object clears that window, no further arbitration for *any* of
 * its fields should be needed, so `deleteFieldStates` removes all of them,
 * not just "liveness".
 *
 * "liveness" is the terminal marker written by bookmarks/index.ts (create/
 * delete) and tabs/index.ts (window/tab/tabGroup create/close/delete) —
 * historyVisit never writes a "liveness" field at all (visits are
 * immutable and append-only, never LWW-merged; history/index.ts never
 * calls putFieldState/resolveField), so it's naturally excluded here
 * without needing a special case.
 *
 * The actual age filtering is `selectFieldStateGcCandidates` (storage/
 * selectors.ts) — split out, like this module's other selectors, so it can
 * be unit tested without a real IndexedDB. Loads the whole `field_state`
 * store rather than scanning via an index: this only runs roughly once a
 * day (background/index.ts's `runMaintenanceIfDue`) over a table that
 * isn't large (one row per (object, field) pair, only for objects this
 * device has ever seen), so a dedicated `recordedAt`/`value` index isn't
 * worth paying its maintenance cost on every single field_state write.
 */
export async function gcFieldStates(): Promise<void> {
  const db = await getDb();
  const allRecords = await db.getAll("field_state");
  const cutoffMs = Date.now() - FIELD_STATE_GC_RETENTION_MS;
  const objectIds = selectFieldStateGcCandidates(allRecords, cutoffMs);
  if (objectIds.length === 0) return;

  const tx = db.transaction("field_state", "readwrite");
  const index = tx.store.index("by-object-id");
  for (const objectId of objectIds) {
    for await (const cursor of index.iterate(objectId)) {
      await cursor.delete();
    }
  }
  await tx.done;
}

/** Wipes all per-field provenance (docs/protocol.md §11 snapshot resync
 * only — never called from the normal incremental path). A snapshot's
 * objects/tombstones already represent the fully-merged state as of
 * `snapshotCursor`, so any field_state left over from before this device
 * fell too far behind to sync incrementally is now stale by definition:
 * the ordering keys it holds were assigned from a per-device counter with
 * no cross-device synchronization (docs/protocol.md §8.1 never bumps a
 * local Lamport clock on remote receipt), so there is no numeric key we
 * could seed a snapshot value with that's guaranteed to outrank arbitrary
 * old entries yet still lose to genuinely newer incoming operations.
 * Clearing first sidesteps that: every snapshot field then lands via the
 * unconditional "no prior record" path in `conflict.ts::resolveFieldInTx`
 * instead of a numeric comparison against stale data. */
export async function clearFieldState(): Promise<void> {
  await (await getDb()).clear("field_state");
}
