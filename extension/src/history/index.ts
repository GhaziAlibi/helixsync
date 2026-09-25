// History sync (docs/protocol.md §8.3). Visits are immutable, append-only
// events: no field merge and no tombstones. Sync retention is a server
// concern (§11); the browser's own history is never pruned here.
//
// Remote visits are replayed into the browser's own history (./replay.ts) so
// they appear in chrome://history and address-bar suggestions. chrome.history
// .addUrl can only add a visit "now", with no title, so a replayed visit is
// dated when it was synced. Its onVisited echo is recognised and never
// captured, which is what once caused runaway duplication between devices.
// Nothing else is kept of a remote visit: the browser's history is the store.
import { createLocalOperationsBatch, registerApplier, registerBatchApplier } from "../sync/engine";
import type { PendingLocalOperation } from "../sync/engine";
import { fetchSettings } from "../api/client";
import { getDevice, putDevice } from "../storage/db";
import { createMicroBatchQueue } from "../sync/micro-batch";
import { hourKey } from "../util/hour";
import { startKeepAlive } from "../util/keep-alive";
import { deterministicUuid } from "../util/uuid";
import type { BulkHistoryContainer, HistoryVisitPayload, OperationOut } from "../sync/types";
import { backfillHistoryBulk, forEachBulkVisit, isBulkContainer } from "./bulk";
import { consumeReplayEcho, noteVisit, replayVisitsIntoBrowserHistory } from "./replay";
import type { NewestVisitByUrl } from "./replay";

interface QueuedVisitEvent {
  url: string;
  title: string | undefined;
  visitTime: number;
}

// Bounds concurrent SHA-256 digests so a session-restore burst doesn't fire
// hundreds at once on the single service-worker thread.
const VISIT_UUID_CONCURRENCY = 50;

/** The objectId is deterministic, so independently re-derived copies of the
 * same visit collide instead of duplicating (docs/protocol.md §8.3). */
async function makeVisitOperation(
  url: string,
  title: string | undefined,
  visitTimeMs: number,
  deviceId: string,
): Promise<PendingLocalOperation> {
  const visitedAt = new Date(visitTimeMs).toISOString();
  const objectId = await deterministicUuid("historyVisit", url, visitedAt, deviceId);
  const payload: HistoryVisitPayload = { url, title, visitedAt };
  return {
    objectType: "historyVisit",
    objectId,
    operationType: "visit",
    payload,
    // docs/protocol.md §8.3.2: the server requires exactly one visit in one
    // hour bucket for a "visit" op.
    visitHours: { [hourKey(visitTimeMs)]: 1 },
  };
}

async function flushVisitEvents(items: QueuedVisitEvent[]): Promise<void> {
  if (!(await isHistorySyncEnabled())) return;
  const device = await getDevice();
  if (!device) return;

  // Visits before `historyBulkEndMs` belong to the bulk import; capturing
  // them live as well would upload them twice. The boundary is persisted
  // before capture is registered and kept after the import completes.
  const fresh =
    device.historyBulkEndMs !== undefined
      ? items.filter((item) => item.visitTime >= device.historyBulkEndMs!)
      : items;
  if (fresh.length === 0) return;

  const pending: PendingLocalOperation[] = [];
  for (let i = 0; i < fresh.length; i += VISIT_UUID_CONCURRENCY) {
    const slice = fresh.slice(i, i + VISIT_UUID_CONCURRENCY);
    const sliceOps = await Promise.all(
      slice.map((item) => makeVisitOperation(item.url, item.title, item.visitTime, device.deviceId)),
    );
    pending.push(...sliceOps);
  }
  await createLocalOperationsBatch(pending);
  // Deliberately no scheduleLocalSync(): peers never act on visits promptly,
  // so waking them per burst would only cost cycles. Queued visits go out
  // with the next alarm, push or other nudged cycle.
}

const enqueueVisitEvent = createMicroBatchQueue<QueuedVisitEvent>(flushVisitEvents);

// Synchronous listener kill-switch, set from the "History" setting. The
// flush-time settings check is the backstop for events already queued.
// Fails open so a settings fetch failure never loses history.
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
  // Called on every startup and settings save; must stay idempotent.
  if (captureRegistered) return;
  captureRegistered = true;

  chrome.history.onVisited.addListener((item) => {
    if (!item.url) return;
    // The event our own replay caused, not a visit by the user.
    if (consumeReplayEcho(item.url, item.lastVisitTime)) return;
    if (!historyCaptureEnabled) return;
    enqueueVisitEvent({ url: item.url, title: item.title, visitTime: item.lastVisitTime ?? Date.now() });
  });
}

