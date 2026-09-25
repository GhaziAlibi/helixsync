// History sync (docs/protocol.md §8.3). Visits are immutable, append-only
// events: no field merge and no tombstones. Sync retention is a server
// concern (§11); the browser's own history is never pruned here.
//
// Remote visits are never replayed into chrome://history. chrome.history
// .addUrl can only add a visit "now", with no timestamp or title, and its
// async onVisited echo was recaptured as a new local visit, causing runaway
// duplication between devices. Remote visits are only recorded in
// remote_objects, which the popup displays.
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
    if (!historyCaptureEnabled) return;
    if (!item.url) return;
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

function remoteVisitRecord(op: OperationOut, objectId: string, payload: HistoryVisitPayload): RemoteObjectRecord {
  return {
    objectId,
    objectType: "historyVisit",
    originDeviceId: op.deviceId,
    payload,
    deleted: 0,
    updatedAt: op.createdAt,
  };
}

async function applyRemote(op: OperationOut, payload: unknown): Promise<void> {
  if (isBulkImport(op, payload)) {
    await applyRemoteBatch([{ op, payload }]);
    return;
  }
  // This device's own visits are already in its browser history.
  const device = await getDevice();
  if (!device || op.deviceId === device.deviceId) return;

  await putRemoteObject(remoteVisitRecord(op, op.objectId, payload as HistoryVisitPayload));
}

/** Batch counterpart to `applyRemote`, used for both incremental downloads
 * and snapshot resync. A bulk import is expanded only to its newest
 * BULK_PEER_MAX_VISITS visits, since remote_objects keeps no more than that
 * anyway. Those rows get deterministic ids, so re-applying overwrites them. */
async function applyRemoteBatch(items: Array<{ op: OperationOut; payload: unknown }>): Promise<void> {
  const device = await getDevice();

  const remoteItems = device ? items.filter(({ op }) => op.deviceId !== device.deviceId) : items;
  const bulkItems = remoteItems.filter(({ op, payload }) => isBulkImport(op, payload));
  const singleItems = remoteItems.filter(({ op, payload }) => !isBulkImport(op, payload));

  const records: RemoteObjectRecord[] = singleItems.map(({ op, payload }) =>
    remoteVisitRecord(op, op.objectId, payload as HistoryVisitPayload),
  );

  // Segments aren't globally sorted, so every one must be decrypted to find
  // the newest visits. Stops if the device disconnects.
  for (const { op, payload } of bulkItems) {
    const peerDevice = await getDevice();
    if (!peerDevice) return;
    const container = payload as Parameters<typeof expandBulkNewestK>[0];
    const newest = await expandBulkNewestK(
      container,
      peerDevice.accountKey,
      BULK_PEER_MAX_VISITS,
      async () => !(await getDevice()),
      op.objectId,
    );
    if (!(await getDevice())) return;
    for (let index = 0; index < newest.length; index++) {
      const visit = newest[index];
      records.push(
        remoteVisitRecord(op, await bulkPeerObjectId(op.objectId, index), {
          url: visit.url,
          title: visit.title,
          visitedAt: visit.visitedAt,
        }),
      );
      if (index % 50 === 49) await yieldToEventLoop();
    }
  }

  await putRemoteObjectsBatch(records);
}

registerApplier("historyVisit", applyRemote);
registerBatchApplier("historyVisit", applyRemoteBatch);
