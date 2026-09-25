import {
  assertSupportedEnvelopeVersion,
  buildOperationAad,
  decryptWithSdek,
  encryptWithSdek,
  getSdek,
  UnsupportedEnvelopeVersionError,
} from "../crypto";
import {
  clearFieldState,
  countPendingOperations,
  type DeviceRecord,
  enqueueOperationsBatch,
  getAppliedOperationIds,
  getDevice,
  getPendingOperations,
  getSyncState,
  markAppliedBatch,
  markUploadInFlightRecords,
  updateSyncState,
  removeFromQueue,
  requeueInFlightRecords,
  reserveSequenceBatch,
  tickLamportClock,
} from "../storage/db";
import { ApiError, downloadChanges, fetchSnapshot, uploadOperations } from "../api/client";
import { isConnected as isWebSocketConnected } from "../api/websocket";
import { isBulkContainer } from "./bulk-container";
import type {
  LocalOperation,
  ObjectType,
  OperationOut,
  OperationType,
  SnapshotResponse,
  UploadRejection,
} from "./types";
import { uuidv7 } from "../util/uuid";
import { yieldToEventLoop } from "../util/yield";
import { chunk } from "../util/chunk";

// --- Applier registry ---------------------------------------------------
// The bookmarks/history/tabs modules register appliers at load, keeping this
// engine free of chrome.* knowledge (docs/architecture.md).

export type ObjectApplier = (op: OperationOut, payload: unknown) => Promise<void>;

const appliers = new Map<ObjectType, ObjectApplier>();

export function registerApplier(objectType: ObjectType, applier: ObjectApplier): void {
  appliers.set(objectType, applier);
}

export type BatchObjectApplier = (items: Array<{ op: OperationOut; payload: unknown }>) => Promise<void>;

const batchAppliers = new Map<ObjectType, BatchObjectApplier>();

/** Optional fast path for types whose per-object IO is expensive. Items are
 * grouped by type, preserving wire order within each type; order across
 * types doesn't matter because each type resolves disjoint LWW slots. */
export function registerBatchApplier(objectType: ObjectType, applier: BatchObjectApplier): void {
  batchAppliers.set(objectType, applier);
}

/** Unknown object types are never applied, but must not fail the batch. */
async function dispatchToApplier(op: OperationOut, payload: unknown): Promise<void> {
  const applier = appliers.get(op.objectType);
  if (!applier) {
    console.warn("HelixSync: no applier registered for object type", op.objectType);
    return;
  }

  await applier(op, payload);
}

type DecryptedItem = { op: OperationOut; payload: unknown };

function pushToGroup(groups: Map<ObjectType, DecryptedItem[]>, item: DecryptedItem): DecryptedItem[] {
  let group = groups.get(item.op.objectType);
  if (!group) {
    group = [];
    groups.set(item.op.objectType, group);
  }
  group.push(item);
  return group;
}

// --- Status -------------------------------------------------------------

export type SyncStatus = "idle" | "syncing" | "error" | "needs_reauth";

let listeners: Array<(status: SyncStatus, detail?: string) => void> = [];
export function onStatusChange(cb: (status: SyncStatus, detail?: string) => void): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}
function emitStatus(status: SyncStatus, detail?: string) {
  for (const cb of listeners) cb(status, detail);
}

// --- Local operations -----------------------------------------------------

export interface CreatedOperation {
  operation: LocalOperation;
  deviceId: string;
}

export interface PendingLocalOperation {
  objectType: ObjectType;
  objectId: string;
  operationType: OperationType;
  payload: unknown;
  visitHours?: Record<string, number>;
}

// The AEAD is pure TS on the single service-worker thread. Yielding every
// few items keeps popup messages and chrome.* events responsive during bulk
// encrypt/decrypt; it doesn't make the work finish sooner.
const CRYPTO_YIELD_CHUNK = 25;

/** Creates, encrypts and (by default) enqueues operations for changes the
 * caller has already applied to the browser (docs/protocol.md §15.1).
 * Sequence and Lamport values increase one per item in array order, but are
 * reserved in one transaction. */
