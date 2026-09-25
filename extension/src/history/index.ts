// History synchronization per docs/protocol.md §8.3: visits are immutable,
// append-only events — no field merge or tombstones, unlike bookmarks.
// Retention/compaction of *sync* history is a server concern
// (docs/protocol.md §11); this module does not prune the browser's native
// history, which has its own independent retention already.
import { createLocalOperationsBatch, registerApplier, registerBatchApplier } from "../sync/engine";
import type { PendingLocalOperation } from "../sync/engine";
import { fetchSettings } from "../api/client";
import { getDevice, putRemoteObject, putRemoteObjectsBatch } from "../storage/db";
import type { RemoteObjectRecord } from "../storage/db";
import { createMicroBatchQueue } from "../sync/micro-batch";
import { hourKey } from "../util/hour";
import { deterministicUuid } from "../util/uuid";
import { yieldToEventLoop } from "../util/yield";
import type { HistoryVisitPayload, OperationOut } from "../sync/types";
import {
  backfillHistoryBulk,
  bulkPeerObjectId,
  expandBulkNewestK,
  isBulkContainer,
  BULK_PEER_MAX_VISITS,
} from "./bulk";

// --- Local capture: browser event -> operation --------------------------
//
// chrome.history.onVisited can fire in bursts (session restore, fast
// navigation chains) and each visit used to pay createLocalOperation's
// three separate IndexedDB transactions plus a WebCrypto encryption call,
// one at a time. The listener below does only the synchronous
// historyCaptureEnabled/url checks and pushes the rest onto the shared
// micro-batch queue (sync/micro-batch.ts); flushVisitEvents then turns the
// whole queue into one createLocalOperationsBatch call, the same batch
// primitive EXT-1's backfill below already uses.
//
// This module used to also guard against remote-apply echoes here (a
// suppression window plus a short-lived "recently applied" map): that
// machinery existed only because applying a remote visit used to replay it
// into this browser's real history via chrome.history.addUrl, which risked
// onVisited firing right back for the same URL. Remote visits are no longer
// replayed at all (see applyRemote/applyRemoteBatch below — the popup's
// "Synced history from other devices" already reads `remote_objects`, which
// carries the real title/visitedAt that addUrl could never set anyway), so
// there is nothing left for a local onVisited to echo and the whole guard/
// echo-map apparatus was deleted along with the replay call.

interface QueuedVisitEvent {
  url: string;
  title: string | undefined;
  visitTime: number;
}

// Bounds per-visit `deterministicUuid` (WebCrypto SHA-256) digests run
// concurrently — shared by the live `flushVisitEvents` burst path above and
// the backfill `resolveVisitOps` path below. Without this a session-restore
// burst (or one heavy URL with thousands of visits) fires an unbounded
// `Promise.all` of digests on the single MV3 thread.
const VISIT_UUID_CONCURRENCY = 50;

/** Builds one history-visit operation for `url` at `visitTimeMs`, with a
 * deterministic objectId so independently re-derived visit events collide
 * instead of duplicating (docs/protocol.md §8.3). Shared by the live burst
 * path and the backfill resolver below, which previously built this inline
 * in two places. */
async function makeVisitOperation(
  url: string,
  title: string | undefined,
  visitTimeMs: number,
  deviceId: string,
): Promise<PendingLocalOperation> {
  const visitedAt = new Date(visitTimeMs).toISOString();
  const objectId = await deterministicUuid("historyVisit", url, visitedAt, deviceId);
  const payload: HistoryVisitPayload = { url, title, visitedAt };
  // Change 3 (docs/protocol.md §8.3.2): a live visit is always exactly one
  // visit in exactly one hour bucket — the server's validation rejects
  // anything else for operationType "visit" (see sync::routes::process_batch).
  return {
    objectType: "historyVisit",
    objectId,
    operationType: "visit",
    payload,
    visitHours: { [hourKey(visitTimeMs)]: 1 },
  };
}

