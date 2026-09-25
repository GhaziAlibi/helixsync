import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { fromB64, toB64 } from "../crypto";
import type { HistoryVisitPayload, LocalOperation, ObjectType } from "../sync/types";
import { addSessionStorageChangeListener } from "../util/session-storage";
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

// Caps concurrent requests per transaction: one huge Promise.all inflates
// promise churn and holds the transaction open for the whole batch.
const IDB_BATCH_CHUNK = 200;

async function putAllChunked<T>(puts: Array<() => Promise<T>>): Promise<void> {
  for (let i = 0; i < puts.length; i += IDB_BATCH_CHUNK) {
    await Promise.all(puts.slice(i, i + IDB_BATCH_CHUNK).map((fn) => fn()));
  }
}

/** Looks up `ids` in chunks within the caller's transaction, returning only
 * the ids that were found. */
async function getAllChunked<T>(ids: string[], get: (id: string) => Promise<T | undefined>): Promise<Map<string, T>> {
  const found = new Map<string, T>();
  for (let i = 0; i < ids.length; i += IDB_BATCH_CHUNK) {
    const sliceIds = ids.slice(i, i + IDB_BATCH_CHUNK);
    const results = await Promise.all(sliceIds.map((id) => get(id)));
    results.forEach((record, j) => {
      if (record) found.set(sliceIds[j], record);
    });
  }
  return found;
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
  // Account key (AK, base64), unwrapped locally at connect time (SEC-01,
  // docs/encryption.md §2).
  accountKey: string;
  accountKeyVersion: number;
  // Set once the one-time import of pre-existing bookmarks/history finishes.
  initialImportCompletedAt?: string;
  // Bulk history import scope `[historyBulkCutoffMs, historyBulkEndMs)`
  // (history/bulk.ts). Set once and reused, never recomputed: chunk ids are
  // derived deterministically from the scope, so a retry re-sends the same
  // ids and the server dedups them. `historyBulkEndMs` is also the permanent
  // boundary above which live capture takes over; it's persisted before live
  // capture registers so no visit is counted by both paths.
  historyBulkCutoffMs?: number;
  historyBulkEndMs?: number;
  historyBulkOperationId?: string;
  historyBulkObjectId?: string;
  // Resume checkpoint: chunks accepted (or deduplicated) by the server so
  // far, and how many visits they cover. Enumeration within the fixed scope
  // is deterministic, so a resume skips exactly that many visits. Written
  // only after a chunk's upload succeeds; cleared when the import completes.
  historyBulkUploadedChunks?: number;
  historyBulkUploadedVisits?: number;
}

export interface SyncStateRecord {
  id: "self";
  cursor: number;
  lamportClock: number;
  deviceSequence: number;
  lastSyncAt?: string;
  lastMaintenanceAt?: string;
}