export async function createLocalOperationsBatch(
  items: PendingLocalOperation[],
  options?: { enqueue?: boolean },
): Promise<CreatedOperation[]> {
  if (items.length === 0) return [];

  const device = await getDevice();
  if (!device) throw new Error("cannot create operation: no device registered");

  const { startDeviceSequence, startLamport } = await reserveSequenceBatch(items.length);
  const sdek = await getSdek(device.accountKey, device.accountKeyVersion);

  const operations: LocalOperation[] = [];
  for (let start = 0; start < items.length; start += CRYPTO_YIELD_CHUNK) {
    const end = Math.min(start + CRYPTO_YIELD_CHUNK, items.length);
    for (let i = start; i < end; i++) {
      const item = items[i];
      const wirePayload = encryptWithSdek(
        item.payload,
        sdek,
        device.accountKeyVersion,
        buildOperationAad(item.objectType, item.objectId, item.operationType),
      );
      operations.push({
        operationId: uuidv7(),
        deviceSequence: startDeviceSequence + i + 1,
        lamportTimestamp: startLamport + i + 1,
        objectType: item.objectType,
        objectId: item.objectId,
        operationType: item.operationType,
        encryptionVersion: 1,
        payload: wirePayload,
        visitHours: item.visitHours,
      });
    }
    if (end < items.length) await yieldToEventLoop();
  }

  if (options?.enqueue !== false) {
    await enqueueOperationsBatch(operations);
  }
  return operations.map((operation) => ({ operation, deviceId: device.deviceId }));
}

// --- Upload ---------------------------------------------------------------

// Matches the server's MAX_OPERATIONS_PER_BATCH (server/src/sync/routes.rs).
const MAX_UPLOAD_BATCH = 500;

// Several batches per cycle so a backfill backlog catches up quickly;
// bounded so a batch that never resolves can't spin the worker forever.
const MAX_BATCHES_PER_CYCLE = 50;

// "object_not_found" is requeued because it's usually an ordering race (an
// update uploaded before its create landed). But if the create itself was
// permanently rejected, the dependents would requeue forever; this caps
// them. `attempts` only advances on an explicit per-operation rejection,
// never on a request-level failure, and at most once per uploadPending call,
// so an outage or rate limit can never cause local changes to be dropped.
export const MAX_UPLOAD_ATTEMPTS = 20;

/** Splits per-operation rejections into "requeue" (an ordering race) and
 * "drop" (any other reason; retrying as-is will never succeed). */
export function classifyRejections(rejected: UploadRejection[]): {
  toRequeue: string[];
  toRemove: string[];
} {
  const toRequeue: string[] = [];
  const toRemove: string[] = [];
  for (const rejection of rejected) {
    if (rejection.reason === "object_not_found") {
      toRequeue.push(rejection.operationId);
    } else {
      toRemove.push(rejection.operationId);
    }
  }
  return { toRequeue, toRemove };
}

/** Returns true when the batch budget ran out with a full final batch, i.e.
 * more backlog may remain. */
