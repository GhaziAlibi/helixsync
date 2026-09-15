// History synchronization per docs/protocol.md §8.3: visits are immutable,
// append-only events — no field merge or tombstones, unlike bookmarks.
// Retention/compaction of *sync* history is a server concern
// (docs/protocol.md §11); this module does not prune the browser's native
// history, which has its own independent retention already.
import { createLocalOperationsBatch, registerApplier, registerBatchApplier, scheduleLocalSync } from "../sync/engine";
import type { PendingLocalOperation } from "../sync/engine";
import { getDevice, putDevice, putRemoteObject, putRemoteObjectsBatch } from "../storage/db";
import type { RemoteObjectRecord } from "../storage/db";
import { createSuppressionGuard } from "../sync/suppress";
import { createMicroBatchQueue } from "../sync/micro-batch";
import { deterministicUuid } from "../util/uuid";
import type { HistoryVisitPayload, OperationOut } from "../sync/types";

// See sync/suppress.ts. Chrome's docs don't state whether `addUrl` (used
// by `applyRemote` below) fires `onVisited` — if it does, applying a
// remote visit would otherwise mint a *new* historyVisit object (its
// objectId embeds this device's id and the local re-derived visitedAt, so
// §8.3's dedup-by-objectId rule can't catch it) that the origin device
// then re-applies right back, forever. Guarding the addUrl call costs
// nothing if the event turns out not to fire.
const guard = createSuppressionGuard();

// --- Local capture: browser event -> operation --------------------------
//
// chrome.history.onVisited can fire in bursts (session restore, fast
// navigation chains) and each visit used to pay createLocalOperation's
// three separate IndexedDB transactions plus a WebCrypto encryption call,
// one at a time. The listener below now does only the synchronous
// guard.isSuppressed() check (see the guard's module comment above — this
// MUST happen at event-fire time, not inside flushVisitEvents, or the
// suppression window has already closed by the time a deferred flush
// runs) and pushes the rest onto the shared micro-batch queue
// (sync/micro-batch.ts); flushVisitEvents then turns the whole queue into
// one createLocalOperationsBatch call, the same batch primitive EXT-1's
// backfill below already uses.

interface QueuedVisitEvent {
  url: string;
  title: string | undefined;
  visitTime: number;
}

async function flushVisitEvents(items: QueuedVisitEvent[]): Promise<void> {
  const device = await getDevice();
  if (!device) return; // unregistered device: the burst silently no-ops, same as the old per-visit check

  const pending: PendingLocalOperation[] = await Promise.all(
    items.map(async (item): Promise<PendingLocalOperation> => {
      const visitedAt = new Date(item.visitTime).toISOString();
      const objectId = await deterministicUuid("historyVisit", item.url, visitedAt, device.deviceId);
      const payload: HistoryVisitPayload = { url: item.url, title: item.title, visitedAt };
      return { objectType: "historyVisit", objectId, operationType: "visit", payload };
    }),
  );
  // Reserves one contiguous device-sequence/lamport range for the whole
  // batch — `items` (and therefore `pending`) is in original event-fire
  // order, so the range is assigned in that same chronological order too.
  await createLocalOperationsBatch(pending);
  // EXT-1: operations are now durably in pending_operations — nudge a sync
  // cycle instead of leaving them for the next alarm/push (see
  // scheduleLocalSync's doc comment in sync/engine.ts).
  scheduleLocalSync();
}

const enqueueVisitEvent = createMicroBatchQueue<QueuedVisitEvent>(flushVisitEvents);

let captureRegistered = false;

export function registerCapture(): void {
  // See the matching guard in bookmarks/index.ts::registerCapture — called
  // on every startup and every REFRESH_CAPTURE_CONFIG message, so this must
  // stay idempotent or repeated settings saves register the listener
  // multiple times.
  if (captureRegistered) return;
  captureRegistered = true;

  chrome.history.onVisited.addListener((item) => {
    if (!item.url) return;
    if (guard.isSuppressed()) return; // our own applyRemote()'s addUrl call below, not a real local visit
    enqueueVisitEvent({ url: item.url, title: item.title, visitTime: item.lastVisitTime ?? Date.now() });
  });
}

// chrome.history.search() only returns the most recent visit per URL, so
// each matching URL is re-expanded via getVisits() to recover every
// individual past visit — matching the one-object-per-visit model
// onVisited already produces going forward (see file header).
const BACKFILL_MAX_RESULTS = 100_000;