function initialSyncState(): SyncStateRecord {
  return { id: "self", cursor: 0, lamportClock: 0, deviceSequence: 0 };
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

/** A bookmark whose field state resolved but which can't be materialized
 * yet because the folder it depends on has no local mapping (operations for
 * different objects arrive in any order). Retried when that folder
 * materializes; see bookmarks/index.ts::retryDeferredParent. */
export interface DeferredMaterializationRecord {
  objectId: string; // key
  objectType: ObjectType;
  waitingOnParent: string;
  createdAt: string;
}

/** A remote tab/window/tabGroup/historyVisit, tracked for display whether or
 * not it was ever materialized locally (docs/protocol.md §8.4). */
export interface RemoteObjectRecord {
  objectId: string;
  objectType: ObjectType;
  originDeviceId: string;
  payload: unknown;
  // 0/1, not boolean: IndexedDB can't index booleans, so rows with a boolean
  // would silently drop out of "by-type-deleted".
  deleted: 0 | 1;
  updatedAt: string;
}

/** Per-(object, field) provenance: which operation last won the field under
 * docs/protocol.md §8.1 ordering, so merges are deterministic regardless of
 * delivery order. */
export interface FieldStateRecord {
  key: string; // `${objectId}:${field}`
  objectId: string;
  field: string;
  lamportTimestamp: number;
  deviceId: string;
  operationId: string;
  operationType: string;
  value: unknown;
  // Wall-clock write time, used only to age records for `gcFieldStates`.
  // Never an arbitration input. Missing on old records, meaning unknown age.
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
  // Non-extractable AES-GCM key that wraps `device.accountKey` and
  // `device.refreshToken` at rest (F-11). Structured-cloned by IndexedDB
  // like any other value, but `extractable: false` means the raw key
  // material is never exposed to JS and isn't recoverable from the on-disk
  // LevelDB files the way a plain byte string would be.
  device_secret_key: {
    key: "self";
    value: CryptoKey;
  };
}

let dbPromise: Promise<IDBPDatabase<HelixSyncDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<HelixSyncDB>> {
  if (!dbPromise) {
    dbPromise = openDB<HelixSyncDB>("helixsync", 8, {
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
          transaction.objectStore("pending_operations").createIndex("by-sequence", "operation.deviceSequence");
        }

        if (oldVersion < 3) {
          transaction.objectStore("object_mappings").createIndex("by-type", "objectType");
          transaction.objectStore("remote_objects").createIndex("by-type-updated", ["objectType", "updatedAt"]);
          transaction.objectStore("applied_operations").createIndex("by-applied-at", "appliedAt");
        }

        if (oldVersion < 4) {
          const deferred = db.createObjectStore("deferred_materializations", { keyPath: "objectId" });
          deferred.createIndex("by-waiting-on-parent", "waitingOnParent");
        }

        if (oldVersion < 5) {
          transaction.objectStore("remote_objects").createIndex("by-type-deleted", ["objectType", "deleted"]);
        }

        if (oldVersion < 6) {
          // v5 stored `deleted` as a boolean, which IndexedDB can't index, so
          // those rows were missing from "by-type-deleted". Rewrite as 0/1.
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
          transaction
            .objectStore("pending_operations")
            .createIndex("by-state-sequence", ["state", "operation.deviceSequence"]);
        }

        if (oldVersion < 8) {
          db.createObjectStore("device_secret_key");
          // F-11: any existing device record has accountKey/refreshToken in
          // plaintext. Re-encrypting it here would mean awaiting
          // crypto.subtle inside a versionchange transaction, which can
          // auto-commit mid-upgrade since only IDB-request promises keep it
          // alive. Clearing it instead forces a clean reconnect, after which
          // every device record is written encrypted from the start.
          transaction.objectStore("device").clear();
        }
      },
      // An older connection still open in another context (e.g. a worker
      // running pre-reload code) blocks the version upgrade indefinitely, so
      // this open would never settle. Close ours when it blocks a newer one.
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

// `getDevice` runs on nearly every operation, so the record is mirrored in
// memory and in chrome.storage.session (which survives worker restarts).
// IndexedDB stays the source of truth. `deviceCacheLoaded` distinguishes a
// cached "no device" from "not read yet".
const DEVICE_CACHE_STORAGE_KEY = "deviceCache";
let deviceCache: DeviceRecord | undefined;
let deviceCacheLoaded = false;

const deviceSecretTextEncoder = new TextEncoder();
const deviceSecretTextDecoder = new TextDecoder();

interface EncryptedDeviceSecret {
  iv: string;
  ciphertext: string;
}

// F-11: `device.accountKey` and `device.refreshToken` are wrapped with this
// key before they reach IndexedDB, so the on-disk LevelDB files never hold
// them in plaintext. The key itself is generated `extractable: false` and
// stored as a CryptoKey (structured-cloned by IndexedDB), not as raw bytes,
// so it can't be read back out as a string either — it's only usable by
// handing it to SubtleCrypto in this same browser profile. This doesn't
// help against an attacker with code execution in the extension's own
// context (they can just call getDevice()), only against someone reading
// the profile's files directly, since there's no OS keychain to use instead
// (docs/security.md §10).
let deviceSecretKeyPromise: Promise<CryptoKey> | null = null;

async function getDeviceSecretKey(): Promise<CryptoKey> {
  if (!deviceSecretKeyPromise) {
    deviceSecretKeyPromise = (async () => {
      const db = await getDb();
      const existing = await db.get("device_secret_key", "self");
      if (existing) return existing;
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await db.put("device_secret_key", key, "self");
      return key;
    })();
  }
  return deviceSecretKeyPromise;
}

async function encryptDeviceSecret(plaintext: string): Promise<string> {
  const key = await getDeviceSecretKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, deviceSecretTextEncoder.encode(plaintext));
  const envelope: EncryptedDeviceSecret = { iv: toB64(iv), ciphertext: toB64(new Uint8Array(ciphertext)) };
  return JSON.stringify(envelope);
}

async function decryptDeviceSecret(stored: string): Promise<string> {
  const key = await getDeviceSecretKey();
  const envelope = JSON.parse(stored) as EncryptedDeviceSecret;
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(envelope.iv).buffer as ArrayBuffer },
    key,
    fromB64(envelope.ciphertext).buffer as ArrayBuffer,
  );
  return deviceSecretTextDecoder.decode(plaintext);
}