export async function uploadPending(): Promise<boolean> {
  // Ops requeued as object_not_found in this call are skipped by later
  // batches, so they neither block the head of the queue nor burn through
  // attempts before a download can land their dependency.
  const requeuedThisCycle = new Set<string>();
  let lastBatchFull = false;

  for (let batch = 0; batch < MAX_BATCHES_PER_CYCLE; batch++) {
    const pending = await getPendingOperations(MAX_UPLOAD_BATCH, requeuedThisCycle);
    if (pending.length === 0) return false;
    lastBatchFull = pending.length >= MAX_UPLOAD_BATCH;

    const stuck = pending.filter((p) => p.attempts >= MAX_UPLOAD_ATTEMPTS);
    if (stuck.length > 0) {
      console.error(
        "HelixSync: dropping operations stuck after max upload attempts",
        stuck.map((p) => p.operation.operationId),
      );
      await removeFromQueue(stuck.map((p) => p.operation.operationId));
    }
    const retryable = pending.filter(
      (p) => p.attempts < MAX_UPLOAD_ATTEMPTS && !requeuedThisCycle.has(p.operation.operationId),
    );

    if (retryable.length === 0) {
      // Without dropped stuck items there's no progress to continue from.
      if (stuck.length === 0 || pending.length < MAX_UPLOAD_BATCH) return false;
      continue;
    }

    await markUploadInFlightRecords(retryable);
    const retryableById = new Map(retryable.map((p) => [p.operation.operationId, p]));

    let progressed = stuck.length > 0;
    try {
      const response = await uploadOperations(retryable.map((p) => p.operation));
      const resolved = [...response.accepted, ...response.duplicate];
      await removeFromQueue(resolved);
      progressed = progressed || resolved.length > 0;
      cycleMovedOps += resolved.length + response.rejected.length;
      // History visits alone don't count as activity for the throttle.
      const significantIds = new Set(
        retryable.filter((p) => p.operation.objectType !== "historyVisit").map((p) => p.operation.operationId),
      );
      for (const id of resolved) if (significantIds.has(id)) cycleMovedSignificantOps++;
      for (const r of response.rejected) if (significantIds.has(r.operationId)) cycleMovedSignificantOps++;

      const { toRequeue, toRemove } = classifyRejections(response.rejected);
      for (const rejection of response.rejected) {
        if (rejection.reason !== "object_not_found") {
          console.error("HelixSync: dropping operation after rejection", rejection);
        }
      }

      if (toRequeue.length > 0) {
        // An explicit per-operation verdict, so it counts as an attempt.
        await requeueInFlightRecords(
          toRequeue.map((id) => retryableById.get(id)).filter((r) => r !== undefined),
          true,
        );
        for (const id of toRequeue) requeuedThisCycle.add(id);
        progressed = true;
      }
      if (toRemove.length > 0) {
        await removeFromQueue(toRemove);
        progressed = true;
      }
    } catch (err) {
      // The server never judged these individually: requeue without
      // counting an attempt.
      await requeueInFlightRecords(retryable);
      throw err;
    }

    if (!progressed) return false;
    if (pending.length < MAX_UPLOAD_BATCH) return false;
    await yieldToEventLoop();
  }
  return lastBatchFull;
}

// --- Download -------------------------------------------------------------

const MAX_DOWNLOAD_PAGES_PER_CYCLE = 50;

// How many applied operations are recorded per applied_operations write. An
// operation must never be applied twice (docs/protocol.md §15.6), and a crash
// re-applies everything since the last write, which isn't idempotent for
// every applier. 50 bounds that window while avoiding one transaction per op.
const MARK_APPLIED_CHUNK = 50;

/** Derives each key version's SDEK once per batch instead of per operation. */
function createSdekResolver(rekB64: string): (keyVersion: number) => Promise<Uint8Array> {
  const sdekByVersion = new Map<number, Uint8Array>();
  return async (keyVersion: number): Promise<Uint8Array> => {
    let sdek = sdekByVersion.get(keyVersion);
    if (!sdek) {
      sdek = await getSdek(rekB64, keyVersion);
      sdekByVersion.set(keyVersion, sdek);
    }
    return sdek;
  };
}

/** A bulk history import is the one operation whose payload is not a single
 * envelope: it is a plaintext container (visit count, layout versions) around
 * separately encrypted segments (docs/protocol.md §8.3.1). */
function isBulkImportOp(op: Pick<OperationOut, "objectType" | "operationType">): boolean {
  return op.objectType === "historyVisit" && op.operationType === "bulkImport";
}

/** Throws `UnsupportedEnvelopeVersionError` if the payload holds an envelope
 * in a format this client can't read. Only inspects the `v` tags, so it is
 * cheap enough to run over a whole snapshot before anything is applied. */
function assertEnvelopeVersionsSupported(op: Pick<OperationOut, "objectType" | "operationType" | "payload">): void {
  if (isBulkImportOp(op)) {
    if (isBulkContainer(op.payload)) {
      for (const segment of op.payload.segments) assertSupportedEnvelopeVersion(segment);
    }
    return;
  }
  assertSupportedEnvelopeVersion(op.payload);
}