// Visits are flushed via createLocalOperationsBatch in chunks of this size
// rather than one array covering the whole backfill (bounds memory and
// IndexedDB transaction size for accounts with tens of thousands of visits)
// and rather than one at a time (each `createLocalOperation` call opens
// three separate IndexedDB transactions purely for sequence/lamport/queue
// bookkeeping — pure overhead when, unlike live capture, nothing else needs
// to observe those values between one backfilled visit and the next).
const BACKFILL_FLUSH_CHUNK = 500;

// `chrome.history.getVisits` is one IPC round trip to the browser process
// per distinct URL, and `deterministicUuid` is one WebCrypto SHA-256 digest
// per visit — for an account with tens of thousands of URLs, running those
// fully sequentially (one `await` at a time) is the dominant cost of
// backfill, dwarfing the IndexedDB/network side that `BACKFILL_FLUSH_CHUNK`
// batches. This bounds how many URLs are resolved concurrently: high enough
// to overlap that IPC/hashing latency instead of serializing it, low enough
// not to flood the browser process with thousands of simultaneous
// `getVisits` calls at once.
const BACKFILL_URL_CONCURRENCY = 25;

async function resolveVisitOps(
  item: chrome.history.HistoryItem,
  deviceId: string,
): Promise<PendingLocalOperation[]> {
  if (!item.url) return [];
  const url = item.url;
  const visits = await chrome.history.getVisits({ url });
  return Promise.all(
    visits.map(async (visit): Promise<PendingLocalOperation> => {
      const visitedAt = new Date(visit.visitTime ?? Date.now()).toISOString();
      const objectId = await deterministicUuid("historyVisit", url, visitedAt, deviceId);
      const payload: HistoryVisitPayload = { url, title: item.title, visitedAt };
      return { objectType: "historyVisit", objectId, operationType: "visit", payload };
    }),
  );
}

/** One-time import of history that accumulated before HelixSync was
 * installed — chrome.history.onVisited only fires for visits going
 * forward, so the browser's existing history would otherwise never reach
 * the server.
 *
 * EXT-3 (review.md): resumable via `device.historyBackfillLastVisitTime`
 * (see its doc comment in storage/db.ts). chrome.history.search returns
 * items in decreasing lastVisitTime order and this function processes them
 * in that same order, so `flush` below persists the lastVisitTime of the
 * last item whose ops it just durably committed to pending_operations as
 * the new high-water mark, and the search above resumes from it via
 * `endTime` on the next call. A service worker kill, browser restart, or
 * thrown error mid-backfill therefore loses at most one
 * BACKFILL_FLUSH_CHUNK's worth of re-scanned work on the next attempt,
 * instead of re-scanning — and re-creating fresh-operationId operations
 * for — the user's entire history from scratch. */
export async function backfillExisting(): Promise<void> {
  const device = await getDevice();
  if (!device) return;

  const items = await chrome.history.search({
    text: "",
    startTime: 0,
    maxResults: BACKFILL_MAX_RESULTS,
    ...(device.historyBackfillLastVisitTime !== undefined
      ? { endTime: device.historyBackfillLastVisitTime }
      : {}),
  });

  let pending: PendingLocalOperation[] = [];

  // Only persists `boundaryVisitTime` once every op up to and including
  // that boundary item is durably in pending_operations — so a crash
  // between the batch write and this write just leaves the mark slightly
  // stale (safe: the next resume re-scans a little more than strictly
  // necessary, never skips anything not yet processed).
  async function flush(boundaryVisitTime: number | undefined): Promise<void> {
    if (pending.length === 0) return;
    await createLocalOperationsBatch(pending);
    pending = [];
    if (boundaryVisitTime === undefined) return;
    const current = await getDevice();
    if (current) {
      await putDevice({ ...current, historyBackfillLastVisitTime: boundaryVisitTime });
    }
  }

  for (let i = 0; i < items.length; i += BACKFILL_URL_CONCURRENCY) {
    const slice = items.slice(i, i + BACKFILL_URL_CONCURRENCY);
    const opsPerUrl = await Promise.all(slice.map((item) => resolveVisitOps(item, device.deviceId)));

    for (let j = 0; j < opsPerUrl.length; j++) {
      for (const op of opsPerUrl[j]) pending.push(op);
      if (pending.length >= BACKFILL_FLUSH_CHUNK) {
        await flush(slice[j].lastVisitTime);
      }
    }
  }
  await flush(items.length > 0 ? items[items.length - 1].lastVisitTime : undefined);
}