/** Drops only the memory mirror, so the next `getDevice()` re-reads what
 * another context (e.g. the popup) wrote. */
export function invalidateDeviceMemory(): void {
  deviceCache = undefined;
  deviceCacheLoaded = false;
}

addSessionStorageChangeListener((changes) => {
  if (DEVICE_CACHE_STORAGE_KEY in changes) invalidateDeviceMemory();
});

export async function getDevice(): Promise<DeviceRecord | undefined> {
  if (deviceCacheLoaded) return deviceCache;

  const stored = await chrome.storage.session.get(DEVICE_CACHE_STORAGE_KEY);
  const sessionCached = stored[DEVICE_CACHE_STORAGE_KEY] as DeviceRecord | undefined;
  if (sessionCached !== undefined) {
    deviceCache = sessionCached;
    deviceCacheLoaded = true;
    return deviceCache;
  }

  const storedRecord = await (await getDb()).get("device", "self");
  deviceCache = storedRecord && {
    ...storedRecord,
    accountKey: await decryptDeviceSecret(storedRecord.accountKey),
    refreshToken: await decryptDeviceSecret(storedRecord.refreshToken),
  };
  deviceCacheLoaded = true;
  if (deviceCache) {
    await chrome.storage.session.set({ [DEVICE_CACHE_STORAGE_KEY]: deviceCache });
  }
  return deviceCache;
}

export async function putDevice(record: DeviceRecord): Promise<void> {
  const toStore: DeviceRecord = {
    ...record,
    accountKey: await encryptDeviceSecret(record.accountKey),
    refreshToken: await encryptDeviceSecret(record.refreshToken),
  };
  await (await getDb()).put("device", toStore);
  deviceCache = record;
  deviceCacheLoaded = true;
  await chrome.storage.session.set({ [DEVICE_CACHE_STORAGE_KEY]: record });
}

/** Disconnect wipes every store, not just credentials, so a later
 * registration starts clean instead of resuming another account's state. */
export async function clearAllLocalData(): Promise<void> {
  const db = await getDb();
  const stores = [
    "device",
    "device_secret_key",
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
  deviceSecretKeyPromise = null;
  await chrome.storage.session.remove(DEVICE_CACHE_STORAGE_KEY);
}

export async function getSyncState(): Promise<SyncStateRecord> {
  const db = await getDb();
  const existing = await db.get("sync_state", "self");
  if (existing) return existing;
  const initial = initialSyncState();
  await db.put("sync_state", initial);
  return initial;
}

export async function putSyncState(state: SyncStateRecord): Promise<void> {
  await (await getDb()).put("sync_state", state);
}

/** Advances and persists the Lamport clock (docs/protocol.md §4.2). */
export async function tickLamportClock(observed?: number): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("sync_state", "readwrite");
  const store = tx.objectStore("sync_state");
  const state = (await store.get("self")) ?? initialSyncState();
  state.lamportClock = Math.max(state.lamportClock, observed ?? 0) + 1;
  await store.put(state);
  await tx.done;
  return state.lamportClock;
}