/** Returns undefined for an operation that can't be decrypted, so it is
 * skipped instead of wedging the loop.
 *
 * SEC-13: an unencrypted operation (`encryptionVersion < 1`) is treated the
 * same way. This client never produces one, so a server sending one is
 * broken or malicious.
 *
 * The exception is an envelope in a format this client doesn't understand
 * (`UnsupportedEnvelopeVersionError`): that is data from a different client
 * version, not corruption, so it is thrown to stop the cycle. The caller must
 * then leave the operation unmarked and the cursor behind it, so it is
 * retried after the user updates the extension. */
async function decryptWithResolver(
  op: OperationOut,
  resolveSdek: (keyVersion: number) => Promise<Uint8Array>,
): Promise<{ payload: unknown } | undefined> {
  if (op.encryptionVersion < 1) {
    console.warn("HelixSync: rejecting unencrypted operation, skipping", op.operationId);
    return undefined;
  }
  assertEnvelopeVersionsSupported(op);
  if (isBulkImportOp(op)) {
    // Each segment is authenticated (with this op's objectId in its AAD)
    // when the history applier expands it, so the container is passed on
    // as-is. Anything else claiming to be a bulk import is rejected here,
    // rather than reaching the applier as an unauthenticated payload.
    if (isBulkContainer(op.payload)) return { payload: op.payload };
    console.warn("HelixSync: bulk history operation without a container, skipping", op.operationId);
    return undefined;
  }
  try {
    const envelope = op.payload as Parameters<typeof decryptWithSdek>[0];
    const sdek = await resolveSdek(envelope.keyVersion);
    const aad = buildOperationAad(op.objectType, op.objectId, op.operationType);
    return { payload: decryptWithSdek(envelope, sdek, aad) };
  } catch (err) {
    console.warn("HelixSync: could not decrypt operation, skipping", op.operationId, err);
    return undefined;
  }
}

