import { decryptPayload, decryptWithSdek, encryptPayload, encryptWithSdek, getSdek } from "../crypto";
import {
  clearFieldState,
  countPendingOperations,
  type DeviceRecord,
  enqueueOperation,
  enqueueOperationsBatch,
  getAppliedOperationIds,
  getDevice,
  getPendingOperations,
  getSyncState,
  markAppliedBatch,
  markUploadInFlightRecords,
  nextDeviceSequence,
  putSyncState,
  removeFromQueue,
  requeueInFlightRecords,
  reserveSequenceBatch,
  tickLamportClock,
} from "../storage/db";
import { ApiError, downloadChanges, fetchSnapshot, uploadOperations } from "../api/client";
import { isConnected as isWebSocketConnected } from "../api/websocket";
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

export type ObjectApplier = (op: OperationOut, payload: unknown) => Promise<void>;

const appliers = new Map<ObjectType, ObjectApplier>();

/** Registered by bookmarks/history/tabs modules at startup — keeps the
 * engine itself free of any chrome.* API knowledge (docs/architecture.md:
 * sync/ handles queue+cursor+conflict plumbing, not browser mutation). */
export function registerApplier(objectType: ObjectType, applier: ObjectApplier): void {
  appliers.set(objectType, applier);
}

export type BatchObjectApplier = (items: Array<{ op: OperationOut; payload: unknown }>) => Promise<void>;

const batchAppliers = new Map<ObjectType, BatchObjectApplier>();

/** Optional fast path alongside `registerApplier`, for object types whose
 * per-object IO cost is high enough that applying them one at a time risks
 * stalling/killing the service worker (for example history's browser IPC or
 * bookmark reorder reads). Both incremental downloads and snapshot dispatch
 * group by object type while preserving wire order *within* each type;
 * cross-type ordering is irrelevant (each type resolves disjoint LWW slots).
 * Most object types keep the existing per-object path. */
export function registerBatchApplier(objectType: ObjectType, applier: BatchObjectApplier): void {
  batchAppliers.set(objectType, applier);
}

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

/** Create, persist, and enqueue a new local operation for upload
 * (docs/protocol.md §15.1). The caller is responsible for having already
 * applied the change to the real browser state — HelixSync never delays
 * normal browsing to wait on this. */
export interface CreatedOperation {
  operation: LocalOperation;
  deviceId: string;
}

export async function createLocalOperation(
  objectType: ObjectType,
  objectId: string,
  operationType: OperationType,
  payload: unknown,
): Promise<CreatedOperation> {
  const device = await getDevice();
  if (!device) throw new Error("cannot create operation: no device registered");

  const deviceSequence = await nextDeviceSequence();
  const lamportTimestamp = await tickLamportClock();

  // docs/encryption.md §2: every registered device holds a REK (derived
  // from the account password at connect time), so payloads are always
  // encrypted before upload.
  const wirePayload = await encryptPayload(payload, device.encryptionRootKey, device.encryptionRootKeyVersion);

  const operation: LocalOperation = {
    operationId: uuidv7(),
    deviceSequence,
    lamportTimestamp,
    objectType,
    objectId,
    operationType,
    encryptionVersion: 1,
    payload: wirePayload,
  };

  await enqueueOperation(operation);
  return { operation, deviceId: device.deviceId };
}

export interface PendingLocalOperation {
  objectType: ObjectType;
  objectId: string;
  operationType: OperationType;
  payload: unknown;
  /** Per-hour visit-COUNT histogram (docs/protocol.md §8.3.2, sync/types.ts's
   * `LocalOperation.visitHours`) — only ever set by history/index.ts's
   * `makeVisitOperation` for a live visit (`{ [hourKey(visitTimeMs)]: 1 }`).
   * Carried through unchanged by `createLocalOperationsBatch` below. */
  visitHours?: Record<string, number>;
}

// XChaCha20-Poly1305 is pure-TS (extension/src/crypto/index.ts header) and
// runs on the single MV3 service-worker thread — there's no worker/WASM
// thread for it to run on off that thread. A bulk batch (backfill chunks up
// to MAX_UPLOAD_BATCH, or the bookmark/tab micro-batch flushes) that
// encrypts/decrypts hundreds of items back to back in one unbroken
// synchronous-ish stretch can starve everything else queued on that thread
// — popup runtime messages, other chrome.* callbacks — for the duration.
// Yielding every CRYPTO_YIELD_CHUNK items (`yieldToEventLoop`, below) bounds
// the longest uninterrupted stretch to roughly that many items' worth of
// crypto time instead of the whole batch. This does NOT make a bulk
// operation finish any sooner overall — total crypto work, and thus total
// wall-clock time, is unchanged (if anything it adds a little per yield) —
// it only breaks that work into chunks so other pending work gets a turn
// between them. 25 is smaller than MARK_APPLIED_CHUNK (50): the IndexedDB
// writes that constant chunks are comparatively cheap per item, while a
// pure-JS AEAD call is the actual expensive step here, so a tighter
// responsiveness bound is worth the extra yields.
const CRYPTO_YIELD_CHUNK = 25;

/** Batch counterpart to `createLocalOperation`, for high-volume call sites
 * with no ordering dependency between items (e.g. history backfill, where
 * every visit is an independent object). Per-item semantics are identical
 * to calling `createLocalOperation` in a loop — device sequence and lamport
 * values are still assigned strictly increasing, one per item, in array
 * order — but the sequence/lamport reservation and the queue write each
 * happen once for the whole batch instead of once per item. Encryption
 * happens in chunks of `CRYPTO_YIELD_CHUNK` with a yield between chunks
 * (see that constant) rather than one `Promise.all` over the whole batch —
 * a single `Promise.all` still runs every item's synchronous encrypt step
 * back to back via the microtask queue, without ever reaching a point where
 * a pending macrotask (e.g. a popup message) can run. */
