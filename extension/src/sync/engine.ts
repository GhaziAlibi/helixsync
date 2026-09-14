import { decryptPayload, encryptPayload } from "../crypto";
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
  markUploadInFlight,
  nextDeviceSequence,
  putSyncState,
  removeFromQueue,
  requeueInFlight,
  reserveSequenceBatch,
  tickLamportClock,
} from "../storage/db";
import { ApiError, downloadChanges, fetchSnapshot, uploadOperations } from "../api/client";
import type { LocalOperation, ObjectType, OperationOut, OperationType, SnapshotResponse } from "./types";
import { uuidv7 } from "../util/uuid";
import { yieldToEventLoop } from "../util/yield";

export type ObjectApplier = (op: OperationOut, payload: unknown) => Promise<void>;

const appliers = new Map<ObjectType, ObjectApplier>();

/** Registered by bookmarks/history/tabs modules at startup — keeps the
 * engine itself free of any chrome.* API knowledge (docs/architecture.md:
 * sync/ handles queue+cursor+conflict plumbing, not browser mutation). */
export function registerApplier(objectType: ObjectType, applier: ObjectApplier): void {
  appliers.set(objectType, applier);
}

export type SyncStatus = "idle" | "syncing" | "error" | "needs_reauth";

let listeners: Array<(status: SyncStatus, detail?: string) => void> = [];
export function onStatusChange(cb: (status: SyncStatus, detail?: string) => void): void {
  listeners.push(cb);
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
): Promise<CreatedOperation[]> {
  if (items.length === 0) return [];

  const device = await getDevice();
  if (!device) throw new Error("cannot create operation: no device registered");

  const { startDeviceSequence, startLamport } = await reserveSequenceBatch(items.length);

  const operations: LocalOperation[] = [];
  for (let start = 0; start < items.length; start += CRYPTO_YIELD_CHUNK) {
    const chunk = items.slice(start, start + CRYPTO_YIELD_CHUNK);
    const chunkOperations = await Promise.all(
      chunk.map(async (item, j): Promise<LocalOperation> => {
        const i = start + j;
        const wirePayload = await encryptPayload(
          item.payload,
          device.encryptionRootKey,
          device.encryptionRootKeyVersion,
        );
        return {
          operationId: uuidv7(),
          deviceSequence: startDeviceSequence + i + 1,
          lamportTimestamp: startLamport + i + 1,
          objectType: item.objectType,
          objectId: item.objectId,
          operationType: item.operationType,
          encryptionVersion: 1,
          payload: wirePayload,
        };
      }),
    );
    operations.push(...chunkOperations);
    if (start + CRYPTO_YIELD_CHUNK < items.length) await yieldToEventLoop();
  }

  await enqueueOperationsBatch(operations);
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
// queue, so it's re-fetched at the head of every batch of every cycle
// (`attempts` already tracks this, previously unread anywhere). This caps
// it — 20 attempts is a deliberately generous margin over the minutes an
// actual ordering race takes to resolve itself, so only a genuinely
// unresolvable op ever hits it.
const MAX_UPLOAD_ATTEMPTS = 20;

export async function uploadPending(): Promise<void> {
  for (let batch = 0; batch < MAX_BATCHES_PER_CYCLE; batch++) {
    const pending = await getPendingOperations(MAX_UPLOAD_BATCH);
    if (pending.length === 0) return;

    const stuck = pending.filter((p) => p.attempts >= MAX_UPLOAD_ATTEMPTS);
    if (stuck.length > 0) {
      console.error(
        "HelixSync: dropping operations stuck after max upload attempts",
        stuck.map((p) => p.operation.operationId),
      );
      await removeFromQueue(stuck.map((p) => p.operation.operationId));
    }
    const retryable = pending.filter((p) => p.attempts < MAX_UPLOAD_ATTEMPTS);

    if (retryable.length === 0) {
      // Nothing left to upload this round, but dropping `stuck` above still
      // counts as progress, and there may be more queued beyond this batch.
      if (pending.length < MAX_UPLOAD_BATCH) return;
      continue;
    }

    const ids = retryable.map((p) => p.operation.operationId);
    await markUploadInFlight(ids);

    let progressed = stuck.length > 0;
    try {
      const response = await uploadOperations(retryable.map((p) => p.operation));
      const resolved = [...response.accepted, ...response.duplicate];
      await removeFromQueue(resolved);
      progressed = progressed || resolved.length > 0;

      for (const rejection of response.rejected) {
        // Permanent client-side errors: drop rather than retry forever.
        // "object_not_found" can be a legitimate ordering race (an update
        // uploaded before its create landed) so it's requeued instead.
        if (rejection.reason === "object_not_found") {
          await requeueInFlight([rejection.operationId]);
        } else {
          await removeFromQueue([rejection.operationId]);
          progressed = true;
          console.error("HelixSync: dropping operation after rejection", rejection);
        }
      }
    } catch (err) {
      await requeueInFlight(ids);
      throw err;
    }

    // Nothing resolved this round (e.g. every operation is an
    // object-not-found requeue waiting on a parent that hasn't landed yet) —
    // stop rather than spinning on the same stuck batch.
    if (!progressed) return;
    // Fetched fewer than a full batch: the queue is drained.
    if (pending.length < MAX_UPLOAD_BATCH) return;
  }
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

export async function downloadAndApply(): Promise<void> {
  const device = await getDevice();
  if (!device) return;

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
        const snapshot = await fetchSnapshot();
        await applySnapshot(snapshot, device);
        continue;
      }
      throw err;
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
    let sinceYield = 0;
    for (const op of response.operations) {
      if (alreadyApplied.has(op.operationId)) continue;
      appliedBuffer.push(await applyOneRemote(op, device.encryptionRootKey));
      if (appliedBuffer.length >= MARK_APPLIED_CHUNK) {
        await markAppliedBatch(appliedBuffer);
        appliedBuffer = [];
      }
      // See CRYPTO_YIELD_CHUNK: applyOneRemote's decrypt is the expensive
      // synchronous step in this loop, so it — not just the bookkeeping
      // flush above — needs its own, tighter yield cadence.
      if (++sinceYield >= CRYPTO_YIELD_CHUNK) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }
    // Flush whatever's left below the chunk threshold — otherwise a
    // partial chunk at the end of a page (or a page smaller than
    // MARK_APPLIED_CHUNK entirely) would never get durably recorded before
    // the cursor advances below.
    if (appliedBuffer.length > 0) {
      await markAppliedBatch(appliedBuffer);
    }

    await putSyncState({
      ...state,
      cursor: response.nextCursor,
      lastSyncAt: new Date().toISOString(),
    });

    if (!response.hasMore) return;
  }
}