/** Returns true when the page budget ran out with more still available. */
export async function downloadAndApply(): Promise<boolean> {
  const device = await getDevice();
  if (!device) return false;

  let sinceYield = 0;
  const resolveSdek = createSdekResolver(device.accountKey);
  // One snapshot per call: a cursor still stale right after a snapshot
  // (compaction race) must not trigger a snapshot on every page.
  let snapshotTaken = false;

  for (let page = 0; page < MAX_DOWNLOAD_PAGES_PER_CYCLE; page++) {
    const state = await getSyncState();

    let response;
    try {
      response = await downloadChanges(state.cursor);
    } catch (err) {
      if (err instanceof ApiError && err.code === "cursor_too_old") {
        // docs/protocol.md §11: the cursor is older than the server's
        // retained history, so resync from a snapshot and continue from it.
        if (snapshotTaken) throw err;
        snapshotTaken = true;
        const snapshot = await fetchSnapshot();
        await applySnapshot(snapshot, device);
        cycleMovedOps += snapshot.objects.length + snapshot.tombstones.length;
        for (const obj of snapshot.objects) {
          if (obj.objectType !== "historyVisit") cycleMovedSignificantOps++;
        }
        cycleMovedSignificantOps += snapshot.tombstones.length;
        await yieldToEventLoop();
        continue;
      }
      throw err;
    }

    cycleMovedOps += response.operations.length;
    for (const op of response.operations) {
      if (op.objectType !== "historyVisit") cycleMovedSignificantOps++;
    }

    const alreadyApplied = await getAppliedOperationIds(
      response.operations.map((op) => op.operationId),
    );

    let appliedBuffer: string[] = [];
    const flushAppliedBuffer = async () => {
      if (appliedBuffer.length === 0) return;
      await markAppliedBatch(appliedBuffer);
      appliedBuffer = [];
    };
    const markApplied = async (operationId: string) => {
      appliedBuffer.push(operationId);
      if (appliedBuffer.length >= MARK_APPLIED_CHUNK) await flushAppliedBuffer();
    };

    const batchBuffers = new Map<ObjectType, DecryptedItem[]>();
    const flushBatchBuffer = async (objectType: ObjectType) => {
      const items = batchBuffers.get(objectType);
      if (!items || items.length === 0) return;
      batchBuffers.set(objectType, []);
      await batchAppliers.get(objectType)!(items);
      for (const { op } of items) await markApplied(op.operationId);
    };
    const flushAllBatchBuffers = async () => {
      for (const objectType of [...batchBuffers.keys()]) {
        await flushBatchBuffer(objectType);
      }
    };

    for (const op of response.operations) {
      if (alreadyApplied.has(op.operationId)) continue;

      // Own history echoes would be discarded by the applier anyway, so skip
      // the decrypt. Other types' echoes still go through LWW bookkeeping.
      if (op.objectType === "historyVisit" && op.deviceId === device.deviceId) {
        await markApplied(op.operationId);
        continue;
      }

      let decrypted;
      try {
        decrypted = await decryptWithResolver(op, resolveSdek);
      } catch (err) {
        // Everything before this operation was applied; record that so the
        // retry (this page is re-downloaded, since its cursor is never
        // persisted) doesn't apply it twice. This operation and everything
        // after it stay unmarked.
        if (err instanceof UnsupportedEnvelopeVersionError) {
          await flushAllBatchBuffers();
          await flushAppliedBuffer();
        }
        throw err;
      }
      if (++sinceYield >= CRYPTO_YIELD_CHUNK) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
      if (!decrypted) {
        await markApplied(op.operationId);
        continue;
      }

      if (batchAppliers.has(op.objectType)) {
        const buffer = pushToGroup(batchBuffers, { op, payload: decrypted.payload });
        // Same crash window as the per-op path, so flushed on the same cadence.
        if (buffer.length >= MARK_APPLIED_CHUNK) await flushBatchBuffer(op.objectType);
        continue;
      }

      await dispatchToApplier(op, decrypted.payload);
      await markApplied(op.operationId);
    }
    await flushAllBatchBuffers();
    await flushAppliedBuffer();

    // An empty page with an unchanged cursor carries nothing new, so idle
    // ticks don't write IndexedDB. A moved cursor is always persisted.
    if (response.operations.length > 0 || response.nextCursor !== state.cursor) {
      // Not `{ ...state }`: applying a page can take a while, and operations
      // captured meanwhile have advanced the device sequence since `state`
      // was read. Only the cursor is ours to write.
      await updateSyncState({
        cursor: response.nextCursor,
        lastSyncAt: new Date().toISOString(),
      });
    }

    if (!response.hasMore) return false;
    await yieldToEventLoop();
  }
  return true;
}

// --- Snapshot resync ------------------------------------------------------

// A tombstone has no operationType, so it's synthesized as the type each
// applier treats as terminal (mirrors server/src/sync/vocabulary.rs).
const TERMINAL_OPERATION_TYPE: Partial<Record<ObjectType, OperationType>> = {
  bookmark: "delete",
  bookmarkFolder: "delete",
  tab: "close",
  window: "close",
  tabGroup: "delete",
  extensionStorageEntry: "delete",
};

// Never equal to a real device id. Using this device's own id would make
// the history applier discard the snapshot's visits as local echoes.
const SNAPSHOT_DEVICE_ID = "00000000-0000-0000-0000-000000000000";

// Bounds decrypted items held in memory and the size of each batch-applier call.
const SNAPSHOT_DISPATCH_CHUNK = 500;

// Tombstones touch distinct objects, so they can be applied concurrently.
const TOMBSTONE_APPLY_CONCURRENCY = 10;

function syntheticSnapshotOp(
  snapshot: SnapshotResponse,
  lamportTimestamp: number,
  fields: Pick<OperationOut, "objectType" | "objectId" | "operationType" | "encryptionVersion" | "payload">,
): OperationOut {
  return {
    operationId: uuidv7(),
    deviceId: SNAPSHOT_DEVICE_ID,
    deviceSequence: 0,
    lamportTimestamp,
    objectType: fields.objectType,
    objectId: fields.objectId,
    operationType: fields.operationType,
    encryptionVersion: fields.encryptionVersion,
    payload: fields.payload,
    serverCursor: snapshot.snapshotCursor,
    createdAt: new Date().toISOString(),
  };
}