/** Reserves `count` device sequences and Lamport ticks in one transaction,
 * persisted immediately so they're never reused (docs/protocol.md §4.1).
 * Returns the values just before the range: callers assign `start + 1` to
 * `start + count`. */
export async function reserveSequenceBatch(
  count: number,
): Promise<{ startDeviceSequence: number; startLamport: number }> {
  const db = await getDb();
  const tx = db.transaction("sync_state", "readwrite");
  const store = tx.objectStore("sync_state");
  const state = (await store.get("self")) ?? initialSyncState();
  const startDeviceSequence = state.deviceSequence;
  const startLamport = state.lamportClock;
  state.deviceSequence += count;
  state.lamportClock += count;
  await store.put(state);
  await tx.done;
  return { startDeviceSequence, startLamport };
}

export async function enqueueOperationsBatch(operations: LocalOperation[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("pending_operations", "readwrite");
  const createdAt = new Date().toISOString();
  await putAllChunked(
    operations.map((operation) => () => tx.store.put({ operation, state: "LOCAL_QUEUED", createdAt, attempts: 0 })),
  );
  await tx.done;
}

/** Up to `limit` LOCAL_QUEUED operations in device-sequence order, skipping
 * `excludeIds` (ops already requeued this cycle) so they don't block the head
 * of the queue. Skipping UPLOAD_IN_FLIGHT is only safe because
 * `resetInFlightOperations` clears that state on every worker start. The
 * scan is capped so a long excluded head can't hold a read transaction open
 * across the whole queue. */
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
    // Pre-v7 databases (no "by-state-sequence" index yet).
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

/** Run once at worker startup: a restart means no upload can still be in
 * flight, so every UPLOAD_IN_FLIGHT row goes back to LOCAL_QUEUED. */
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

async function rewritePendingRecords(
  records: PendingOperationRecord[],
  update: (record: PendingOperationRecord) => void,
): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("pending_operations", "readwrite");
  await putAllChunked(
    records.map((record) => () => {
      update(record);
      return tx.store.put(record);
    }),
  );
  await tx.done;
}

/** Deliberately does not bump `attempts`: going in flight says nothing about
 * whether the server ever judged the operation. */
export async function markUploadInFlightRecords(records: PendingOperationRecord[]): Promise<void> {
  await rewritePendingRecords(records, (record) => {
    record.state = "UPLOAD_IN_FLIGHT";
  });
}

/** Returns in-flight operations to LOCAL_QUEUED for retry with the same
 * operationId (docs/protocol.md §15.2). `incrementAttempts` must be true
 * only when the server explicitly rejected these specific operations; a
 * request-level failure (network, 429, 5xx) must never move an operation
 * toward being dropped at MAX_UPLOAD_ATTEMPTS. */
export async function requeueInFlightRecords(
  records: PendingOperationRecord[],
  incrementAttempts = false,
): Promise<void> {
  await rewritePendingRecords(records, (record) => {
    record.state = "LOCAL_QUEUED";
    if (incrementAttempts) record.attempts += 1;
  });
}