async function flushVisitEvents(items: QueuedVisitEvent[]): Promise<void> {
  // Backstop for the synchronous listener flag above (covers a burst already
  // queued when the user toggles History off). One cached-settings read per
  // flush — memory-mirrored after the first, so ~zero IPC.
  if (!(await isHistorySyncEnabled())) return;
  const device = await getDevice();
  if (!device) return; // unregistered device: the burst silently no-ops, same as the old per-visit check

  // Exact live/import partition (Change 2): `historyBulkEndMs` is the fixed
  // upper bound of the bulk import's enumeration window `[cutoffMs, endMs)`
  // (history/bulk.ts) — persisted once, in background/index.ts's
  // `initializeCaptureForSettings`, *before* this module's `registerCapture`
  // is ever called, specifically so this filter is already correct from the
  // very first live visit this device ever captures. Anything with
  // `visitTime` before `endMs` belongs to the bulk import (either already
  // covered by an uploaded chunk, or about to be enumerated by one still in
  // progress) and must not also be captured live, or it would be uploaded
  // twice. `endMs` is deliberately kept even after the import finishes (see
  // storage/db.ts's `historyBulkEndMs` doc comment), so this remains a
  // correct, permanent boundary — bulk takes `[cutoff, endMs)`, live takes
  // `>= endMs` — for the lifetime of the device, not just during the import.
  const fresh =
    device.historyBulkEndMs !== undefined
      ? items.filter((item) => item.visitTime >= device.historyBulkEndMs!)
      : items;
  if (fresh.length === 0) return;

  // Chunked like resolveVisitOps below: a session-restore burst of hundreds
  // of onVisited events must not fire hundreds of concurrent WebCrypto
  // digests in one Promise.all on the single MV3 thread.
  const pending: PendingLocalOperation[] = [];
  for (let i = 0; i < fresh.length; i += VISIT_UUID_CONCURRENCY) {
    const slice = fresh.slice(i, i + VISIT_UUID_CONCURRENCY);
    const sliceOps = await Promise.all(
      slice.map((item) => makeVisitOperation(item.url, item.title, item.visitTime, device.deviceId)),
    );
    pending.push(...sliceOps);
  }
  // Reserves one contiguous device-sequence/lamport range for the whole
  // batch — `items` (and therefore `pending`) is in original event-fire
  // order, so the range is assigned in that same chronological order too.
  await createLocalOperationsBatch(pending);
  // No scheduleLocalSync() here — deliberate, mirroring tabs/index.ts's
  // `hasMeaningfulOp` gate which skips the immediate nudge for
  // activate-only and title-only batches: a remote peer never replays this
  // into its own browser history at all (see applyRemote/applyRemoteBatch
  // below), it only surfaces in that peer's popup remote_objects view after
  // the next download, so waking every peer per burst just burns a full
  // cycle per 150ms window during churn. Ops are durably
  // queued above and go out on the next alarm/push/nudged cycle like any
  // other op — and the engine already treats historyVisit-only movement as
  // throttle-empty, so a nudge here would only feed the backoff. Trade-off:
  // an isolated visit now uploads within one alarm interval (5min) instead
  // of ~250ms.
}

const enqueueVisitEvent = createMicroBatchQueue<QueuedVisitEvent>(flushVisitEvents);

// Synchronous capture kill-switch, set from background/index.ts's
// initializeCaptureForSettings (which runs on startup and on every
// REFRESH_CAPTURE_CONFIG). Checked inline in the listener below so a
// disabled type pays zero micro-batch/timer/flush cost per event — the
// async gate in flushVisitEvents/backfillExisting is only the backstop for
// races between a settings save and this flag update. Defaults to true
// (fail-open: a settings fetch failure must never lose user history).
let historyCaptureEnabled = true;

export function setHistoryCaptureEnabled(enabled: boolean): void {
  historyCaptureEnabled = enabled;
}

async function isHistorySyncEnabled(): Promise<boolean> {
  try {
    const settings = await fetchSettings();
    return settings.syncHistory !== false;
  } catch {
    return true;
  }
}

let captureRegistered = false;

export function registerCapture(): void {
  // See the matching guard in bookmarks/index.ts::registerCapture — called
  // on every startup and every REFRESH_CAPTURE_CONFIG message, so this must
  // stay idempotent or repeated settings saves register the listener
  // multiple times.
  if (captureRegistered) return;
  captureRegistered = true;

  chrome.history.onVisited.addListener((item) => {
    if (!historyCaptureEnabled) return; // "History" toggled off in settings
    if (!item.url) return;
    enqueueVisitEvent({ url: item.url, title: item.title, visitTime: item.lastVisitTime ?? Date.now() });
  });
}