/** docs/protocol.md §11: rebuilds local state from a full snapshot after
 * `cursor_too_old`. Objects go through the normal appliers so behavior
 * matches incremental sync; field state is cleared first so each field lands
 * unconditionally. The synthetic operationIds are random, so they are not
 * recorded in applied_operations (they could never match a server op). */
export async function applySnapshot(snapshot: SnapshotResponse, device: DeviceRecord): Promise<void> {
  // Before anything is cleared or applied: a snapshot with an unreadable
  // envelope must leave local state exactly as it was, and the cursor behind
  // the snapshot, so the whole resync is retried after an update.
  for (const obj of snapshot.objects) {
    if (obj.encryptionVersion >= 1) assertEnvelopeVersionsSupported(obj);
  }

  await clearFieldState();

  const lamportTimestamp = await tickLamportClock();

  let sinceYield = 0;
  const maybeYield = async () => {
    if (++sinceYield >= CRYPTO_YIELD_CHUNK) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  };
  const resolveSdek = createSdekResolver(device.accountKey);

  for (let start = 0; start < snapshot.objects.length; start += SNAPSHOT_DISPATCH_CHUNK) {
    const objectsChunk = snapshot.objects.slice(start, start + SNAPSHOT_DISPATCH_CHUNK);
    const decryptedByType = new Map<ObjectType, DecryptedItem[]>();

    for (const obj of objectsChunk) {
      const op = syntheticSnapshotOp(snapshot, lamportTimestamp, obj);
      const decrypted = await decryptWithResolver(op, resolveSdek);
      await maybeYield();
      if (!decrypted) continue;
      pushToGroup(decryptedByType, { op, payload: decrypted.payload });
    }

    for (const [objectType, items] of decryptedByType) {
      const batchApplier = batchAppliers.get(objectType);
      if (batchApplier) {
        await batchApplier(items);
        continue;
      }
      for (const { op, payload } of items) {
        await dispatchToApplier(op, payload);
      }
    }
  }

  for (const batch of chunk(snapshot.tombstones, TOMBSTONE_APPLY_CONCURRENCY)) {
    await Promise.all(
      batch.map(async (tombstone) => {
        // SEC-13: synthesized locally, never received from the server, so it
        // bypasses decryption; its payload is always empty.
        const op = syntheticSnapshotOp(snapshot, lamportTimestamp, {
          objectType: tombstone.objectType,
          objectId: tombstone.objectId,
          operationType: TERMINAL_OPERATION_TYPE[tombstone.objectType] ?? "delete",
          encryptionVersion: 0,
          payload: {},
        });
        await dispatchToApplier(op, op.payload);
      }),
    );
    for (let i = 0; i < batch.length; i++) await maybeYield();
  }

  await updateSyncState({
    cursor: snapshot.snapshotCursor,
    lastSyncAt: new Date().toISOString(),
  });
}

// --- Rate-limit cooldown --------------------------------------------------

// Used when a 429 has no usable Retry-After header.
const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 30;

// Epoch ms before which runSyncCycle skips entirely. Mirrored into
// chrome.storage.session so the cooldown survives a worker restart.
let syncBlockedUntil = 0;
const SYNC_BLOCKED_UNTIL_STORAGE_KEY = "syncBlockedUntil";

let syncBlockedUntilHydration: Promise<void> | undefined;

function ensureSyncBlockedUntilHydrated(): Promise<void> {
  if (!syncBlockedUntilHydration) {
    syncBlockedUntilHydration = (async () => {
      const stored = await chrome.storage.session.get(SYNC_BLOCKED_UNTIL_STORAGE_KEY);
      const value = stored[SYNC_BLOCKED_UNTIL_STORAGE_KEY];
      if (typeof value === "number") syncBlockedUntil = value;
    })();
  }
  return syncBlockedUntilHydration;
}

function setSyncBlockedUntil(value: number): Promise<void> {
  syncBlockedUntil = value;
  return chrome.storage.session
    .set({ [SYNC_BLOCKED_UNTIL_STORAGE_KEY]: value })
    .catch(() => {});
}