async function applyRemote(op: OperationOut, payload: unknown): Promise<void> {
  const p = payload as HistoryVisitPayload;
  // chrome.history.addUrl only supports adding a visit "now" for a URL,
  // with no way to set a historical timestamp or title — re-verified
  // against the current Chrome extensions API reference (September 2026):
  // "Adds a URL to the history at the current time with a transition type
  // of 'link'." `UrlDetails` accepts only `url`. There is no addPage-style
  // alternative and no deprecated API that does more (AI rule #4/#5: never
  // invent browser APIs). This is a hard Chromium platform limit, not an
  // oversight — so rather than silently losing the original visitedAt/
  // title, the incoming operation is also recorded in `remote_objects`
  // (`putRemoteObject` below), which the popup surfaces as "Synced history
  // from other devices" showing the real title/url/visitedAt even though
  // chrome://history itself can only ever show "visited just now", no
  // title.
  try {
    await guard.run(() => chrome.history.addUrl({ url: p.url }));
  } catch (e) {
    console.warn("HelixSync: failed to apply remote history visit", e);
  }

  const device = await getDevice();
  if (!device || op.deviceId === device.deviceId) return; // own visit, already native
  await putRemoteObject({
    objectId: op.objectId,
    objectType: "historyVisit",
    originDeviceId: op.deviceId,
    payload: p,
    deleted: false,
    updatedAt: op.createdAt,
  });
}

// `chrome.history.getVisits`'s IPC-latency rationale (BACKFILL_URL_CONCURRENCY,
// above) applies identically here: `chrome.history.addUrl` has no batch/bulk
// variant (see applyRemote's comment — AI rule #4/#5, never invent browser
// APIs), so applying a large batch of visits — whether from snapshot resync
// or, now, an incremental download page (sync/engine.ts's applySnapshot and
// downloadAndApply, both callers of a registered batch applier) — would
// otherwise pay one fully-sequential addUrl IPC round trip per visit. This
// bounds how many run concurrently instead, same value/rationale as
// BACKFILL_URL_CONCURRENCY.
const APPLY_BATCH_URL_CONCURRENCY = 25;

/** Batch counterpart to `applyRemote`, used by sync/engine.ts (via
 * `registerBatchApplier`) from both `applySnapshot`'s bulk snapshot-resync
 * path and `downloadAndApply`'s incremental path — the engine buffers
 * historyVisit ops (up to `MARK_APPLIED_CHUNK` at a time on the incremental
 * path) and hands them here instead of calling `applyRemote` once per op.
 * Mirrors `applyRemote`'s per-item semantics exactly: `chrome.history.addUrl`
 * still runs for every item (including this device's own — matching
 * `applyRemote`'s existing ordering where addUrl runs unconditionally before
 * the own-device check), just with bounded concurrency instead of one at a
 * time since there is no bulk addUrl API to call instead. Only the
 * `remote_objects` write is conditional on not being this device's own
 * visit, and is collected into one `putRemoteObjectsBatch` call for the
 * whole batch instead of one `putRemoteObject` call per item. */
async function applyRemoteBatch(items: Array<{ op: OperationOut; payload: unknown }>): Promise<void> {
  const device = await getDevice(); // once for the whole batch, mirroring flushVisitEvents above

  for (let i = 0; i < items.length; i += APPLY_BATCH_URL_CONCURRENCY) {
    const slice = items.slice(i, i + APPLY_BATCH_URL_CONCURRENCY);
    await Promise.all(
      slice.map(async ({ payload }) => {
        const p = payload as HistoryVisitPayload;
        try {
          await guard.run(() => chrome.history.addUrl({ url: p.url }));
        } catch (e) {
          console.warn("HelixSync: failed to apply remote history visit", e);
        }
      }),
    );
  }

  const records: RemoteObjectRecord[] = [];
  for (const { op, payload } of items) {
    if (!device || op.deviceId === device.deviceId) continue; // own visit, already native
    const p = payload as HistoryVisitPayload;
    records.push({
      objectId: op.objectId,
      objectType: "historyVisit",
      originDeviceId: op.deviceId,
      payload: p,
      deleted: false,
      updatedAt: op.createdAt,
    });
  }
  await putRemoteObjectsBatch(records);
}

registerApplier("historyVisit", applyRemote);
registerBatchApplier("historyVisit", applyRemoteBatch);