// Single-operation history import (historyVisit / bulkImport,
// docs/protocol.md §8.3, ./bulk.ts): first login sends old history as one
// op, one POST, one server row, one device-sequence number. The per-visit
// backfill this replaced (one getVisits IPC per URL + one SHA-256 + one
// AEAD per visit, 500-op chunks, 50 batches/cycle) pinned the MV3 thread on
// lifetime profiles. Live per-visit capture above stays unchanged; steady
// state is cheap.
//
// Retention scoping still happens here, by actual visit time (see
// retentionCutoffMs below): the server can only enforce retention by upload
// time (payloads are E2E-encrypted), so without this a fresh login would
// backfill lifetime history only for the server to keep most of it anyway.
// Account retention ("7d" | "30d" | "90d" | "1y" | "unlimited", default
// '30d' per server/migrations/0002) as a chrome.history.search `startTime`
// cutoff (epoch ms). Unknown/unlimited/fetch-failure falls open to 0 rather
// than skipping backfill under a guessed-at policy.
export function retentionCutoffMs(retention: string | undefined): number {
  const days =
    retention === "7d" ? 7 : retention === "30d" ? 30 : retention === "90d" ? 90 : retention === "1y" ? 365 : undefined;
  if (days === undefined) return 0;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

async function backfillCutoffMs(): Promise<number> {
  try {
    const settings = await fetchSettings();
    return retentionCutoffMs(settings.historyRetention);
  } catch {
    return 0; // offline at first login — backfill everything, server still enforces by upload time
  }
}

// Bulk-only backfill (spec §4): backfillExisting is now a thin wrapper
// around ./bulk.ts's collect+upload. Sync on/off gates and
// retentionCutoffMs scoping above are unchanged. A service-worker kill
// mid-collect restarts enumeration from scratch (correct, wasteful); the
// deterministic bulk IDs plus the pre-POST persist in bulk.ts make a
// mid-POST retry idempotent (server duplicate, zero new bytes).
/** One-time import of history that accumulated before HelixSync was
 * installed — chrome.history.onVisited only fires for visits going
 * forward, so the browser's existing history would otherwise never reach
 * the server. Sends old history as one op, one POST, one server row, one
 * device-sequence number (historyVisit / bulkImport). */
export async function backfillExisting(): Promise<void> {
  // One-time import must also respect the toggle — otherwise enabling the
  // extension with History off still encrypts+uploads lifetime history.
  // Fail-open on fetch error (same rationale as backfillCutoffMs above).
  if (!(await isHistorySyncEnabled())) {
    console.log("HelixSync: history backfillExisting skipped (history sync disabled)");
    return;
  }
  const device = await getDevice();
  if (!device) {
    console.log("HelixSync: history backfillExisting skipped (no device)");
    return;
  }

  // Scoped to the retention window by actual visit time (see
  // retentionCutoffMs): a fresh login with the default '30d' seeds ~30 days
  // instead of lifetime history; post-seed visits flow through the normal
  // live-capture batch path unchanged. Client-side scoping at collect
  // remains the enforcement (server sees one created_at = now).
  const cutoffMs = await backfillCutoffMs();
  await backfillHistoryBulk(cutoffMs);
}

async function applyRemote(op: OperationOut, payload: unknown): Promise<void> {
  // Bulk ops never take the single-visit path below (see applyRemoteBatch):
  // delegate to the batch expander so snapshot/incremental single dispatch
  // stays consistent.
  if (op.operationType === "bulkImport" && isBulkContainer(payload)) {
    await applyRemoteBatch([{ op, payload }]);
    return;
  }
  const p = payload as HistoryVisitPayload;

  // Own-device visits are already native — this exact device is where the
  // visit happened, so chrome.history already has it; there is nothing to
  // record.
  const device = await getDevice();
  if (!device || op.deviceId === device.deviceId) return;

  // Remote visits are never replayed into this browser's real history:
  // `chrome.history.addUrl` only supports adding a visit "now" for a URL,
  // with no way to set a historical timestamp or title (re-verified against
  // the current Chrome extensions API reference: "Adds a URL to the history
  // at the current time with a transition type of 'link'." `UrlDetails`
  // accepts only `url` — there is no addPage-style alternative and no
  // deprecated API that does more, AI rule #4/#5: never invent browser
  // APIs). Replaying it anyway produced no benefit — chrome://history could
  // only ever show "visited just now" with no title regardless — and was
  // actively harmful: an async onVisited echo of the replayed visit,
  // arriving after any synchronous suppression window had already closed,
  // was recaptured as a brand-new local operation, re-uploaded, downloaded
  // back by the origin device, and re-applied forever. Observed in
  // production as a ~28x blowup in real visit count (1,085,789 replayed
  // copies of one profile's own history). The incoming operation is instead
  // recorded only in `remote_objects` (`putRemoteObject` below), which the
  // popup surfaces as "Synced history from other devices" showing the real
  // title/url/visitedAt — the only place this data was ever actually
  // visible even when addUrl replay was still happening.
  await putRemoteObject({
    objectId: op.objectId,
    objectType: "historyVisit",
    originDeviceId: op.deviceId,
    payload: p,
    deleted: 0,
    updatedAt: op.createdAt,
  });
}

/** Batch counterpart to `applyRemote`, used by sync/engine.ts (via
 * `registerBatchApplier`) from both `applySnapshot`'s bulk snapshot-resync
 * path and `downloadAndApply`'s incremental path — the engine buffers
 * historyVisit ops (up to `MARK_APPLIED_CHUNK` at a time on the incremental
 * path) and hands them here instead of calling `applyRemote` once per op.
 *
 * Single-visit (`visit`) items mirror `applyRemote`'s per-item semantics
 * exactly (see that function): own-device visits filtered up front, no
 * native replay, one `putRemoteObjectsBatch` for the whole batch.
 *
 * Bulk (`bulkImport`) items take a different path (spec §4): expanding a
 * potentially 1M-row import into remote_objects one row at a time would be
 * pure write amplification. Bulk peers record remote_objects (popup view
 * works) the same way single items do, just via `expandBulkNewestK` first.
 * Each bulk op decrypts segment-by-segment and writes newest-K
 * remote_objects rows with deterministic ids (bulkObjectId, index) for
 * idempotent re-apply. Peers expand newest-K only (REMOTE_OBJECT_CAPS keeps
 * 2000 historyVisit rows per device); expanding 1M rows then pruning is pure
 * write amplification. */
async function applyRemoteBatch(items: Array<{ op: OperationOut; payload: unknown }>): Promise<void> {
  const device = await getDevice(); // once for the whole batch, mirroring flushVisitEvents above

  // Own-device visits are already native — skip the remote_objects
  // bookkeeping below for them entirely. See applyRemote's comment for why
  // this exact device's own visits need no further recording.
  const remoteItems = device ? items.filter(({ op }) => op.deviceId !== device.deviceId) : items;

  const bulkItems = remoteItems.filter(
    ({ op, payload }) => op.operationType === "bulkImport" && isBulkContainer(payload),
  );
  const singleItems = remoteItems.filter(
    ({ op, payload }) => !(op.operationType === "bulkImport" && isBulkContainer(payload)),
  );

  const records: RemoteObjectRecord[] = singleItems.map(({ op, payload }) => {
    const p = payload as HistoryVisitPayload;
    return {
      objectId: op.objectId,
      objectType: "historyVisit",
      originDeviceId: op.deviceId,
      payload: p,
      deleted: 0,
      updatedAt: op.createdAt,
    };
  });

  // Bulk peers: decrypt every segment (segments aren't globally sorted, so
  // the newest K can't be found without decrypting all — segmentation
  // bounds producer memory, not consumer decrypt cost), keep newest-K only.
  // Abort cleanly on disconnect.
  for (const { op, payload } of bulkItems) {
    if (!(await getDevice())) return;
    const container = payload as Parameters<typeof expandBulkNewestK>[0];
    const peerDevice = await getDevice();
    if (!peerDevice) return;
    const newest = await expandBulkNewestK(
      container,
      peerDevice.encryptionRootKey,
      BULK_PEER_MAX_VISITS,
      async () => !(await getDevice()),
    );
    if (!(await getDevice())) return;
    for (let index = 0; index < newest.length; index++) {
      const visit = newest[index];
      records.push({
        objectId: await bulkPeerObjectId(op.objectId, index),
        objectType: "historyVisit",
        originDeviceId: op.deviceId,
        payload: { url: visit.url, title: visit.title, visitedAt: visit.visitedAt },
        deleted: 0,
        updatedAt: op.createdAt,
      });
      if (index % 50 === 49) await yieldToEventLoop();
    }
  }

  await putRemoteObjectsBatch(records);
}

registerApplier("historyVisit", applyRemote);
registerBatchApplier("historyVisit", applyRemoteBatch);