// Retries once the cooldown lifts, so a WebSocket push that arrives during it
// isn't lost until the next alarm. Not persisted: if the worker dies first,
// the alarm covers it.
let cooldownRetryTimer: ReturnType<typeof setTimeout> | undefined;

// A pending setTimeout keeps the worker awake; longer cooldowns are left to
// the alarm.
const SHORT_COOLDOWN_HOLD_MS = 60_000;

function scheduleCooldownRetry(): void {
  if (cooldownRetryTimer !== undefined) return;
  // A non-positive remainder just fires next tick; runSyncCycle re-checks.
  const remaining = syncBlockedUntil - Date.now();
  if (remaining > SHORT_COOLDOWN_HOLD_MS) return;
  cooldownRetryTimer = setTimeout(() => {
    cooldownRetryTimer = undefined;
    void runSyncCycle();
  }, remaining);
}

/** Called on disconnect so another account never inherits this cooldown. */
export async function clearSyncBlockedState(): Promise<void> {
  if (cooldownRetryTimer !== undefined) {
    clearTimeout(cooldownRetryTimer);
    cooldownRetryTimer = undefined;
  }
  await setSyncBlockedUntil(0);
}

// --- Sync cycle -----------------------------------------------------------

// Operations moved during the current run (upload verdicts + downloads),
// feeding the adaptive local-sync throttle.
let cycleMovedOps = 0;
// The subset that isn't history visits. Visit-only churn (e.g. an
// auto-refreshing dashboard) must not reset the backoff, or an idle device
// would keep syncing at the minimum interval indefinitely.
let cycleMovedSignificantOps = 0;

let syncInFlight = false;

// A trigger that arrives mid-cycle reruns the cycle once it finishes rather
// than being dropped, which matters most for WebSocket pushes.
let rerunRequested = false;

// Upload+download pairs chained per call when backlog remains. Bounded by
// count and wall-clock so a growing backlog can't pin the worker; progress
// is durable per batch, so the rest resumes on the next wake.
const MAX_CHAINED_CYCLES = 4;
const MAX_CHAINED_CYCLE_MS = 60_000;

export function shouldChainAnotherCycle(
  moreBacklog: boolean,
  chainedCycles: number,
  chainStartMs: number,
  nowMs: number,
): boolean {
  return moreBacklog && chainedCycles < MAX_CHAINED_CYCLES && nowMs - chainStartMs < MAX_CHAINED_CYCLE_MS;
}

// With an empty upload queue and a healthy push channel, a download poll
// gains nothing: peer changes arrive as `changes_available`. The skip only
// lasts DOWNLOAD_SKIP_WINDOW_MS after a poll that moved nothing, so even a
// silently broken channel delays peer changes by minutes, never forever.
const DOWNLOAD_SKIP_WINDOW_MS = 15 * 60_000;
let peerNotified = false;
let lastEmptyPollAt = 0;

/** Marks that a peer announced changes, so the next cycle always polls. */
export function notifyPeerChanges(): void {
  peerNotified = true;
}

function shouldSkipDownload(): boolean {
  if (peerNotified) return false;
  if (!isWebSocketConnected()) return false;
  return Date.now() - lastEmptyPollAt < DOWNLOAD_SKIP_WINDOW_MS;
}

export function resetDownloadSkipStateForTesting(): void {
  peerNotified = false;
  lastEmptyPollAt = 0;
}