/** Applies one remote operation and returns its operationId for the caller
 * to feed into the chunked `markAppliedBatch` bookkeeping (this function no
 * longer marks applied itself — see `MARK_APPLIED_CHUNK` for why that's now
 * the caller's responsibility). Every path through this function — success,
 * undecryptable payload, unknown object type — ends the same way: the op is
 * considered done and must eventually be recorded as applied, so it always
 * returns `op.operationId` rather than signaling "skip". Ordering is
 * preserved: by the time this function returns, the applier (if any) has
 * already run and its own writes (if it makes any) are committed — only
 * *when the bookkeeping transaction commits* is deferred, not the
 * sequencing of "apply then eventually mark". */
async function applyOneRemote(op: OperationOut, rek: string): Promise<string> {
  let payload: unknown;
  if (op.encryptionVersion >= 1) {
    try {
      payload = await decryptPayload(op.payload as never, rek);
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
      return op.operationId;
    }
  } else {
    payload = op.payload;
  }

  const applier = appliers.get(op.objectType);
  if (!applier) {
    // Unknown/unsupported object type: protocol compatibility rule — never
    // silently apply, but don't crash the batch either. Mark as applied (by
    // the caller) so we don't retry forever; it is recoverable later via
    // full resync if a future version adds support.
    console.warn("HelixSync: no applier registered for object type", op.objectType);
    return op.operationId;
  }

  await applier(op, payload);
  return op.operationId;
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

/** docs/protocol.md §11: reconciles local state against a full snapshot
 * after `downloadChanges` reports `cursor_too_old` — the only way back for
 * a device whose cursor has fallen behind the server's retained history.
 * Every field is applied through the same per-object-type appliers normal
 * incremental sync uses (so materialization, deferred-parent handling, tab
 * restore policy, etc. all behave identically either way); the only
 * difference is that `field_state` is wiped first, per `clearFieldState`'s
 * own docs, so each field lands unconditionally instead of via a numeric
 * ordering-key comparison against data that predates the snapshot. */
async function applySnapshot(snapshot: SnapshotResponse, device: DeviceRecord): Promise<void> {
  await clearFieldState();

  const lamportTimestamp = await tickLamportClock();
  // Same chunked bookkeeping as downloadAndApply's loop, and for the same
  // reason (see MARK_APPLIED_CHUNK) — a snapshot can carry as many objects
  // as a large account's entire bookmark/tab/history state.
  let appliedBuffer: string[] = [];
  const flushAppliedBuffer = async () => {
    if (appliedBuffer.length === 0) return;
    await markAppliedBatch(appliedBuffer);
    appliedBuffer = [];
  };
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

  for (const obj of snapshot.objects) {
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
    appliedBuffer.push(await applyOneRemote(op, device.encryptionRootKey));
    if (appliedBuffer.length >= MARK_APPLIED_CHUNK) await flushAppliedBuffer();
    await maybeYield();
  }

  for (const tombstone of snapshot.tombstones) {
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
    appliedBuffer.push(await applyOneRemote(op, device.encryptionRootKey));
    if (appliedBuffer.length >= MARK_APPLIED_CHUNK) await flushAppliedBuffer();
    await maybeYield();
  }

  await flushAppliedBuffer();

  await putSyncState({
    ...(await getSyncState()),
    cursor: snapshot.snapshotCursor,
    lastSyncAt: new Date().toISOString(),
  });
}

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

export async function runSyncCycle(): Promise<void> {
  if (syncInFlight) {
    rerunRequested = true;
    return;
  }
  syncInFlight = true;
  try {
    do {
      rerunRequested = false;
      emitStatus("syncing");
      try {
        await uploadPending();
        await downloadAndApply();
        emitStatus("idle");
      } catch (err) {
        console.error("HelixSync: sync cycle failed", err);
        emitStatus("error", err instanceof Error ? err.message : String(err));
        // Don't hot-loop retrying against whatever just failed (e.g. the
        // network being down) — a trigger that arrived during a failing
        // cycle waits for the next alarm/push like it always did.
        rerunRequested = false;
        break;
      }
    } while (rerunRequested);
  } finally {
    syncInFlight = false;
  }
}

export async function getPendingCount(): Promise<number> {
  return countPendingOperations();
}