export async function createLocalOperationsBatch(
  items: PendingLocalOperation[],
  options?: { enqueue?: boolean },
): Promise<CreatedOperation[]> {
  if (items.length === 0) return [];

  const device = await getDevice();
  if (!device) throw new Error("cannot create operation: no device registered");

  const { startDeviceSequence, startLamport } = await reserveSequenceBatch(items.length);

  // Hoist SDEK derivation once for the whole batch (see getSdek docs):
  // per-item encryptPayload would re-allocate the cache key + async hop
  // thousands of times for an identical result. The remaining per-item
  // work is synchronous AEAD, run inline with periodic yields.
  const sdek = await getSdek(device.encryptionRootKey, device.encryptionRootKeyVersion);

  const operations: LocalOperation[] = [];
  for (let start = 0; start < items.length; start += CRYPTO_YIELD_CHUNK) {
    const end = Math.min(start + CRYPTO_YIELD_CHUNK, items.length);
    for (let i = start; i < end; i++) {
      const item = items[i];
      const wirePayload = encryptWithSdek(item.payload, sdek, device.encryptionRootKeyVersion);
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

// Matches the server's own MAX_OPERATIONS_PER_BATCH (server/src/sync/routes.rs)
// so one upload request always fills to what the server will accept in one go.
const MAX_UPLOAD_BATCH = 500;

// A single sync cycle drains up to this many batches (not just one) so a large
// backlog — e.g. right after the initial bookmark/history backfill — catches
// up within a cycle or two instead of trickling in at one batch per minute.
// Bounded rather than unbounded so a batch that never actually resolves (see
// `progressed` below) can't spin the service worker forever.
const MAX_BATCHES_PER_CYCLE = 50;

// An "object_not_found" rejection is requeued rather than dropped (see
// below) because it can be a legitimate ordering race — an update uploaded
// before its own create has landed, which resolves itself once the create
// lands. But if the create was itself permanently rejected (e.g.
// `payload_too_large`) and dropped, every op depending on it requeues as
// "object_not_found" forever: it keeps the lowest device sequence in the
// queue, so it's re-fetched at the head of the queue on every call to
// `uploadPending` (`attempts` tracks this). This caps it — 20 attempts is a
// deliberately generous margin over the number of real sync cycles an
// actual ordering race takes to resolve itself, so only a genuinely
// unresolvable op ever hits it.
//
// `uploadPending` itself only ever bumps this once per call, no matter how
// many batches that call drains — see `requeuedThisCycle` below. Without
// that, a single call could re-select the same blocked op at the head of
// every subsequent batch (it's requeued back to LOCAL_QUEUED, so it's still
// there) and requeue it again each time, racing it through all 20 attempts
// in one cycle before `downloadAndApply` (which only runs after
// `uploadPending` returns) ever gets a chance to land the dependency and
// unblock it for real.
//
// Critically, `attempts` only advances when the server has explicitly,
// individually rejected an operation (the "object_not_found" requeue
// below, via `requeueInFlight(ids, true)`) — never merely because a whole
// upload request failed (network error, HTTP 429, HTTP 5xx: see the catch
// block's plain `requeueInFlight(ids)` call, and `markUploadInFlight` in
// storage/db.ts). Counting those against this threshold used to mean an
// extended outage or rate-limit window could permanently delete unsynced
// local data after ~20 retry cycles despite the server never having
// rejected a single operation (EXT-2 in review.md).
//
// Exported so engine.test.ts can assert against the real threshold instead
// of duplicating the literal 20.
export const MAX_UPLOAD_ATTEMPTS = 20;

/** Splits an upload response's per-operation rejections into "requeue" (a
 * legitimate ordering race — see the comment above MAX_UPLOAD_ATTEMPTS) vs.
 * "drop permanently" (any other reason the server explicitly rejected this
 * operation; it will never succeed by retrying as-is). Pulled out as a pure
 * function, like storage/selectors.ts's selectors, so this classification —
 * the actual "which failures may eventually delete local data" decision
 * from EXT-2 in review.md — is unit-testable without a real IndexedDB. */
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

export async function uploadPending(): Promise<boolean> {
  // Operation ids already requeued as `object_not_found` earlier in this
  // same call. Passed to `getPendingOperations` so subsequent batches skip
  // them and fetch ready operations further down the queue (preventing
  // head-of-line blocking). This also ensures we don't treat requeued
  // operations as fresh attempts within the same cycle (see the comment
  // above `MAX_UPLOAD_ATTEMPTS`). The op stays queued and simply waits for a
  // later cycle, by which point `downloadAndApply` has had a chance to run.
  const requeuedThisCycle = new Set<string>();
  // Whether the most recent fetch hit the batch limit: after exhausting
  // MAX_BATCHES_PER_CYCLE, a full final fetch means more backlog may remain
  // (returned so runSyncCycle can chain another pair immediately instead of
  // idling until the next alarm). A short final fetch proves the queue is
  // drained, so a full-but-exact multiple only costs one extra empty probe.
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
      // Nothing left to upload this round. If no stuck items were dropped,
      // no progress was made and we must exit cleanly instead of spinning
      // through remaining iterations.
      if (stuck.length === 0 || pending.length < MAX_UPLOAD_BATCH) return false;
      continue;
    }

    // Records already in hand from getPendingOperations above — use the
    // record variants to skip re-reading every row (halves IDB requests per
    // batch). `retryableById` maps server-returned ids back to those records
    // for the requeue path below.
    await markUploadInFlightRecords(retryable);
    const retryableById = new Map(retryable.map((p) => [p.operation.operationId, p]));

    let progressed = stuck.length > 0;
    try {
      const response = await uploadOperations(retryable.map((p) => p.operation));
      const resolved = [...response.accepted, ...response.duplicate];
      await removeFromQueue(resolved);
      progressed = progressed || resolved.length > 0;
      // Any server verdict (accept, duplicate, or explicit reject) means
      // this cycle moved data — feeds runSyncCycle's empty-streak throttle.
      cycleMovedOps += resolved.length + response.rejected.length;
      // ...but only non-historyVisit verdicts reset the backoff streak (see
      // `cycleMovedSignificantOps`): a visit-only upload burst is churn, not
      // activity worth staying at the minimum throttle interval for.
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

      // `true`: the server explicitly, individually rejected each of these
      // operationIds as "object_not_found" — a real per-operation verdict,
      // so it's fair (and necessary, per MAX_UPLOAD_ATTEMPTS's comment) to
      // count it as an attempt.
      if (toRequeue.length > 0) {
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
      // The request itself failed (network error, HTTP 429/5xx, etc.) —
      // the server never evaluated any of these operations individually,
      // so this must NOT count toward MAX_UPLOAD_ATTEMPTS (default `false`:
      // see requeueInFlight's doc comment / EXT-2 in review.md).
      await requeueInFlightRecords(retryable);
      throw err;
    }

    // Nothing resolved or requeued this round — stop rather than spinning.
    if (!progressed) return false;
    // Fetched fewer than a full batch: the queue is drained.
    if (pending.length < MAX_UPLOAD_BATCH) return false;
    await yieldToEventLoop();
  }
  // Ran the full batch budget — report whether more backlog may remain.
  return lastBatchFull;
}

// Mirrors MAX_BATCHES_PER_CYCLE on the upload side: one sync cycle drains up
// to this many download pages (not just one), so a large backlog — e.g. a
// peer device's bulk history backfill landing on the server — catches up
// within a cycle or two, but a backlog that doesn't fit in one cycle can't
// spin this service worker invocation forever pulling page after page.
const MAX_DOWNLOAD_PAGES_PER_CYCLE = 50;

// Granularity for flushing `applied_operations` bookkeeping writes
// (docs/protocol.md §15.6 / AI rule #8: an operation must never be
// double-applied). 1 (a transaction per op, the old behavior) makes the
// crash-safety window as tight as possible but means a 500-op page commits
// 500 individual IndexedDB transactions purely for bookkeeping. Batching
// the whole page into one transaction would cut that to 1, but widens the
// window to the whole page: if the service worker is killed after applying
// ops 1-300 but before that single commit, all 300 would be re-applied on
// restart — fine for most appliers via field-state LWW, but NOT for e.g.
// historyVisit's `applyRemote` (extension/src/history/index.ts), which adds
// a real visit and a `remote_objects` row per call and isn't idempotent
// under replay. Chunking to 50 is the tradeoff: the window widens from "1
// op" to "up to 50 ops" (bounded, still small) while cutting transaction
// count by ~50x.
const MARK_APPLIED_CHUNK = 50;

/** Per-batch SDEK resolver: bulk downloads/snapshots overwhelmingly use a
 * single key version, and deriving per operation would re-allocate the cache
 * key + async hop thousands of times for an identical result. One derivation
 * per key version for the whole batch instead. */
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

/** Decrypts one operation's payload via an already-hoisted SDEK resolver, or
 * returns `undefined` when it can't be decrypted (same skip-and-mark-applied
 * contract as `decryptOrSkip` below: an undecryptable op must not wedge the
 * download/snapshot loop). Shared by `downloadAndApply` and `applySnapshot`,
 * which both need the decrypt step separated from dispatch for batch grouping. */
async function decryptWithResolver(
  op: OperationOut,
  resolveSdek: (keyVersion: number) => Promise<Uint8Array>,
): Promise<{ payload: unknown } | undefined> {
  if (op.encryptionVersion >= 1) {
    try {
      const envelope = op.payload as Parameters<typeof decryptWithSdek>[0];
      const sdek = await resolveSdek(envelope.keyVersion);
      return { payload: decryptWithSdek(envelope, sdek) };
    } catch (err) {
      console.warn("HelixSync: could not decrypt operation, skipping", op.operationId, err);
      return undefined;
    }
  }
  return { payload: op.payload };
}

export async function downloadAndApply(): Promise<boolean> {
  const device = await getDevice();
  if (!device) return false;

  // Shared across all pages: with 50 pages x small op counts the per-page
  // reset meant thousands of decrypts with zero yields. Snapshot's
  // applySnapshot already hoists this across both its loops.
  let sinceYield = 0;
  // Hoisted SDEK resolver for the whole download (see createSdekResolver).
  const resolveSdek = createSdekResolver(device.encryptionRootKey);
  const decryptOrSkipCached = (op: OperationOut): Promise<{ payload: unknown } | undefined> =>
    decryptWithResolver(op, resolveSdek);
  // Only one snapshot fallback per call: if the cursor is still stale right
  // after a snapshot (compaction race), retrying every page would download
  // and apply up to 50 full snapshots in one cycle.
  let snapshotTaken = false;

  for (let page = 0; page < MAX_DOWNLOAD_PAGES_PER_CYCLE; page++) {
    const state = await getSyncState();

    let response;
    try {
      response = await downloadChanges(state.cursor);
    } catch (err) {
      if (err instanceof ApiError && err.code === "cursor_too_old") {
        // docs/protocol.md §11: our cursor is older than the server's
        // retained history floor (compaction already ran past it, or this
        // is a brand-new device and compaction ran ahead of it before its
        // first sync) — incremental download can never succeed from here.
        // Fall back to a full snapshot resync, then resume incrementally
        // from `snapshotCursor` on the next page.
        if (snapshotTaken) throw err;
        snapshotTaken = true;
        const snapshot = await fetchSnapshot();
        await applySnapshot(snapshot, device);
        cycleMovedOps += snapshot.objects.length + snapshot.tombstones.length;
        // History visits never produce tombstones (append-only), so every
        // tombstone is significant; objects are filtered like the download
        // path above.
        for (const obj of snapshot.objects) {
          if (obj.objectType !== "historyVisit") cycleMovedSignificantOps++;
        }
        cycleMovedSignificantOps += snapshot.tombstones.length;
        await yieldToEventLoop();
        continue;
      }
      throw err;
    }

    // Delivered operations (even ones already applied and skipped below)
    // prove peer activity — feeds runSyncCycle's empty-streak throttle.
    cycleMovedOps += response.operations.length;
    // HistoryVisit-only deliveries don't reset the backoff streak (see
    // `cycleMovedSignificantOps`).
    for (const op of response.operations) {
      if (op.objectType !== "historyVisit") cycleMovedSignificantOps++;
    }

    // Bulk pre-filter: one transaction covering every id in this page
    // instead of one `hasAppliedOperation` transaction per op (500 of
    // them, in the worst case, per page). This only skips work that's
    // already durably recorded as done — the actual bookkeeping writes for
    // ops applied *this* page still happen in bounded chunks of
    // `MARK_APPLIED_CHUNK`, not all at once at the end of the page. See
    // `MARK_APPLIED_CHUNK` above for why: one transaction for the whole
    // page would widen the "must never double-apply" crash-safety window
    // (docs/protocol.md §15.6 / AI rule #8) to the whole page instead of a
    // small bounded chunk of it.
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

    // Batch appliers receive per-type groups preserving wire order *within*
    // each type (stable partition of the page). Cross-type ordering is
    // irrelevant — each type resolves disjoint LWW slots — so unlike the old
    // contiguous-run scheme, an interleaved bookmark/tab/history page still
    // fills each type's buffer instead of flushing to size-1 batches on
    // every type switch.
    const batchBuffers = new Map<ObjectType, Array<{ op: OperationOut; payload: unknown }>>();
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

      // Own-device history echoes are discarded post-decrypt by the batch
      // applier (history/index.ts filters op.deviceId === this device) and
      // never touch field state — decrypting them first is pure AEAD CPU
      // waste on the single MV3 thread, so skip before the decrypt call.
      // Still marked applied below, so the cursor advances past them
      // exactly as if they had been decrypted and filtered later. Scoped
      // to historyVisit only: other types' own echoes still flow through
      // their appliers' LWW bookkeeping, which a skip would bypass.
      if (op.objectType === "historyVisit" && op.deviceId === device.deviceId) {
        await markApplied(op.operationId);
        continue;
      }

      const decrypted = await decryptOrSkipCached(op);
      // See CRYPTO_YIELD_CHUNK: decrypt is the expensive synchronous step in
      // this loop, so it — not just the bookkeeping flush below — needs its
      // own, tighter yield cadence.
      if (++sinceYield >= CRYPTO_YIELD_CHUNK) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
      if (!decrypted) {
        // Undecryptable: still "applied" (see decryptOrSkip), never reaches
        // a type dispatch either way.
        await markApplied(op.operationId);
        continue;
      }

      const batchApplier = batchAppliers.get(op.objectType);
      if (batchApplier) {
        let buf = batchBuffers.get(op.objectType);
        if (!buf) {
          buf = [];
          batchBuffers.set(op.objectType, buf);
        }
        buf.push({ op, payload: decrypted.payload });
        // Same bound as appliedBuffer/MARK_APPLIED_CHUNK above — a batch
        // applier call plus its items' bookkeeping writes is exactly the
        // same "applied but not yet durably marked" crash-safety window as
        // the single-item path, just for a batch instead of one op, so it
        // gets flushed on the same cadence rather than accumulating for the
        // rest of the page.
        if (buf.length >= MARK_APPLIED_CHUNK) await flushBatchBuffer(op.objectType);
        continue;
      }

      const applier = appliers.get(op.objectType);
      if (applier) {
        await applier(op, decrypted.payload);
      } else {
        // Same "unknown/unsupported object type" handling as applySnapshot's
        // dispatch loop (see its comment) — never silently apply, but don't
        // crash the batch, and mark applied so it isn't retried forever.
        console.warn("HelixSync: no applier registered for object type", op.objectType);
      }
      await markApplied(op.operationId);
    }
    // Flush whatever's left below the chunk threshold in either buffer —
    // otherwise a partial chunk at the end of a page (or a page smaller than
    // MARK_APPLIED_CHUNK entirely) would never get durably recorded before
    // the cursor advances below.
    await flushAllBatchBuffers();
    await flushAppliedBuffer();

    // Idle-tick fast path (perf): an empty page whose cursor did not advance
    // carries no new information — skip the write and leave lastSyncAt alone
    // instead of dirtying IndexedDB on every one of the 288 daily alarm
    // ticks with zero data. Still persists whenever the cursor moved (the
    // server can advance it with no deliverable ops, e.g. compaction) so a
    // moved cursor is never re-fetched forever.
    if (response.operations.length > 0 || response.nextCursor !== state.cursor) {
      await putSyncState({
        ...state,
        cursor: response.nextCursor,
        lastSyncAt: new Date().toISOString(),
      });
    }

    if (!response.hasMore) return false;
    await yieldToEventLoop();
  }
  // Ran the full page budget with the last page still reporting more.
  return true;
}

/** Decrypts one operation's payload, or returns `undefined` if it can't be
 * (see the catch block below for why that's still "applied"). Shared by
 * `applyOneRemote` (now only used for applySnapshot's tombstone loop, which
 * has no batching to do), and inlined directly into both `downloadAndApply`
 * and applySnapshot's main dispatch loops — both need the decrypt step
 * separated from the apply step so they can group decrypted items by object
 * type before dispatching, which calling through `applyOneRemote` (decrypt
 * *and* apply in one call) wouldn't allow. */
async function decryptOrSkip(op: OperationOut, rek: string): Promise<{ payload: unknown } | undefined> {
  if (op.encryptionVersion >= 1) {
    try {
      return { payload: await decryptPayload(op.payload as never, rek) };
    } catch (err) {
      // Undecryptable data: this operation was encrypted under a REK this
      // device doesn't hold — almost always old data from before an
      // account password change, or from before this account switched to
      // password-derived keys (docs/encryption.md §4-5). Unlike an unknown
      // object type below, there is no future event that fixes this (no
      // "wait for authorization" to retry), so leaving it unapplied would
      // wedge the outer download loop forever: the cursor only advances
      // once every operation in a batch resolves, so a single
      // permanently-undecryptable operation would silently block every
      // *other* operation after it — including new data — from ever
      // syncing to this device again. Losing this one object's history is
      // the lesser failure, so it's marked applied (by the caller) and
      // skipped.
      console.warn("HelixSync: could not decrypt operation, skipping", op.operationId, err);
      return undefined;
    }
  }
  return { payload: op.payload };
}

/** Applies one remote operation (decrypts and invokes registered applier).
 * Only used for applySnapshot's tombstone loop now — `downloadAndApply` and
 * applySnapshot's main object dispatch inline the same decrypt/apply/warn steps
 * directly instead of calling this, since they need to group items by object
 * type for a registered batch applier first (see `registerBatchApplier`), which
 * this single-op, single-type function has no way to do. This one never needs
 * to, since a tombstone's applier is always the terminal-operation one-at-a-time
 * path regardless of whether a batch applier exists for that type (a delete is
 * comparatively rare and cheap next to a bulk snapshot's create volume, so it
 * was never worth batching). */
async function applyOneRemote(op: OperationOut, rek: string): Promise<void> {
  const decrypted = await decryptOrSkip(op, rek);
  if (!decrypted) return;
  const { payload } = decrypted;

  const applier = appliers.get(op.objectType);
  if (!applier) {
    // Unknown/unsupported object type: protocol compatibility rule — never
    // silently apply, but don't crash the batch either.
    console.warn("HelixSync: no applier registered for object type", op.objectType);
    return;
  }

  await applier(op, payload);
}

// A snapshot object's `operationType` is the true originating type for
// field-merge types (bookmark/bookmarkFolder always report "create" — see
// server/src/sync/routes.rs::combine_object) or whole-object-LWW winner
// type otherwise, so it's applied as-is. A tombstone, though, carries no
// operationType at all (server/src/sync/model.rs's SnapshotTombstone is
// just objectType+objectId) — this maps each object type to whichever
// operationType its applier treats as terminal, mirroring the server's own
// vocabulary::is_terminal_operation (server/src/sync/vocabulary.rs), so a
// synthesized delete op actually reaches the same code path a real
// incremental "close"/"delete" would.
const TERMINAL_OPERATION_TYPE: Partial<Record<ObjectType, OperationType>> = {
  bookmark: "delete",
  bookmarkFolder: "delete",
  tab: "close",
  window: "close",
  tabGroup: "delete",
  extensionStorageEntry: "delete",
};

// Sentinel deviceId for every operation synthesized from a snapshot —
// deliberately never equal to any real device's id (those come from
// uuidv7() elsewhere). Using this device's own id here would be wrong: e.g.
// history/index.ts's applier skips recording a visit as "from another
// device" whenever `op.deviceId === (this device)`, and a snapshot's whole
// point is importing history that mostly did NOT originate here.
const SNAPSHOT_DEVICE_ID = "00000000-0000-0000-0000-000000000000";

// Bounds how many decrypted `{ op, payload }` items are held in memory at
// once while processing a snapshot's object list — the same memory-bounding
// concern history/index.ts's BACKFILL_FLUSH_CHUNK addresses for a similarly
// large bulk operation. Also caps how many items a single registered batch
// applier (see `registerBatchApplier`) is ever handed in one call, so a
// batch applier's own internal batching and this file's memory use are
// bounded identically regardless of how large the snapshot itself is.
const SNAPSHOT_DISPATCH_CHUNK = 500;

/** docs/protocol.md §11: reconciles local state against a full snapshot
 * after `downloadChanges` reports `cursor_too_old` — the only way back for
 * a device whose cursor has fallen behind the server's retained history.
 * Every field is applied through the same per-object-type appliers normal
 * incremental sync uses (so materialization, deferred-parent handling, tab
 * restore policy, etc. all behave identically either way); the only
 * difference is that `field_state` is wiped first, per `clearFieldState`'s
 * own docs, so each field lands unconditionally instead of via a numeric
 * ordering-key comparison against data that predates the snapshot.
 *
 * Note on applied_operations (EXT-02): unlike incremental downloadAndApply,
 * snapshot objects and tombstones do not record synthetic operationIds into
 * applied_operations. Because synthetic UUIDs are generated randomly on the
 * client, server operations will never match them, so persisting them would
 * cause write amplification and phantom key bloat. */
export async function applySnapshot(snapshot: SnapshotResponse, device: DeviceRecord): Promise<void> {
  await clearFieldState();

  const lamportTimestamp = await tickLamportClock();

  // Shared across both loops below (see CRYPTO_YIELD_CHUNK) — a snapshot's
  // object list and tombstone list are really one long bulk-decrypt stretch
  // from the thread's perspective, so the yield cadence spans both rather
  // than resetting at the object/tombstone boundary.
  let sinceYield = 0;
  const maybeYield = async () => {
    if (++sinceYield >= CRYPTO_YIELD_CHUNK) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  };
  // Same hoisted-SDEK rationale as downloadAndApply (see
  // createSdekResolver): one derivation per keyVersion for the whole
  // snapshot instead of one per object.
  const resolveSnapshotSdek = createSdekResolver(device.encryptionRootKey);
  const decryptSnapshotOp = (op: OperationOut): Promise<{ payload: unknown } | undefined> =>
    decryptWithResolver(op, resolveSnapshotSdek);

  // Outer chunking (SNAPSHOT_DISPATCH_CHUNK) bounds memory; within each
  // chunk, objects are first all decrypted (same yield cadence as before —
  // see maybeYield/CRYPTO_YIELD_CHUNK), then grouped by objectType so any
  // type with a registered batch applier (currently only "historyVisit",
  // see history/index.ts) is dispatched in one call per chunk instead of
  // one call per object. Every other type falls through to the same
  // one-at-a-time dispatch `applyOneRemote` used to do, just with the
  // decrypt step already done above.
  for (let start = 0; start < snapshot.objects.length; start += SNAPSHOT_DISPATCH_CHUNK) {
    const chunk = snapshot.objects.slice(start, start + SNAPSHOT_DISPATCH_CHUNK);
    const decryptedByType = new Map<ObjectType, Array<{ op: OperationOut; payload: unknown }>>();

    for (const obj of chunk) {
      const op: OperationOut = {
        operationId: uuidv7(),
        deviceId: SNAPSHOT_DEVICE_ID,
        deviceSequence: 0,
        lamportTimestamp,
        objectType: obj.objectType,
        objectId: obj.objectId,
        operationType: obj.operationType,
        encryptionVersion: obj.encryptionVersion,
        payload: obj.payload,
        serverCursor: snapshot.snapshotCursor,
        createdAt: new Date().toISOString(),
      };
      const decrypted = await decryptSnapshotOp(op);
      await maybeYield();
      if (!decrypted) {
        // Undecryptable: skipped without reaching a type dispatch.
        // Unlike incremental download, we do not record synthetic operationIds
        // into applied_operations (EXT-02) as they have zero cache hits and bloat storage.
        continue;
      }
      let group = decryptedByType.get(op.objectType);
      if (!group) {
        group = [];
        decryptedByType.set(op.objectType, group);
      }
      group.push({ op, payload: decrypted.payload });
    }

    for (const [objectType, items] of decryptedByType) {
      const batchApplier = batchAppliers.get(objectType);
      if (batchApplier) {
        // Never more than SNAPSHOT_DISPATCH_CHUNK items in one call — see
        // that constant's comment.
        await batchApplier(items);
        continue;
      }

      const applier = appliers.get(objectType);
      for (const { op, payload } of items) {
        if (applier) {
          await applier(op, payload);
        } else {
          // Same "unknown/unsupported object type" handling as
          // applyOneRemote: never silently apply, but don't crash the
          // batch either.
          console.warn("HelixSync: no applier registered for object type", op.objectType);
        }
      }
    }
  }

  // Tombstones touch distinct objects (each applier only resolves its own
  // object's liveness plus its own mapping/remote_object rows — a parent/child
  // pair racing just converges via applyDelete's already-gone tolerance), so
  // unlike the object loop above they need no cross-item ordering. Applied
  // with bounded concurrency instead of strictly one at a time: each item pays
  // its own field-state transaction plus a chrome IPC round trip, and a large
  // snapshot's tombstone tail used to serialize all of that.
  const TOMBSTONE_APPLY_CONCURRENCY = 10;

  for (const batch of chunk(snapshot.tombstones, TOMBSTONE_APPLY_CONCURRENCY)) {
    await Promise.all(
      batch.map(async (tombstone) => {
        const op: OperationOut = {
          operationId: uuidv7(),
          deviceId: SNAPSHOT_DEVICE_ID,
          deviceSequence: 0,
          lamportTimestamp,
          objectType: tombstone.objectType,
          objectId: tombstone.objectId,
          operationType: TERMINAL_OPERATION_TYPE[tombstone.objectType] ?? "delete",
          encryptionVersion: 0,
          payload: {},
          serverCursor: snapshot.snapshotCursor,
          createdAt: new Date().toISOString(),
        };
        await applyOneRemote(op, device.encryptionRootKey);
      }),
    );
    for (let i = 0; i < batch.length; i++) await maybeYield();
  }

  await putSyncState({
    ...(await getSyncState()),
    cursor: snapshot.snapshotCursor,
    lastSyncAt: new Date().toISOString(),
  });
}

// Fallback cooldown (in seconds, to match ApiError.retryAfterSeconds'
// unit) when the server returns 429 with no (or an unparseable)
// Retry-After header — see ApiError.retryAfterSeconds in api/client.ts for
// why that case is left `undefined` rather than guessed at that layer.
// 30s is a conservative "don't hammer it" default, well under the
// WebSocket connect path's own max backoff (MAX_RECONNECT_DELAY_MS in
// api/websocket.ts) but long enough to actually matter against the
// 1-minute periodic alarm.
const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 30;

// Epoch ms before which runSyncCycle should skip entirely rather than hit
// the server again. Same in-memory-mirror + write-through-to-
// chrome.storage.session pattern as api/websocket.ts's reconnectDelayMs
// (see the comment block above that variable for the full rationale): a
// plain module-level `let` alone would be wiped by the MV3 service worker
// being torn down after ~30s idle, which happens well inside both the
// 1-minute sync alarm interval and any realistic Retry-After wait, so a
// cooldown set on one invocation would silently vanish before the next
// trigger arrives instead of actually suppressing it. chrome.storage.session
// (not .local) since this, like the reconnect delay, is meant to live only
// for the browser session and never touch disk.
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

/** Updates the sync mirror immediately (so the very next runSyncCycle call
 * sees it) and write-throughs to storage.session in the background, mirroring
 * setReconnectDelayMs in api/websocket.ts. */
function setSyncBlockedUntil(value: number): Promise<void> {
  syncBlockedUntil = value;
  return chrome.storage.session
    .set({ [SYNC_BLOCKED_UNTIL_STORAGE_KEY]: value })
    .catch(() => {});
}

// A cooldown started by a 429 (syncBlockedUntil, above) blocks runSyncCycle
// from actually hitting the server again — but by itself that just makes
// every trigger that arrives during the cooldown return immediately with
// nothing scheduled to try again once it lifts. The alarm eventually covers
// that (see background/index.ts's periodic alarm), but for a WS
// `changes_available` push specifically that defeats the entire point of
// the push: it exists to shortcut the wait for the 1-minute alarm, and a
// push that arrives mid-cooldown would otherwise be silently dropped,
// leaving the change to sit unsynced for up to a minute even though the
// cooldown itself is typically much shorter (30s by default). This timer is
// the fix: schedule a single retry for the moment the cooldown actually
// lifts.
//
// Deliberately NOT persisted, unlike syncBlockedUntil itself. There is no
// chrome-extension-API equivalent of "resume this exact setTimeout after a
// service worker restart" short of chrome.alarms, which only supports
// minute-granularity alarms — overkill here, and redundant with the
// existing 1-minute periodic alarm already in background/index.ts. If the
// service worker is torn down before this timer fires, it simply never
// fires; that's fine, because that same periodic alarm (documented there as
// "the one wake path guaranteed to survive a service worker restart") will
// eventually call runSyncCycle() again regardless, which re-hydrates
// syncBlockedUntil from chrome.storage.session and behaves correctly either
// way. This timer is purely a latency optimization layered on top of that
// already-guaranteed backstop, not a replacement for it.
let cooldownRetryTimer: ReturnType<typeof setTimeout> | undefined;

// Guards against piling up redundant timers: several triggers (e.g.
// multiple WS pushes) can each call runSyncCycle while the same cooldown is
// active. The first call already scheduled a retry for the correct (and
// only) wake-up instant, so later calls during that same window just no-op
// here and fall through to the same early return as always.
function scheduleCooldownRetry(): void {
  if (cooldownRetryTimer !== undefined) return;
  const remaining = syncBlockedUntil - Date.now();
  // `remaining` could in theory be <= 0 here (a race between the
  // Date.now() check in runSyncCycle and this one, microseconds later) —
  // setTimeout with a non-positive delay just fires on the next tick, which
  // is harmless: runSyncCycle re-checks the deadline and proceeds normally.
  //
  // A pending setTimeout pins the service worker awake for the whole
  // cooldown. Long cooldowns don't need that: the periodic sync alarm calls
  // runSyncCycle() anyway and re-hydrates syncBlockedUntil from
  // chrome.storage.session. Only hold the worker for short waits where the
  // alarm would add noticeable latency.
  const SHORT_COOLDOWN_HOLD_MS = 60_000;
  if (remaining > SHORT_COOLDOWN_HOLD_MS) return;
  cooldownRetryTimer = setTimeout(() => {
    cooldownRetryTimer = undefined;
    void runSyncCycle();
  }, remaining);
}

/** Called on device disconnect so a stale rate-limit cooldown (and any timer
 * scheduled to retry once it lifts) doesn't linger against an
 * account/server this device no longer holds credentials for — same
 * reasoning, and the same await-before-returning pattern, as `disconnect` in
 * api/websocket.ts. */
export async function clearSyncBlockedState(): Promise<void> {
  if (cooldownRetryTimer !== undefined) {
    clearTimeout(cooldownRetryTimer);
    cooldownRetryTimer = undefined;
  }
  await setSyncBlockedUntil(0);
}

// Operations moved by the current chained run (uploaded verdicts +
// delivered downloads) — reset at each run, read once per run to maintain
// `emptyCycleStreak` for the adaptive local-sync throttle above.
let cycleMovedOps = 0;
// Subset of `cycleMovedOps` that counts toward resetting the backoff streak:
// a sustained stream of historyVisit-only movement (an auto-refreshing
// dashboard producing a visit burst every few seconds) must NOT reset it,
// or the throttle sits at its 10s floor forever and the device runs ~6
// cycles/min indefinitely while the user is idle. History visits are
// append-only and never materialized promptly on peers, so treating them as
// "empty" for throttle purposes only spaces out self-inflicted retries.
let cycleMovedSignificantOps = 0;

let syncInFlight = false;

// Set when a trigger (WS push, alarm, manual "Sync Now") arrives while a
// cycle is already running. Without this, that trigger was simply dropped
// (the early `return` below) — harmless for the alarm (it just tries again
// next tick) but for a WS push it meant the exact case the push channel
// exists for (another device's changes just landed) got silently ignored
// whenever this device happened to be busy, leaving it to wait out the
// full alarm interval anyway. The already-running cycle checks this flag
// once it finishes and loops again if set, so a trigger during a busy
// cycle is deferred rather than lost, without spinning unboundedly (each
// rerun consumes the flag; it can only be set again by a new trigger).
let rerunRequested = false;

// Bounds how many upload+download pairs one runSyncCycle call chains when a
// backlog doesn't fit in a single pair's budgets (MAX_BATCHES_PER_CYCLE /
// MAX_DOWNLOAD_PAGES_PER_CYCLE): each extra pair is another ~25k ops of
// catch-up without waiting a full minute for the next alarm — a 100k-visit
// backfill converges in one awake stretch instead of four. Bounded rather
// than unbounded so a continuously-growing backlog can't pin the service
// worker forever; progress is durable per batch/page (queue removals,
// cursor advances), so whatever doesn't fit resumes on the next alarm or
// push exactly where this left off.
const MAX_CHAINED_CYCLES = 4;

// Wall-clock companion to MAX_CHAINED_CYCLES above: 4 full pairs of 500-op
// crypto + IndexedDB + HTTPS + browser IPC can exceed a minute on a slow
// machine, risking an MV3 mid-chain kill (which just resumes next wake, but
// wastes the partial chain's time). The count bound alone can't see that —
// stop chaining once the run itself is this old regardless of remaining
// budget. Pure-predicate form below (shouldChainAnotherCycle) so the rule
// is unit-testable without a running worker.
const MAX_CHAINED_CYCLE_MS = 60_000;

/** Chaining rule for runSyncCycle: more backlog known to be waiting, count
 * budget left, and wall-clock budget left. `nowMs` is a parameter (rather
 * than read here) so tests can drive the time budget deterministically. */
export function shouldChainAnotherCycle(
  moreBacklog: boolean,
  chainedCycles: number,
  chainStartMs: number,
  nowMs: number,
): boolean {
  return moreBacklog && chainedCycles < MAX_CHAINED_CYCLES && nowMs - chainStartMs < MAX_CHAINED_CYCLE_MS;
}

// Idle-download skip (perf): an alarm tick with an empty upload queue and a
// healthy WebSocket push channel gains nothing from a download poll — any
// peer change arrives as `changes_available` and triggers a cycle promptly
// via `notifyPeerChanges` below. Skipping it removes the last per-tick HTTPS
// on an idle, connected device (the upload probe already returns before any
// network call when the queue is empty). Bounded staleness instead of
// unbounded trust: the skip only applies within DOWNLOAD_SKIP_WINDOW_MS of
// the last poll that provably moved nothing, so even a silently wedged push
// channel delays peer visibility by minutes, never indefinitely — and any
// disconnect (`isWebSocketConnected() === false`) or push notification
// disables the skip immediately. The upload path is never skipped.
const DOWNLOAD_SKIP_WINDOW_MS = 15 * 60_000;
let peerNotified = false;
let lastEmptyPollAt = 0;

/** Called by background/index.ts's `changes_available` handler alongside
 * `scheduleLocalSync`: records that a peer change was announced so the next
 * cycle polls even if it would otherwise qualify for the idle skip. */
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
  // A prior cycle (possibly in an earlier service-worker instance) hit a
  // 429 and set a cooldown — skip entirely rather than hitting the server
  // again immediately, the same way the existing `syncInFlight` check just
  // above skips a cycle that's already running. This is on top of, not
  // instead of, the "don't hot-loop on a failing cycle" behavior below:
  // that one only covers the trigger that arrives *during* a failing
  // cycle, not one that arrives afterward while the cooldown is still in
  // effect.
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
        // Idle fast path (perf): queue drained and nothing announced by push
        // with a healthy channel recently polled empty — skip the download
        // poll (see shouldSkipDownload). Uploads are never skipped; a skipped
        // tick still reports idle and feeds the throttle streak as empty.
        let moreDownload = false;
        if (!moreUpload && (await countPendingOperations()) === 0 && shouldSkipDownload()) {
          emitStatus("idle");
        } else {
          peerNotified = false;
          moreDownload = await downloadAndApply();
          emitStatus("idle");
          if (cycleMovedOps === 0 && !moreDownload) lastEmptyPollAt = Date.now();
        }
        // Adaptive throttle input (see effectiveLocalSyncIntervalMs): a run
        // with no significant movement extends the streak, significant
        // movement resets it. HistoryVisit-only movement counts as empty
        // (see `cycleMovedSignificantOps`) so steady visit churn backs off
        // instead of pinning the minimum interval.
        if (cycleMovedSignificantOps === 0) {
          emptyCycleStreak++;
        } else {
          emptyCycleStreak = 0;
        }
        if (moreUpload || moreDownload) {
          chainedCycles++;
          if (shouldChainAnotherCycle(true, chainedCycles, chainStartMs, Date.now())) {
            // More backlog is already known to be waiting — loop again
            // immediately (after a yield) instead of idling until the next
            // alarm/push. Everything so far is already durable, so a kill
            // mid-chain simply resumes from here on the next wake.
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
        // A failing cycle moved nothing either — count it toward the streak
        // so offline/4xx storms also back off (the 5-minute alarm still
        // retries regardless). Don't hot-loop retrying against whatever just
        // failed (e.g. the network being down) — a trigger that arrived
        // during a failing cycle waits for the next alarm/push like it
        // always did.
        emptyCycleStreak++;
        rerunRequested = false;
        break;
      }
    } while (rerunRequested);
  } finally {
    // Feed the local-sync throttle clock from every cycle origin (alarm,
    // WS-debounced, manual), not just debounced nudges: otherwise a local
    // burst right after an alarm fires immediately instead of respecting
    // the min-interval the alarm just satisfied.
    lastLocalSyncFire = Date.now();
    syncInFlight = false;
  }
}