export async function runSyncCycle(): Promise<void> {
  if (syncInFlight) {
    rerunRequested = true;
    return;
  }
  await ensureSyncBlockedUntilHydrated();
  if (Date.now() < syncBlockedUntil) {
    scheduleCooldownRetry();
    return;
  }
  syncInFlight = true;
  try {
    let chainedCycles = 0;
    const chainStartMs = Date.now();
    do {
      rerunRequested = false;
      cycleMovedOps = 0;
      cycleMovedSignificantOps = 0;
      emitStatus("syncing");
      try {
        const moreUpload = await uploadPending();
        let moreDownload = false;
        if (!moreUpload && (await countPendingOperations()) === 0 && shouldSkipDownload()) {
          emitStatus("idle");
        } else {
          peerNotified = false;
          moreDownload = await downloadAndApply();
          emitStatus("idle");
          if (cycleMovedOps === 0 && !moreDownload) lastEmptyPollAt = Date.now();
        }
        if (cycleMovedSignificantOps === 0) {
          emptyCycleStreak++;
        } else {
          emptyCycleStreak = 0;
        }
        if (moreUpload || moreDownload) {
          chainedCycles++;
          if (shouldChainAnotherCycle(true, chainedCycles, chainStartMs, Date.now())) {
            await yieldToEventLoop();
            rerunRequested = true;
          }
        }
      } catch (err) {
        console.error("HelixSync: sync cycle failed", err);
        if (err instanceof ApiError && err.status === 429) {
          const cooldownSeconds = err.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS;
          void setSyncBlockedUntil(Date.now() + cooldownSeconds * 1000);
          scheduleCooldownRetry();
        }
        emitStatus("error", err instanceof Error ? err.message : String(err));
        // A failed cycle moved nothing, so it extends the backoff. Triggers
        // that arrived during it wait for the next alarm or push rather than
        // hot-looping against whatever just failed.
        emptyCycleStreak++;
        rerunRequested = false;
        break;
      }
    } while (rerunRequested);
  } finally {
    // Every cycle, whatever triggered it, restarts the local-sync throttle
    // interval.
    lastLocalSyncFire = Date.now();
    syncInFlight = false;
  }
}

// --- Local-sync throttle ----------------------------------------------------

// Local changes trigger a sync shortly after they're queued instead of
// waiting for the alarm. A steady stream (auto-refreshing pages, session
// restore) is capped at one cycle per interval with a single trailing timer,
// and the interval backs off while cycles keep moving nothing. The alarm and
// WebSocket pushes bypass this throttle.
const LOCAL_SYNC_DEBOUNCE_MS = 250;
const LOCAL_SYNC_MIN_INTERVAL_MS = 10_000;
const LOCAL_SYNC_MAX_INTERVAL_MS = 60_000;
let localSyncTimer: ReturnType<typeof setTimeout> | undefined;
let lastLocalSyncFire = 0;
// Consecutive cycles with no significant movement. Every two double the
// interval, up to the max.
let emptyCycleStreak = 0;

function effectiveLocalSyncIntervalMs(): number {
  const doublings = Math.floor(emptyCycleStreak / 2);
  return Math.min(LOCAL_SYNC_MIN_INTERVAL_MS * 2 ** doublings, LOCAL_SYNC_MAX_INTERVAL_MS);
}

export function resetLocalSyncStateForTesting(): void {
  if (localSyncTimer !== undefined) {
    clearTimeout(localSyncTimer);
    localSyncTimer = undefined;
  }
  lastLocalSyncFire = 0;
  emptyCycleStreak = 0;
}

// Trailing waits longer than this aren't armed, so the worker is never held
// awake for a minute; the queue is durable and the alarm picks it up.
const SHORT_LOCAL_SYNC_HOLD_MS = 30_000;

export function scheduleLocalSync(delayMs: number = LOCAL_SYNC_DEBOUNCE_MS): void {
  const now = Date.now();
  const minInterval = effectiveLocalSyncIntervalMs();
  if (now - lastLocalSyncFire < minInterval) {
    // At most one trailing wake per interval, however many nudges arrive.
    if (localSyncTimer !== undefined) return;
    delayMs = Math.max(delayMs, minInterval - (now - lastLocalSyncFire));
    if (delayMs > SHORT_LOCAL_SYNC_HOLD_MS) return;
  } else if (localSyncTimer !== undefined) {
    clearTimeout(localSyncTimer);
  }
  localSyncTimer = setTimeout(() => {
    localSyncTimer = undefined;
    lastLocalSyncFire = Date.now();
    void runSyncCycle();
  }, delayMs);
}

export async function getPendingCount(): Promise<number> {
  return countPendingOperations();
}

export function getLocalSyncIntervalForTesting(): number {
  return effectiveLocalSyncIntervalMs();
}