/** Only called after durable server acceptance (docs/protocol.md §15.4). */
export async function removeFromQueue(operationIds: string[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("pending_operations", "readwrite");
  await putAllChunked(operationIds.map((id) => () => tx.store.delete(id)));
  await tx.done;
}

/** Pre-filter for a downloaded page. Recording newly applied ids still
 * happens in small chunks (see the engine's MARK_APPLIED_CHUNK) to bound the
 * double-apply window after a crash. */
export async function getAppliedOperationIds(operationIds: string[]): Promise<Set<string>> {
  if (operationIds.length === 0) return new Set();
  const db = await getDb();
  const tx = db.transaction("applied_operations");
  const applied = await getAllChunked(operationIds, (id) => tx.store.get(id));
  await tx.done;
  return new Set(applied.keys());
}

export async function markAppliedBatch(operationIds: string[]): Promise<void> {
  if (operationIds.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("applied_operations", "readwrite");
  const appliedAt = new Date().toISOString();
  await putAllChunked(operationIds.map((operationId) => () => tx.store.put({ operationId, appliedAt })));
  await tx.done;
}

// Once the cursor has moved past an operation the server never redelivers
// it, so these rows only guard a crash mid-page. Kept well short of the
// server's 30-day compaction window.
const APPLIED_OPERATIONS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

// Maintenance deletes commit every this many rows: one unbroken transaction
// over tens of thousands of rows would hold the store's write lock and risk
// Chromium aborting it.
const MAINTENANCE_DELETE_CHUNK = 500;

/** Reopening a cursor on the same fixed range after each committed chunk
 * resumes at the oldest remaining row. */
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
    if (deleted < MAINTENANCE_DELETE_CHUNK) break;
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

export async function getMappingsByObjectIds(
  objectIds: string[],
): Promise<Map<string, ObjectMappingRecord>> {
  if (objectIds.length === 0) return new Map();
  const db = await getDb();
  const tx = db.transaction("object_mappings");
  const index = tx.store.index("by-object-id");
  const mappings = await getAllChunked(objectIds, (id) => index.get(id));
  await tx.done;
  return mappings;
}

export async function getMappingsByLocalIds(
  objectType: ObjectType,
  chromiumLocalIds: string[],
): Promise<Map<string, ObjectMappingRecord>> {
  if (chromiumLocalIds.length === 0) return new Map();
  const db = await getDb();
  const tx = db.transaction("object_mappings");
  const mappings = await getAllChunked(chromiumLocalIds, (id) => tx.store.get(mappingKey(objectType, id)));
  await tx.done;
  return mappings;
}

/** Walks the "by-type" index in chunks rather than one `getAll`. Each chunk
 * commits before yielding: a transaction with no pending request
 * auto-commits across a task boundary, so the next `continue()` would throw
 * TransactionInactiveError. Each new chunk resumes after the last row the
 * previous one visited. */
export async function getMappedChromiumIdsByType(objectType: ObjectType): Promise<Set<string>> {
  const db = await getDb();
  const ids = new Set<string>();
  let lastPrimaryKey: string | undefined;
  for (;;) {
    const tx = db.transaction("object_mappings");
    const index = tx.store.index("by-type");
    let cursor = await index.openCursor(objectType);
    if (cursor && lastPrimaryKey !== undefined) {
      // continuePrimaryKey lands on the given row itself (and throws if that's
      // the current row), so step past the row already visited.
      if (cursor.primaryKey < lastPrimaryKey) cursor = await cursor.continuePrimaryKey(objectType, lastPrimaryKey);
      if (cursor && cursor.primaryKey === lastPrimaryKey) cursor = await cursor.continue();
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

export async function putMappingsBatch(records: ObjectMappingRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("object_mappings", "readwrite");
  await putAllChunked(records.map((record) => () => tx.store.put(record)));
  await tx.done;
}

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

/** Commits a bookmark backfill chunk's mappings, operations and field states
 * in one transaction. If a crash left mappings without their operations,
 * the next backfill would treat those nodes as already synced and never
 * send them. */
export async function commitBookmarkBackfillBatch(batch: BookmarkBackfillBatch): Promise<void> {
  const { mappings, operations, fieldStates } = batch;
  if (mappings.length === 0 && operations.length === 0 && fieldStates.length === 0) return;

  const db = await getDb();
  const tx = db.transaction(["object_mappings", "pending_operations", "field_state"], "readwrite");
  const createdAt = new Date().toISOString();
  const recordedAt = Date.now();

  const mappingsStore = tx.objectStore("object_mappings");
  await putAllChunked(mappings.map((record) => () => mappingsStore.put(record)));

  const opsStore = tx.objectStore("pending_operations");
  await putAllChunked(
    operations.map((operation) => () => opsStore.put({ operation, state: "LOCAL_QUEUED", createdAt, attempts: 0 })),
  );

  const fieldStateStore = tx.objectStore("field_state");
  await putAllChunked(
    fieldStates.map((record) => () =>
      fieldStateStore.put({
        ...record,
        key: fieldStateKey(record.objectId, record.field),
        recordedAt,
      }),
    ),
  );

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

/** Caps the diagnostic conflict log, deleting oldest first (the
 * autoIncrement key is insertion order). */
export async function pruneConflicts(maxCount: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("conflicts", "readwrite");
  const total = await tx.store.count();
  let toDelete = total - maxCount;
  if (toDelete <= 0) {
    await tx.done;
    return;
  }
  let cursor = await tx.store.openCursor();
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

export async function deleteDeferredMaterializationsBatch(objectIds: string[]): Promise<void> {
  if (objectIds.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("deferred_materializations", "readwrite");
  await putAllChunked(objectIds.map((objectId) => () => tx.store.delete(objectId)));
  await tx.done;
}

/** Drops deferred rows whose parent never arrived. A pruned child still
 * heals via the next snapshot resync. Scans in chunks, each committed before
 * yielding (see getMappedChromiumIdsByType). */
export async function pruneDeferredMaterializations(maxAgeMs: number): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  const db = await getDb();
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

export async function putRemoteObjectsBatch(records: RemoteObjectRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("remote_objects", "readwrite");
  await putAllChunked(records.map((record) => () => tx.store.put(record)));
  await tx.done;
}

/** Non-deleted rows of a type, filtered by the index rather than in memory. */
export async function getActiveRemoteObjectsByType(objectType: ObjectType): Promise<RemoteObjectRecord[]> {
  return (await getDb()).getAllFromIndex(
    "remote_objects",
    "by-type-deleted",
    IDBKeyRange.only([objectType, 0]),
  );
}

/** Newest-first walk bounded to `maxCount` rows. Callers over-fetch because
 * the walk can't exclude tombstoned or payload-less rows before counting. */
async function getRecentRemoteObjectsByType(
  objectType: ObjectType,
  maxCount: number,
): Promise<RemoteObjectRecord[]> {
  const db = await getDb();
  const results: RemoteObjectRecord[] = [];
  let cursor = await db
    .transaction("remote_objects")
    .store.index("by-type-updated")
    .openCursor(IDBKeyRange.bound([objectType, ""], [objectType, "￿"]), "prev");
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

/** Keeps at most `maxCount` rows of a type, deleting oldest first. Closes
 * and deletes only tombstone these rows, so without this the store grows
 * forever. Deletes in committed chunks (see MAINTENANCE_DELETE_CHUNK). */
export async function pruneRemoteObjectsByType(objectType: ObjectType, maxCount: number): Promise<void> {
  const db = await getDb();
  const range = IDBKeyRange.bound([objectType, ""], [objectType, "￿"]);
  let toDelete: number;
  {
    const tx = db.transaction("remote_objects");
    toDelete = (await tx.store.index("by-type-updated").count(range)) - maxCount;
    await tx.done;
  }
  while (toDelete > 0) {
    const batchSize = Math.min(MAINTENANCE_DELETE_CHUNK, toDelete);
    const tx = db.transaction("remote_objects", "readwrite");
    let cursor = await tx.store.index("by-type-updated").openCursor(range, "next");
    let deleted = 0;
    while (cursor && deleted < batchSize) {
      await cursor.delete();
      deleted++;
      cursor = await cursor.continue();
    }
    await tx.done;
    if (deleted === 0) break;
    toDelete -= deleted;
    await yieldToEventLoop();
  }
}

async function getMaterializedTabObjectIds(): Promise<Set<string>> {
  const tabMappings = await (await getDb()).getAllFromIndex("object_mappings", "by-type", "tab");
  return new Set(tabMappings.map((m) => m.objectId));
}

/** Visits every live remote tab row one at a time, so at most one payload
 * is deserialized at once. Chunked like getMappedChromiumIdsByType. */
async function forEachLiveRemoteTab(visit: (record: RemoteObjectRecord) => void): Promise<void> {
  const db = await getDb();
  const liveTabs = IDBKeyRange.only(["tab", 0]);
  let lastObjectId: string | undefined;
  for (;;) {
    const tx = db.transaction("remote_objects");
    let cursor = await tx.store.index("by-type-deleted").openCursor(liveTabs);
    if (cursor && lastObjectId !== undefined) {
      // Same resume-after rule as getMappedChromiumIdsByType.
      if (cursor.primaryKey < lastObjectId) cursor = await cursor.continuePrimaryKey(["tab", 0], lastObjectId);
      if (cursor && cursor.primaryKey === lastObjectId) cursor = await cursor.continue();
    }
    let scanned = 0;
    while (cursor && scanned < IDB_BATCH_CHUNK) {
      visit(cursor.value);
      lastObjectId = cursor.value.objectId;
      cursor = await cursor.continue();
      scanned++;
    }
    const exhausted = scanned < IDB_BATCH_CHUNK;
    await tx.done;
    if (exhausted) break;
    await yieldToEventLoop();
  }
}

/** Remote tabs tracked but not yet restored locally; see
 * `selectPendingTabRestores`. */
export async function getPendingTabRestores(): Promise<PendingTabRestore[]> {
  const [records, materializedObjectIds] = await Promise.all([
    getActiveRemoteObjectsByType("tab"),
    getMaterializedTabObjectIds(),
  ]);
  return selectPendingTabRestores(records, materializedObjectIds);
}

export async function countPendingTabRestores(): Promise<number> {
  const materializedObjectIds = await getMaterializedTabObjectIds();
  let count = 0;
  await forEachLiveRemoteTab((record) => {
    if (isPendingTabRestore(record, materializedObjectIds)) count++;
  });
  return count;
}

/** The popup's first page of pending restores plus the total, in one walk. */
export async function getPendingTabRestoresPage(limit: number): Promise<{ items: PendingTabRestore[]; total: number }> {
  const materializedObjectIds = await getMaterializedTabObjectIds();
  const items: PendingTabRestore[] = [];
  let total = 0;
  await forEachLiveRemoteTab((record) => {
    if (!isPendingTabRestore(record, materializedObjectIds)) return;
    total++;
    if (items.length < limit) items.push({ objectId: record.objectId, payload: record.payload });
  });
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

/** The same field across many objects, in one transaction. */
export async function getFieldStatesForObjects(
  objectIds: string[],
  field: string,
): Promise<Map<string, FieldStateRecord>> {
  if (objectIds.length === 0) return new Map();
  const db = await getDb();
  const tx = db.transaction("field_state");
  const states = await getAllChunked(objectIds, (id) => tx.store.get(fieldStateKey(id, field)));
  await tx.done;
  return states;
}

export async function putFieldState(record: Omit<FieldStateRecord, "key">): Promise<void> {
  await (await getDb()).put("field_state", {
    ...record,
    key: fieldStateKey(record.objectId, record.field),
    recordedAt: Date.now(),
  });
}

export async function putFieldStatesBatch(records: Array<Omit<FieldStateRecord, "key">>): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("field_state", "readwrite");
  const recordedAt = Date.now();
  await putAllChunked(
    records.map((record) => () => tx.store.put({ ...record, key: fieldStateKey(record.objectId, record.field), recordedAt })),
  );
  await tx.done;
}

// A deleted object's field state can't be purged right away: a late remote
// operation for it would find no prior record, win unconditionally, and
// resurrect what the user deleted. This mirrors the server's default
// tombstone retention (tombstone_retention_secs, 30 days).
const FIELD_STATE_GC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Purges all field state of objects whose "liveness" has read "deleted"
 * for longer than FIELD_STATE_GC_RETENTION_MS. History visits never write
 * "liveness", so they're naturally excluded. There's no index to narrow the
 * scan, which is acceptable for a once-a-day pass; both the scan and the
 * deletes run in committed chunks. */
export async function gcFieldStates(): Promise<void> {
  const db = await getDb();
  const cutoffMs = Date.now() - FIELD_STATE_GC_RETENTION_MS;

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

/** Snapshot resync only (docs/protocol.md §11). The snapshot already is the
 * merged state, and no ordering key could be seeded that reliably beats
 * stale local entries yet loses to newer operations, so field state is
 * cleared and every snapshot field lands via the "no prior record" path. */
export async function clearFieldState(): Promise<void> {
  await (await getDb()).clear("field_state");
}