// Debounces bookmark/tab/history flushes into one runSyncCycle() call instead of
// waiting up to 60s for SYNC_ALARM. Plain setTimeout is fine: the worker is alive
// right after a flush, and if it's torn down first, pending_operations already
// has the data for the next alarm/WS/manual trigger to pick up.
//
// The debounce alone is not enough: a steady stream of history visits (an
// auto-refreshing dashboard, SPA churn, session restore) re-arms it every few
// seconds, producing one full sync cycle (upload probe + download GET + cursor
// write) per burst indefinitely while the user is idle. MIN_INTERVAL keeps the
// latency win for isolated changes (first nudge still fires after ~250ms) but
// collapses a sustained stream into at most one cycle per interval, with a
// single trailing timer covering whatever arrived mid-interval.
const LOCAL_SYNC_DEBOUNCE_MS = 250;
const LOCAL_SYNC_MIN_INTERVAL_MS = 10_000;
// Upper bound for the adaptive backoff below: even a long-idle device still
// nudges at least this often on local activity (the 5-minute alarm and
// WebSocket pushes bypass this throttle entirely, so peer latency never
// depends on it).
const LOCAL_SYNC_MAX_INTERVAL_MS = 60_000;
let localSyncTimer: ReturnType<typeof setTimeout> | undefined;
let lastLocalSyncFire = 0;
// Consecutive sync cycles that moved zero operations in either direction
// (measured: an auto-refreshing dashboard sustains ~6 empty cycles/min
// through this throttle). Each pair of empties doubles the throttle above
// up to the max; any cycle that actually moves data resets it. Error paths
// count as empty (a failing cycle moved nothing either) — the alarm still
// retries every 5 minutes regardless, so this only spaces out the
// self-inflicted retries, never peer-driven sync.
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

// A pending setTimeout pins the service worker awake for the whole delay —
// same concern as SHORT_RECONNECT_HOLD_MS (api/websocket.ts) and
// SHORT_COOLDOWN_HOLD_MS above. Trailing waits longer than this are not
// armed: the queue is durable in pending_operations, so the 5-minute
// periodic alarm picks it up. Trade-off: a trailing burst that lands in the
// deepest backoff state waits for the next alarm instead of the exact
// interval end, in exchange for never holding the worker awake for ~a minute.
const SHORT_LOCAL_SYNC_HOLD_MS = 30_000;

export function scheduleLocalSync(delayMs: number = LOCAL_SYNC_DEBOUNCE_MS): void {
  const now = Date.now();
  const minInterval = effectiveLocalSyncIntervalMs();
  if (now - lastLocalSyncFire < minInterval) {
    // A cycle fired recently: don't start another one yet. At most one
    // trailing wake is armed for the whole interval, no matter how many
    // flushes land meanwhile.
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

/** Visible for testing: the throttle interval scheduleLocalSync currently
 * enforces, given the empty-cycle streak. */
export function getLocalSyncIntervalForTesting(): number {
  return effectiveLocalSyncIntervalMs();
}
