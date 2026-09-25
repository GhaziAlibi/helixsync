import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from "idb";
import type { HistoryVisitPayload, LocalOperation, ObjectType, TabPayload } from "../sync/types";
import { yieldToEventLoop } from "../util/yield";
import {
  isPendingTabRestore,
  selectFieldStateGcCandidates,
  selectPendingTabRestores,
  selectRecentHistoryVisits,
  selectStaleDeferredMaterializations,
  type PendingTabRestore,
} from "./selectors";

export type PendingState = "LOCAL_QUEUED" | "UPLOAD_IN_FLIGHT";

// Caps concurrent IDB requests issued against a single transaction: 500-wide
// `Promise.all(get/put/delete)` inflates promise churn and holds the
// transaction open for the whole batch. Chunked awaits keep the single-Tx
// pattern but bound in-flight requests.
const IDB_BATCH_CHUNK = 200;

async function putAllChunked<T>(puts: Array<() => Promise<T>>): Promise<void> {
  for (let i = 0; i < puts.length; i += IDB_BATCH_CHUNK) {
    await Promise.all(puts.slice(i, i + IDB_BATCH_CHUNK).map((fn) => fn()));
  }
}

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
  // EXT-3: high-water mark for history/index.ts::backfillExisting's
  // resumability. chrome.history.search returns items in decreasing
  // lastVisitTime order and backfillExisting processes them in that same
  // order, persisting this after each chunk it durably commits to
  // pending_operations — so it holds the lastVisitTime of the most recent
  // history item whose visits are all guaranteed already turned into
  // operations. A service worker restart, browser restart, or thrown error
  // mid-backfill (before initialImportCompletedAt above ever gets set)
  // leaves this in place, so the next call to backfillExisting resumes
  // from here instead of re-scanning — and re-creating operations for —
  // the user's entire history from scratch. Left as-is once a backfill
  // fully completes (harmless: chrome.history.search with this as endTime
  // then returns nothing, so a retry triggered only by e.g. the bookmarks
  // half failing is a cheap no-op for history).
  historyBackfillLastVisitTime?: number;
  // Single-operation history import (historyVisit / bulkImport,
  // docs/protocol.md §8.3): deterministic bulk IDs persisted before POST so
  // a mid-POST service-worker kill retries with the same operationId (server
  // returns duplicate, zero new bytes). Correctness no longer depends on
  // local storage surviving — logout wipes IndexedDB, and relogin re-mints
  // the same IDs deterministically from (deviceId, cutoffMs). Cutoff
  // sensitivity is intentional: a genuinely different scope is a genuinely
  // different import. Persisted alongside the cutoff so a retry reuses the
  // same scope instead of minting a new ID for a shifted window.
  historyBulkCutoffMs?: number;
  // Upper bound of the fixed import window `[historyBulkCutoffMs,
  // historyBulkEndMs)` (history/bulk.ts): the exact boundary between what
  // the bulk import covers and what live capture covers (history/index.ts's
  // `flushVisitEvents` drops any visit before this bound). Set once, to
  // `Date.now()`, and reused (not recomputed) on every later read — the same
  // once-then-reuse contract as `historyBulkCutoffMs` itself.
  //
  // Primary source: background/index.ts's `initializeCaptureForSettings`
  // persists this *before* history/index.ts's `registerCapture` is ever
  // called on this device's first initialize, specifically so the boundary
  // is fixed before live capture can observe a single visit — a visit made
  // during bookmark backfill (which runs before the history bulk import
  // starts) must not be double-counted by both the live path and the bulk
  // enumeration. `history/bulk.ts`'s `collectHistoryBulk` keeps a fallback
  // that sets this at backfill start if it somehow isn't already set (a
  // device record from a build that predates this field, or any future call
  // site that reaches the bulk import without going through
  // `initializeCaptureForSettings` first) — see its own comment.
  historyBulkEndMs?: number;
  historyBulkOperationId?: string;
  historyBulkObjectId?: string;
  // Resume checkpoint for the chunked bulk import (history/bulk.ts):
  // skip-by-count rather than the old page-granularity checkpoint. With a
  // fixed import window (`historyBulkCutoffMs`..`historyBulkEndMs`) and the
  // corrected paging cursor, re-enumerating from scratch produces the exact
  // same visit stream in the exact same order every time (verified against
  // a real 1.1M-visit profile — see fix.md), so a resume can deterministically
  // skip the visits already covered by chunks already durably
  // accepted-or-duplicated, instead of needing to remember *where* in the
  // page sequence it left off. This replaces the old page-level checkpoint
  // (`historyBulkResumePageEndTime`/`historyBulkResumePreviousPageEndTime`/
  // `historyBulkResumeChunkIndex`), which made a page spanning 8+ chunks —
  // observed on a real profile, where a single hot page's visits alone
  // exceeded one chunk's target — impossible to ever finish: every restart
  // inside that page went back to its start, forever.
  //
  // `historyBulkUploadedChunks`: the number of chunks durably accepted or
  // duplicated so far — also the next chunk index to produce.
  // `historyBulkUploadedVisits`: how many visits, in stream order, those
  // chunks cover — skipped, not re-encrypted or re-uploaded, on resume.
  // Both are written together, in the same `putDevice` call, only *after*
  // `onChunk`'s upload for that chunk has returned successfully (accepted or
  // server-side duplicate) — never before, so a worker death between upload
  // and this write just re-sends that one chunk next run, which the
  // server's permanent bulk-dedup (fix.md §3) turns into a cheap duplicate.
  // Both cleared together once the import fully completes;
  // `historyBulkCutoffMs`/`historyBulkEndMs` are kept, same as before, since
  // they document the import's scope.
  historyBulkUploadedChunks?: number;
  historyBulkUploadedVisits?: number;
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
  // Not a `boolean` — IndexedDB's key algorithm rejects booleans (including
  // inside a compound array key), so `deleted: false` would silently drop
  // out of the "by-type-deleted" index below and `IDBKeyRange.only([type,
  // false])` would throw DataError: "not a valid key". `0`/`1` are valid
  // key values and index the same way.
  deleted: 0 | 1;
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
    indexes: {
      "by-state": PendingState;
      "by-sequence": number;
      "by-state-sequence": [PendingState, number];
    };
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
    indexes: {
      "by-type": ObjectType;
      "by-type-updated": [ObjectType, string];
      "by-type-deleted": [ObjectType, 0 | 1];
    };
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
    dbPromise = openDB<HelixSyncDB>("helixsync", 7, {
      async upgrade(db, oldVersion, _newVersion, transaction) {
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

        if (oldVersion < 5) {
          // Badge updates only care about live remote tabs. Keeping liveness
          // in the index avoids cursor-walking every retained tombstone on
          // every sync cycle and WebSocket push.
          transaction.objectStore("remote_objects").createIndex("by-type-deleted", ["objectType", "deleted"]);
        }

        if (oldVersion < 6) {
          // Version 5's `deleted` field was a `boolean`, which IndexedDB
          // can't index — every row silently fell out of "by-type-deleted"
          // and any query against it (`getActiveRemoteObjectsByType`,
          // `countPendingTabRestores`) threw DataError instead of returning
          // results. Rewrite every existing row's `deleted` to `0`/`1` so
          // the index (already created above) actually contains them.
          let cursor = await transaction.objectStore("remote_objects").openCursor();
          while (cursor) {
            const value = cursor.value as RemoteObjectRecord & { deleted: unknown };
            if (typeof value.deleted === "boolean") {
              await cursor.update({ ...value, deleted: value.deleted ? 1 : 0 });
            }
            cursor = await cursor.continue();
          }
        }

        if (oldVersion < 7) {
          // `getPendingOperations` walked the `by-sequence` index from 0 and
          // filtered to LOCAL_QUEUED in JS — O(queue) per batch, up to 50
          // full scans per sync cycle when the head is blocked/excluded.
          // This compound index serves LOCAL_QUEUED rows directly in
          // sequence order, so each batch costs O(batch + excluded head).
          transaction
            .objectStore("pending_operations")
            .createIndex("by-state-sequence", ["state", "operation.deviceSequence"]);
        }
      },
      // Without this, an older connection left open in another extension
      // context (e.g. the background service worker still running
      // pre-reload code right after `chrome://extensions` reload, or a
      // popup from a stale page still holding a reference) blocks this
      // `openDB` call from ever resolving — IndexedDB waits indefinitely
      // for every lower-version connection to close before running the
      // version-upgrade transaction, and nothing here was asking that old
      // connection to close. That surfaces as this call's promise simply
      // never settling, which is fatal for callers like the popup's
      // `render()` that have nothing else gating the UI. Closing our own
      // (older) connection as soon as we're told it's blocking a newer one
      // lets that newer open proceed instead of deadlocking forever.
      blocking() {
        const current = dbPromise;
        dbPromise = null;
        void current?.then((conn) => conn.close());
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
let deviceSessionListenerRegistered = false;

/** Memory-only drop of the device mirror (no session/IDB write), so the
 * next getDevice() re-hydrates from chrome.storage.session (written by
 * another context, e.g. the popup registering) or IndexedDB. Used on
 * cross-context signals where this heap did not perform the write itself:
 * REFRESH_CAPTURE_CONFIG after popup registration, DEVICE_DISCONNECTED
 * after popup clear, and storage.session change events. */
export function invalidateDeviceMemory(): void {
  deviceCache = undefined;
  deviceCacheLoaded = false;
}

function ensureDeviceSessionListener(): void {
  try {
    const area = (globalThis as unknown as { chrome?: typeof chrome }).chrome?.storage?.session;
    const onChanged = (area as unknown as { onChanged?: { addListener?: (cb: (changes: Record<string, unknown>) => void) => void } })?.onChanged;
    if (onChanged?.addListener && !deviceSessionListenerRegistered) {
      deviceSessionListenerRegistered = true;
      onChanged.addListener((changes) => {
        if (DEVICE_CACHE_STORAGE_KEY in changes) invalidateDeviceMemory();
      });
    }
  } catch {
    // No session event surface (tests, older runtimes) — callers still get
    // correctness via the explicit invalidateDeviceMemory() calls.
  }
}
ensureDeviceSessionListener();

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

/** Full local wipe for device disconnect: clears every sync store, not just
 * the `device` row. `clearDevice` above only deleted credentials, so
 * `pending_operations`, `object_mappings`, `remote_objects`, etc. survived
 * logout and resumed (heat + stale data) on the next login. Disconnect must
 * leave no per-account local state behind — the next registration starts
 * from empty stores and re-derives everything from the server + browser. */
export async function clearAllLocalData(): Promise<void> {
  const db = await getDb();
  const stores = [
    "device",
    "sync_state",
    "pending_operations",
    "applied_operations",
    "object_mappings",
    "conflicts",
    "field_state",
    "remote_objects",
    "deferred_materializations",
  ] as const;
  const tx = db.transaction([...stores], "readwrite");
  await Promise.all(stores.map((name) => tx.objectStore(name).clear()));
  await tx.done;
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
  for (let i = 0; i < operations.length; i += IDB_BATCH_CHUNK) {
    await Promise.all(
      operations
        .slice(i, i + IDB_BATCH_CHUNK)
        .map((operation) => tx.store.put({ operation, state: "LOCAL_QUEUED", createdAt, attempts: 0 })),
    );
  }
  await tx.done;
}

/** Returns up to `limit` pending operations in ascending device-sequence
 * order, via the `by-state-sequence` compound index — cost proportional to
 * `limit` plus excluded-head rows, not to the total queue size (unlike the
 * old `by-sequence` walk from 0 that re-scanned past every
 * `UPLOAD_IN_FLIGHT` row on every batch of every sync cycle).
 *
 * Only returns `LOCAL_QUEUED` records — `UPLOAD_IN_FLIGHT` ones never match
 * the index range, so a batch already being uploaded is never handed out a
 * second time concurrently. This is only a safe filter because
 * `resetInFlightOperations` (below) guarantees `UPLOAD_IN_FLIGHT` never
 * survives across a service-worker restart — otherwise a crash-orphaned
 * in-flight record would become permanently invisible here and simply never
 * sync again.
 *
 * If `excludeIds` is provided, operations whose `operationId` is in the set
 * are skipped without counting toward `limit`. This allows callers (like
 * `uploadPending`) to skip operations already requeued or in-flight earlier
 * in the same sync cycle and fetch subsequent ready operations (resolving
 * head-of-line blocking).
 *
 * The scan is capped (`limit` + excluded ids + headroom): when the head is
 * blocked by many excluded ids, this returns what fits rather than holding
 * one read transaction open across the whole queue and blocking
 * `markUploadInFlight`'s write. */
export async function getPendingOperations(
  limit = 200,
  excludeIds?: ReadonlySet<string>,
): Promise<PendingOperationRecord[]> {
  const db = await getDb();
  const results: PendingOperationRecord[] = [];
  const maxScan = limit + (excludeIds?.size ?? 0) + 500;
  let scanned = 0;
  try {
    const range = IDBKeyRange.bound(
      ["LOCAL_QUEUED" as PendingState, 0],
      ["LOCAL_QUEUED" as PendingState, Number.MAX_SAFE_INTEGER],
    );
    let cursor = await db
      .transaction("pending_operations")
      .store.index("by-state-sequence")
      .openCursor(range);
    while (cursor && results.length < limit && scanned < maxScan) {
      scanned++;
      if (!excludeIds || !excludeIds.has(cursor.value.operation.operationId)) {
        results.push(cursor.value);
      }
      cursor = await cursor.continue();
    }
    return results;
  } catch {
    // Pre-v7 databases mid-upgrade (or test doubles without the new index):
    // fall back to the legacy by-sequence walk.
    let cursor = await db.transaction("pending_operations").store.index("by-sequence").openCursor();
    while (cursor && results.length < limit && scanned < maxScan) {
      scanned++;
      if (
        cursor.value.state === "LOCAL_QUEUED" &&
        (!excludeIds || !excludeIds.has(cursor.value.operation.operationId))
      ) {
        results.push(cursor.value);
      }
      cursor = await cursor.continue();
    }
    return results;
  }
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

/** Chunked fetch backing `markUploadInFlight`/`requeueInFlight`: reads every
 * requested row without holding more than one `IDB_BATCH_CHUNK` of parallel
 * gets in flight at once. Missing rows are skipped, never synthesized. */
async function getPendingRecordsByIds(
  tx: IDBPTransaction<HelixSyncDB, ["pending_operations"], "readwrite">,
  operationIds: string[],
): Promise<PendingOperationRecord[]> {
  const records: PendingOperationRecord[] = [];
  for (let i = 0; i < operationIds.length; i += IDB_BATCH_CHUNK) {
    const slice = await Promise.all(operationIds.slice(i, i + IDB_BATCH_CHUNK).map((id) => tx.store.get(id)));
    for (const r of slice) if (r !== undefined) records.push(r);
  }
  return records;
}

// `attempts` is NOT bumped here (it used to be, unconditionally — see
// EXT-2 in review.md). Marking a batch in-flight only means "a request is
// about to be sent for these"; it says nothing yet about whether the
// server ever actually evaluated any individual operation. Counting it
// here meant a whole request-level failure (network error, HTTP 429,
// HTTP 5xx — none of which reach a per-operation decision on the server)
// silently advanced every operation in the batch toward
// MAX_UPLOAD_ATTEMPTS's forced-drop threshold (sync/engine.ts), which
// could permanently delete unsynced local mutations purely because of a
// transient outage or rate limit, never because the server rejected them.
// `attempts` is now only ever incremented by `requeueInFlight`'s
// `incrementAttempts` flag, at the one call site (sync/engine.ts) where an
// operation was individually, explicitly rejected by the server.
export async function markUploadInFlight(operationIds: string[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("pending_operations", "readwrite");
  const records = await getPendingRecordsByIds(tx, operationIds);
  const puts = records.map((record) => () => {
    record.state = "UPLOAD_IN_FLIGHT";
    return tx.store.put(record);
  });
  await putAllChunked(puts);
  await tx.done;
}

/** Fast path for callers that already hold the full records (e.g.
/// sync/engine.ts's `uploadPending`, which just fetched them via
 * `getPendingOperations`): flips state without re-reading every row first,
 * halving the IDB requests for each upload batch (no `get` phase, only
 * `put`s). Falls back to `markUploadInFlight` semantics for missing rows
 * (there are none — all records here came from the queue). */
export async function markUploadInFlightRecords(records: PendingOperationRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("pending_operations", "readwrite");
  await putAllChunked(
    records.map((record) => () => {
      record.state = "UPLOAD_IN_FLIGHT";
      return tx.store.put(record);
    }),
  );
  await tx.done;
}

/** Return in-flight operations to LOCAL_QUEUED, e.g. after a failed request
 * (docs/protocol.md §15.2) — retried later with the same operationId.
 *
 * `incrementAttempts` (default false) controls whether this requeue also
 * counts toward `MAX_UPLOAD_ATTEMPTS` (sync/engine.ts). It must stay false
 * for a transient, request-level failure (network error, HTTP 429/5xx) —
 * the server never got a chance to evaluate these operations individually,
 * so retrying them costs nothing and must never bring them closer to being
 * permanently dropped (see EXT-2 in review.md: this was the actual
 * data-loss bug). It should be true only when the server explicitly,
 * individually rejected this specific operation (e.g. sync/engine.ts's
 * "object_not_found" requeue) — that's a real signal the server looked at
 * this exact operation and couldn't apply it yet. */
export async function requeueInFlight(
  operationIds: string[],
  incrementAttempts = false,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("pending_operations", "readwrite");
  const records = await getPendingRecordsByIds(tx, operationIds);
  await putAllChunked(
    records.map((record) => () => {
      record.state = "LOCAL_QUEUED";
      if (incrementAttempts) record.attempts += 1;
      return tx.store.put(record);
    }),
  );
  await tx.done;
}

/** Fast path matching `markUploadInFlightRecords`: the caller already holds
 * the records (upload batch just attempted), so requeue without re-reading.
 * `incrementAttempts` keeps `requeueInFlight`'s exact semantics — true only
 * for explicit per-operation server rejections, never for request-level
 * failures. */
export async function requeueInFlightRecords(
  records: PendingOperationRecord[],
  incrementAttempts = false,
): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("pending_operations", "readwrite");
  await putAllChunked(
    records.map((record) => () => {
      record.state = "LOCAL_QUEUED";
      if (incrementAttempts) record.attempts += 1;
      return tx.store.put(record);
    }),
  );
  await tx.done;
}

/** Remove operations from the local pending queue — only ever called after
 * durable server acceptance (docs/protocol.md §15.4). */
export async function removeFromQueue(operationIds: string[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("pending_operations", "readwrite");
  await putAllChunked(operationIds.map((id) => () => tx.store.delete(id)));
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
  const applied = new Set<string>();
  for (let i = 0; i < operationIds.length; i += IDB_BATCH_CHUNK) {
    const sliceIds = operationIds.slice(i, i + IDB_BATCH_CHUNK);
    const results = await Promise.all(sliceIds.map((id) => tx.store.get(id)));
    results.forEach((r, j) => {
      if (r) applied.add(sliceIds[j]);
    });
  }
  await tx.done;
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
  await putAllChunked(operationIds.map((operationId) => () => tx.store.put({ operationId, appliedAt })));
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

// Caps how many rows a single prune/gc transaction deletes before
// committing and opening a fresh one for the next chunk — matches this
// codebase's existing 500-item chunk convention for IndexedDB batch work
// (history/index.ts's BACKFILL_FLUSH_CHUNK, sync/engine.ts's
// SNAPSHOT_DISPATCH_CHUNK). Used by `pruneAppliedOperations`,
// `pruneRemoteObjectsByType`, and `gcFieldStates` below: all three can face
// tens of thousands of candidate rows (a long-unopened install, or an
// account with a large synced history), and deleting all of them in one
// unbroken transaction would hold a write lock on the store for the whole
// walk — blocking every other operation against it, and risking Chromium
// aborting the transaction outright on a long enough run. Since this
// maintenance pass runs at most once a day (`runMaintenanceIfDue`), paying
// the cost of a few hundred extra transactions to avoid that is cheap.
const MAINTENANCE_DELETE_CHUNK = 500;

/** Deletes `applied_operations` rows older than the retention window via
 * the `by-applied-at` index, bounding the walk to just the rows actually
 * due for deletion rather than the whole (otherwise never-pruned) store.
 *
 * Deletes in chunks of `MAINTENANCE_DELETE_CHUNK`, each in its own
 * transaction: opening a fresh cursor on the same (fixed) cutoff range
 * after each chunk commits naturally resumes at the next-oldest remaining
 * row, since everything before it was just deleted — see
 * `MAINTENANCE_DELETE_CHUNK` for why this can't just be one transaction. */
export async function pruneAppliedOperations(): Promise<void> {
  const cutoff = new Date(Date.now() - APPLIED_OPERATIONS_RETENTION_MS).toISOString();
  const db = await getDb();
  const range = IDBKeyRange.upperBound(cutoff);
  for (;;) {
    const tx = db.transaction("applied_operations", "readwrite");
    let cursor = await tx.store.index("by-applied-at").openCursor(range);
    let deleted = 0;
    while (cursor && deleted < MAINTENANCE_DELETE_CHUNK) {
      await cursor.delete();
      deleted++;
      cursor = await cursor.continue();
    }
    await tx.done;
    if (deleted < MAINTENANCE_DELETE_CHUNK) break; // fewer than a full chunk left = done
    await yieldToEventLoop();
  }
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
  const map = new Map<string, ObjectMappingRecord>();
  for (let i = 0; i < objectIds.length; i += IDB_BATCH_CHUNK) {
    const sliceIds = objectIds.slice(i, i + IDB_BATCH_CHUNK);
    const results = await Promise.all(sliceIds.map((id) => index.get(id)));
    results.forEach((r, j) => {
      if (r) map.set(sliceIds[j], r);
    });
  }
  await tx.done;
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
  const map = new Map<string, ObjectMappingRecord>();
  for (let i = 0; i < chromiumLocalIds.length; i += IDB_BATCH_CHUNK) {
    const sliceIds = chromiumLocalIds.slice(i, i + IDB_BATCH_CHUNK);
    const results = await Promise.all(sliceIds.map((id) => tx.store.get(mappingKey(objectType, id))));
    results.forEach((r, j) => {
      if (r) map.set(sliceIds[j], r);
    });
  }
  await tx.done;
  return map;
}

/** All chromiumLocalIds currently mapped for one object type, via the
 * `by-type` index — used by bookmarks/index.ts's backfill to snapshot
 * "already mapped" state once up front rather than re-checking live
 * per-node mid-walk (see backfillExisting's docs for why that distinction
 * matters). Walks with a cursor in `IDB_BATCH_CHUNK`-sized pieces instead of
 * one `getAll` that materializes every row as a single in-memory array.
 *
 * Each chunk is read in its own transaction, committed (`tx.done`) *before*
 * yielding: `yieldToEventLoop` hands control back via a real macrotask (see
 * its doc comment), and an IndexedDB transaction auto-commits the moment it
 * has no pending request across a task boundary — yielding while still
 * inside one open transaction (the previous version of this function did,
 * every `IDB_BATCH_CHUNK` items) silently closes it, so the next
 * `cursor.continue()` throws `TransactionInactiveError`. `continuePrimaryKey`
 * resumes each fresh cursor exactly where the last chunk left off, on a
 * mapping-count profile large enough that a bookmark import can genuinely
 * observe this mid-walk. */
export async function getMappedChromiumIdsByType(objectType: ObjectType): Promise<Set<string>> {
  const db = await getDb();
  const ids = new Set<string>();
  let lastPrimaryKey: string | undefined;
  for (;;) {
    const tx = db.transaction("object_mappings");
    const index = tx.store.index("by-type");
    let cursor = await index.openCursor(objectType);
    if (cursor && lastPrimaryKey !== undefined) {
      cursor = await cursor.continuePrimaryKey(objectType, lastPrimaryKey);
    }
    let scanned = 0;
    while (cursor && scanned < IDB_BATCH_CHUNK) {
      ids.add(cursor.value.chromiumLocalId);
      lastPrimaryKey = cursor.primaryKey;
      cursor = await cursor.continue();
      scanned++;
    }
    const exhausted = scanned < IDB_BATCH_CHUNK;
    await tx.done;
    if (exhausted) break;
    await yieldToEventLoop();
  }
  return ids;
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
  await putAllChunked(records.map((record) => () => tx.store.put(record)));
  await tx.done;
}

/** Batch counterpart to `deleteMappingByLocalId` — one transaction for the
 * whole array. Used by the bookmark/tab capture flushes, which otherwise
 * deleted one mapping per removed node sequentially. */
export async function deleteMappingsBatch(objectType: ObjectType, chromiumLocalIds: string[]): Promise<void> {
  if (chromiumLocalIds.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("object_mappings", "readwrite");
  await putAllChunked(
    chromiumLocalIds.map((id) => () => tx.store.delete(mappingKey(objectType, id))),
  );
  await tx.done;
}

export interface BookmarkBackfillBatch {
  mappings: ObjectMappingRecord[];
  operations: LocalOperation[];
  fieldStates: Array<Omit<FieldStateRecord, "key">>;
}

/**
 * Commits bookmark backfill chunks atomically across object_mappings,
 * pending_operations, and field_state in a single IndexedDB transaction.
 *
 * EXT-05: Prevents crash-inconsistency during bookmark backfill. Previously,
 * mappings were committed in one transaction, operations in a second, and field states
 * in a third. If the service worker crashed or was terminated after mappings were
 * written but before operations were committed, subsequent backfill runs skipped the
 * nodes because they appeared in `alreadyMapped`, while their create operations were
 * never queued, causing permanent data loss across devices.
 */
export async function commitBookmarkBackfillBatch(batch: BookmarkBackfillBatch): Promise<void> {
  const { mappings, operations, fieldStates } = batch;
  if (mappings.length === 0 && operations.length === 0 && fieldStates.length === 0) return;

  const db = await getDb();
  const tx = db.transaction(["object_mappings", "pending_operations", "field_state"], "readwrite");
  const createdAt = new Date().toISOString();
  const recordedAt = Date.now();

  const mappingsStore = tx.objectStore("object_mappings");
  for (let i = 0; i < mappings.length; i += IDB_BATCH_CHUNK) {
    await Promise.all(mappings.slice(i, i + IDB_BATCH_CHUNK).map((record) => mappingsStore.put(record)));
  }

  const opsStore = tx.objectStore("pending_operations");
  for (let i = 0; i < operations.length; i += IDB_BATCH_CHUNK) {
    await Promise.all(
      operations
        .slice(i, i + IDB_BATCH_CHUNK)
        .map((operation) => opsStore.put({ operation, state: "LOCAL_QUEUED", createdAt, attempts: 0 })),
    );
  }

  const fieldStateStore = tx.objectStore("field_state");
  for (let i = 0; i < fieldStates.length; i += IDB_BATCH_CHUNK) {
    await Promise.all(
      fieldStates.slice(i, i + IDB_BATCH_CHUNK).map((record) =>
        fieldStateStore.put({
          ...record,
          key: fieldStateKey(record.objectId, record.field),
          recordedAt,
        }),
      ),
    );
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
  await putAllChunked(objectIds.map((objectId) => () => tx.store.delete(objectId)));
  await tx.done;
}

/** Drops deferred-materialization rows older than `maxAgeMs`. Without this
 * the store grows for the lifetime of the install whenever a parent never
 * arrives (every other unbounded store has a daily cap; this one had none).
 * A pruned child that later becomes materializable still heals via the next
 * snapshot resync, which replays every object through the same appliers. */
export async function pruneDeferredMaterializations(maxAgeMs: number): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  const db = await getDb();
  // Cursor walk in MAINTENANCE_DELETE_CHUNK-sized pieces instead of one
  // `getAll()` that materializes every deferred row at once. Only stale
  // objectIds (small strings) accumulate across chunks; live rows are dropped
  // after each chunk's selector call. Each chunk is read in its own
  // transaction, committed before yielding — same reasoning as
  // `getMappedChromiumIdsByType` above and `gcFieldStates`' scan phase below:
  // yielding to `yieldToEventLoop`'s real macrotask while still inside one
  // open transaction lets it auto-commit out from under the walk, so the
  // next `cursor.continue()` throws TransactionInactiveError.
  const stale: string[] = [];
  let lastSeenKey: string | undefined;
  for (;;) {
    const tx = db.transaction("deferred_materializations");
    const range = lastSeenKey !== undefined ? IDBKeyRange.lowerBound(lastSeenKey, true) : undefined;
    let cursor = await tx.store.openCursor(range);
    const scanChunk: Array<{ objectId: string; createdAt: string }> = [];
    while (cursor && scanChunk.length < MAINTENANCE_DELETE_CHUNK) {
      scanChunk.push({ objectId: cursor.value.objectId, createdAt: cursor.value.createdAt });
      lastSeenKey = cursor.value.objectId;
      cursor = await cursor.continue();
    }
    await tx.done;
    for (const id of selectStaleDeferredMaterializations(scanChunk, cutoff)) stale.push(id);
    if (scanChunk.length < MAINTENANCE_DELETE_CHUNK) break;
    await yieldToEventLoop();
  }
  for (let i = 0; i < stale.length; i += MAINTENANCE_DELETE_CHUNK) {
    await deleteDeferredMaterializationsBatch(stale.slice(i, i + MAINTENANCE_DELETE_CHUNK));
  }
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
  await putAllChunked(records.map((record) => () => tx.store.put(record)));
  await tx.done;
}

export async function getRemoteObjectsByType(objectType: ObjectType): Promise<RemoteObjectRecord[]> {
  return (await getDb()).getAllFromIndex("remote_objects", "by-type", objectType);
}

/** Returns non-deleted remote objects of the given type, querying the compound
 * `by-type-deleted` index to bypass tombstones at the IndexedDB level rather
 * than loading and deserializing them into memory. */
export async function getActiveRemoteObjectsByType(objectType: ObjectType): Promise<RemoteObjectRecord[]> {
  return (await getDb()).getAllFromIndex(
    "remote_objects",
    "by-type-deleted",
    IDBKeyRange.only([objectType, 0]),
  );
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
 * at all.
 *
 * Deletes in chunks of `MAINTENANCE_DELETE_CHUNK`, each committed as its
 * own transaction rather than one transaction spanning the entire
 * overage — a large synced-history account can be tens of thousands of
 * rows over `maxCount`, and re-opening a fresh cursor on the same range
 * after each chunk commits still walks oldest-first, since every row
 * deleted so far was strictly older than what remains. See
 * `MAINTENANCE_DELETE_CHUNK` for why this can't just be one transaction. */
export async function pruneRemoteObjectsByType(objectType: ObjectType, maxCount: number): Promise<void> {
  const db = await getDb();
  const range = IDBKeyRange.bound([objectType, ""], [objectType, "\uffff"]);
  let toDelete: number;
  {
    const tx = db.transaction("remote_objects");
    toDelete = (await tx.store.index("by-type-updated").count(range)) - maxCount;
    await tx.done;
  }
  while (toDelete > 0) {
    const batchSize = Math.min(MAINTENANCE_DELETE_CHUNK, toDelete);
    const tx = db.transaction("remote_objects", "readwrite");
    let cursor = await tx.store.index("by-type-updated").openCursor(range, "next"); // ascending updatedAt = oldest first
    let deleted = 0;
    while (cursor && deleted < batchSize) {
      await cursor.delete();
      deleted++;
      cursor = await cursor.continue();
    }
    await tx.done;
    if (deleted === 0) break; // nothing left to delete (shouldn't happen given the count above, but avoid looping forever)
    toDelete -= deleted;
    await yieldToEventLoop();
  }
}

/** Remote tabs tracked for display but not yet restored as a real local
 * browser tab — see `selectPendingTabRestores` for the filtering rule.
 * Uses `getActiveRemoteObjectsByType("tab")` to query the compound
 * `by-type-deleted` index with `["tab", false]`, bypassing tombstones at the
 * IndexedDB level instead of loading all closed tab tombstones into memory. */
export async function getPendingTabRestores(): Promise<PendingTabRestore[]> {
  const db = await getDb();
  const [records, tabMappings] = await Promise.all([
    getActiveRemoteObjectsByType("tab"),
    db.getAllFromIndex("object_mappings", "by-type", "tab"),
  ]);
  const materializedObjectIds = new Set(tabMappings.map((m) => m.objectId));
  return selectPendingTabRestores(records, materializedObjectIds);
}

/** Bounded variant of `getPendingTabRestores` for the popup's initial
 * render, which only ever shows `PENDING_RESTORE_PAGE_SIZE` rows up front
 * (popup/main.ts): walks the live-tab portion of the `by-type-deleted`
 * index with a cursor and stops after `limit` pending rows instead of
 * materializing every live tab payload into memory just to display the
 * first page. Callers that need the rest (the "Show more" path) still use
 * the full `getPendingTabRestores`, and callers that only need the total
 * use `countPendingTabRestores` — both apply the same `isPendingTabRestore`
 * predicate. */
export async function getPendingTabRestoresLimited(limit: number): Promise<PendingTabRestore[]> {
  const db = await getDb();
  const tabMappings = await db.getAllFromIndex("object_mappings", "by-type", "tab");
  const materializedObjectIds = new Set(tabMappings.map((m) => m.objectId));
  const results: PendingTabRestore[] = [];
  // Chunked cursor walk, one transaction per chunk, committed before
  // yielding — see getMappedChromiumIdsByType's doc comment for why a
  // still-open transaction can't survive yieldToEventLoop's real macrotask.
  let lastObjectId: string | undefined;
  for (;;) {
    const tx = db.transaction("remote_objects");
    let cursor = await tx.store.index("by-type-deleted").openCursor(IDBKeyRange.only(["tab", 0]));
    if (cursor && lastObjectId !== undefined) {
      cursor = await cursor.continuePrimaryKey(["tab", 0], lastObjectId);
    }
    let scanned = 0;
    while (cursor && scanned < IDB_BATCH_CHUNK && results.length < limit) {
      const value = cursor.value as RemoteObjectRecord;
      lastObjectId = value.objectId;
      if (isPendingTabRestore(value, materializedObjectIds)) {
        results.push({ objectId: value.objectId, payload: value.payload as TabPayload });
      }
      cursor = await cursor.continue();
      scanned++;
    }
    const exhausted = !cursor;
    await tx.done;
    if (results.length >= limit || exhausted) break;
    await yieldToEventLoop();
  }
  return results;
}

/** Same count as `(await getPendingTabRestores()).length`, for callers that
 * only need the number of pending tab restores (`updateBadge`,
 * background/index.ts) — not the records themselves. Both this and
 * `getPendingTabRestores` query only the live-tab portion of the
 * `by-type-deleted` index to skip retained tombstones at the storage layer;
 * this count variant walks a cursor applying `isPendingTabRestore` one row
 * at a time so it never holds more than one record's deserialized payload
 * in memory at once (whereas `getPendingTabRestores` materializes the array
 * of live records for the UI to render). */
export async function countPendingTabRestores(): Promise<number> {
  const db = await getDb();
  const tabMappings = await db.getAllFromIndex("object_mappings", "by-type", "tab");
  // Fast path: no local tab mappings means nothing is materialized, so every
  // live row with a payload is pending. Walks with a cursor (one row's
  // deserialized payload in memory at a time) instead of one `getAll()` that
  // materializes every live tab payload at once — same O(N) steps, bounded
  // memory. Common for fresh installs / "ask" users who never restore.
  // Chunked cursor walk, one transaction per chunk, committed before
  // yielding — see getMappedChromiumIdsByType's doc comment for why a
  // still-open transaction can't survive yieldToEventLoop's real macrotask.
  if (tabMappings.length === 0) {
    let count = 0;
    let lastObjectId: string | undefined;
    for (;;) {
      const tx = db.transaction("remote_objects");
      let cursor = await tx.store.index("by-type-deleted").openCursor(IDBKeyRange.only(["tab", 0]));
      if (cursor && lastObjectId !== undefined) {
        cursor = await cursor.continuePrimaryKey(["tab", 0], lastObjectId);
      }
      let scanned = 0;
      while (cursor && scanned < IDB_BATCH_CHUNK) {
        const value = cursor.value as RemoteObjectRecord;
        if (value.payload) count++;
        lastObjectId = value.objectId;
        cursor = await cursor.continue();
        scanned++;
      }
      const exhausted = scanned < IDB_BATCH_CHUNK;
      await tx.done;
      if (exhausted) break;
      await yieldToEventLoop();
    }
    return count;
  }
  const materializedObjectIds = new Set(tabMappings.map((m) => m.objectId));
  let count = 0;
  let lastObjectId: string | undefined;
  for (;;) {
    const tx = db.transaction("remote_objects");
    let cursor = await tx.store.index("by-type-deleted").openCursor(IDBKeyRange.only(["tab", 0]));
    if (cursor && lastObjectId !== undefined) {
      cursor = await cursor.continuePrimaryKey(["tab", 0], lastObjectId);
    }
    let scanned = 0;
    while (cursor && scanned < IDB_BATCH_CHUNK) {
      if (isPendingTabRestore(cursor.value, materializedObjectIds)) count++;
      lastObjectId = cursor.value.objectId;
      cursor = await cursor.continue();
      scanned++;
    }
    const exhausted = scanned < IDB_BATCH_CHUNK;
    await tx.done;
    if (exhausted) break;
    await yieldToEventLoop();
  }
  return count;
}

/** Combined page + total for the popup's "ask" view: one mapping fetch and
 * one cursor walk serve both the bounded initial page and the total count,
 * instead of `getPendingTabRestoresLimited` + `countPendingTabRestores`
 * each paying for both. */
export async function getPendingTabRestoresPage(limit: number): Promise<{ items: PendingTabRestore[]; total: number }> {
  const db = await getDb();
  const tabMappings = await db.getAllFromIndex("object_mappings", "by-type", "tab");
  // Fast path matching countPendingTabRestores: no mappings → no
  // materialized filter needed. Still walks once for page+total, but skips
  // the Set build + per-row lookup.
  // Chunked cursor walk, one transaction per chunk, committed before
  // yielding — see getMappedChromiumIdsByType's doc comment for why a
  // still-open transaction can't survive yieldToEventLoop's real macrotask.
  if (tabMappings.length === 0) {
    const items: PendingTabRestore[] = [];
    let total = 0;
    let lastObjectId: string | undefined;
    for (;;) {
      const tx = db.transaction("remote_objects");
      let cursor = await tx.store.index("by-type-deleted").openCursor(IDBKeyRange.only(["tab", 0]));
      if (cursor && lastObjectId !== undefined) {
        cursor = await cursor.continuePrimaryKey(["tab", 0], lastObjectId);
      }
      let scanned = 0;
      while (cursor && scanned < IDB_BATCH_CHUNK) {
        const value = cursor.value as RemoteObjectRecord;
        lastObjectId = value.objectId;
        if (value.payload) {
          total++;
          if (items.length < limit) {
            items.push({ objectId: value.objectId, payload: value.payload as TabPayload });
          }
        }
        cursor = await cursor.continue();
        scanned++;
      }
      const exhausted = scanned < IDB_BATCH_CHUNK;
      await tx.done;
      if (exhausted) break;
      await yieldToEventLoop();
    }
    return { items, total };
  }
  const materializedObjectIds = new Set(tabMappings.map((m) => m.objectId));
  const items: PendingTabRestore[] = [];
  let total = 0;
  let lastObjectId: string | undefined;
  for (;;) {
    const tx = db.transaction("remote_objects");
    let cursor = await tx.store.index("by-type-deleted").openCursor(IDBKeyRange.only(["tab", 0]));
    if (cursor && lastObjectId !== undefined) {
      cursor = await cursor.continuePrimaryKey(["tab", 0], lastObjectId);
    }
    let scanned = 0;
    while (cursor && scanned < IDB_BATCH_CHUNK) {
      const value = cursor.value as RemoteObjectRecord;
      lastObjectId = value.objectId;
      if (isPendingTabRestore(value, materializedObjectIds)) {
        total++;
        if (items.length < limit) {
          items.push({ objectId: value.objectId, payload: value.payload as TabPayload });
        }
      }
      cursor = await cursor.continue();
      scanned++;
    }
    const exhausted = scanned < IDB_BATCH_CHUNK;
    await tx.done;
    if (exhausted) break;
    await yieldToEventLoop();
  }
  return { items, total };
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
  const map = new Map<string, FieldStateRecord>();
  for (let i = 0; i < objectIds.length; i += IDB_BATCH_CHUNK) {
    const sliceIds = objectIds.slice(i, i + IDB_BATCH_CHUNK);
    const results = await Promise.all(sliceIds.map((id) => tx.store.get(fieldStateKey(id, field))));
    results.forEach((r, j) => {
      if (r) map.set(sliceIds[j], r);
    });
  }
  await tx.done;
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
  await putAllChunked(
    records.map((record) => () => tx.store.put({ ...record, key: fieldStateKey(record.objectId, record.field), recordedAt })),
  );
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
 * be unit tested without a real IndexedDB. Still walks the whole
 * `field_state` store — there's no `field`/`value`/`recordedAt` index to
 * narrow the scan to just "liveness: deleted" rows, and a dedicated one
 * isn't worth paying its maintenance cost on every single field_state
 * write, since this only runs roughly once a day (background/index.ts's
 * `runMaintenanceIfDue`) — but in `MAINTENANCE_DELETE_CHUNK`-sized pieces
 * via a cursor rather than one `getAll()` that materializes every row as a
 * single in-memory array: an install with a lot of bookmark/tab churn can
 * have a field_state table large enough for that array itself to be a
 * real memory spike. Candidate objectIds' rows are then deleted in
 * `MAINTENANCE_DELETE_CHUNK`-sized transactions too, same reasoning as
 * `pruneAppliedOperations`/`pruneRemoteObjectsByType` above.
 */
export async function gcFieldStates(): Promise<void> {
  const db = await getDb();
  const cutoffMs = Date.now() - FIELD_STATE_GC_RETENTION_MS;

  // Scan phase: bounded cursor walk in chunked read transactions, yielding
  // to the event loop between chunks so large stores don't monopolize the thread.
  const objectIds = new Set<string>();
  let lastSeenKey: string | undefined;
  for (;;) {
    const tx = db.transaction("field_state", "readonly");
    const range = lastSeenKey !== undefined ? IDBKeyRange.lowerBound(lastSeenKey, true) : undefined;
    let scanCursor = await tx.store.openCursor(range);
    const scanChunk: FieldStateRecord[] = [];
    while (scanCursor && scanChunk.length < MAINTENANCE_DELETE_CHUNK) {
      scanChunk.push(scanCursor.value);
      lastSeenKey = scanCursor.value.key;
      scanCursor = await scanCursor.continue();
    }
    await tx.done;

    for (const id of selectFieldStateGcCandidates(scanChunk, cutoffMs)) {
      objectIds.add(id);
    }

    if (scanChunk.length < MAINTENANCE_DELETE_CHUNK) {
      break;
    }
    await yieldToEventLoop();
  }
  if (objectIds.size === 0) return;

  // Delete phase: chunked into separate transactions, same as
  // `pruneAppliedOperations`/`pruneRemoteObjectsByType` — each object only
  // ever has a handful of fields (title/url/move/liveness), so
  // `MAINTENANCE_DELETE_CHUNK` objectIds per transaction stays well within
  // that chunk's row-count intent.
  let deleteBatch: string[] = [];
  const flushDeleteBatch = async () => {
    if (deleteBatch.length === 0) return;
    const tx = db.transaction("field_state", "readwrite");
    const index = tx.store.index("by-object-id");
    for (const objectId of deleteBatch) {
      for await (const cursor of index.iterate(objectId)) {
        await cursor.delete();
      }
    }
    await tx.done;
    deleteBatch = [];
    await yieldToEventLoop();
  };
  for (const objectId of objectIds) {
    deleteBatch.push(objectId);
    if (deleteBatch.length >= MAINTENANCE_DELETE_CHUNK) await flushDeleteBatch();
  }
  await flushDeleteBatch();
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