/** Converts the account's history retention into a chrome.history.search
 * `startTime`. The server can only enforce retention by upload time
 * (payloads are encrypted), so the backfill is scoped by visit time here.
 * Unknown or unlimited retention means everything (0). */
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
    return 0; // offline: import everything; the server still enforces retention
  }
}

/** One-time import of history that predates the install (onVisited only
 * fires going forward), sent as bulk-import operations (./bulk.ts). */
export async function backfillExisting(): Promise<void> {
  if (!(await isHistorySyncEnabled())) {
    console.log("HelixSync: history backfillExisting skipped (history sync disabled)");
    return;
  }
  const device = await getDevice();
  if (!device) {
    console.log("HelixSync: history backfillExisting skipped (no device)");
    return;
  }

  const cutoffMs = await backfillCutoffMs();
  await backfillHistoryBulk(cutoffMs);
}

function isBulkImport(op: OperationOut, payload: unknown): boolean {
  return op.operationType === "bulkImport" && isBulkContainer(payload);
}

/** Replayed visits are stamped "now". Until this device's own bulk import has
 * fixed its end boundary, fix it here first: the import stops at the
 * boundary, so it can never mistake a replayed visit for the user's own. */
async function ensureHistoryBulkBoundary(): Promise<void> {
  const device = await getDevice();
  if (!device || device.initialImportCompletedAt || device.historyBulkEndMs !== undefined) return;
  await putDevice({ ...device, historyBulkEndMs: Date.now() });
}

/** Never throws: a failed replay must not stall the sync (a throw would
 * re-download and re-apply the same page). */
async function replayIntoBrowserHistory(newestByUrl: NewestVisitByUrl): Promise<void> {
  if (newestByUrl.size === 0) return;
  try {
    if (!(await isHistorySyncEnabled())) return;
    await ensureHistoryBulkBoundary();
    const added = await replayVisitsIntoBrowserHistory(newestByUrl, async () => !(await getDevice()));
    console.log("HelixSync: history replay finished", { candidates: newestByUrl.size, added });
  } catch (e) {
    console.error("HelixSync: history replay failed", e);
  }
}

async function applyRemote(op: OperationOut, payload: unknown): Promise<void> {
  await applyRemoteBatch([{ op, payload }]);
}

/** Batch counterpart to `applyRemote`, used for both incremental downloads
 * and snapshot resync. Every visit is read, including all of a bulk import's
 * segments, but only each URL's newest time is kept, which is all the
 * browser's history needs. Re-applying is harmless: a URL the browser already
 * has is skipped. */
async function applyRemoteBatch(items: Array<{ op: OperationOut; payload: unknown }>): Promise<void> {
  const device = await getDevice();

  // This device's own visits are already in its browser history.
  const remoteItems = device ? items.filter(({ op }) => op.deviceId !== device.deviceId) : items;
  if (remoteItems.length === 0) return;

  const newestByUrl: NewestVisitByUrl = new Map();
  const stopKeepAlive = startKeepAlive();
  try {
    for (const { op, payload } of remoteItems) {
      if (isBulkImport(op, payload)) {
        const peerDevice = await getDevice();
        if (!peerDevice) return;
        const completed = await forEachBulkVisit(
          payload as BulkHistoryContainer,
          peerDevice.accountKey,
          (url, timeMs) => noteVisit(newestByUrl, url, timeMs),
          async () => !(await getDevice()),
          op.objectId,
        );
        // Disconnected mid-way: nothing is replayed into a wiped device.
        if (!completed) return;
      } else {
        const visit = payload as Partial<HistoryVisitPayload> | null;
        if (typeof visit?.url !== "string") continue;
        noteVisit(newestByUrl, visit.url, Date.parse(visit.visitedAt ?? ""));
      }
    }
    await replayIntoBrowserHistory(newestByUrl);
  } finally {
    stopKeepAlive();
  }
}

registerApplier("historyVisit", applyRemote);
registerBatchApplier("historyVisit", applyRemoteBatch);
