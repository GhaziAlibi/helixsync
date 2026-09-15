// MV3 service worker entrypoint. Per docs/protocol.md §15.6, no state
// transition here may depend on an in-memory-only flag surviving a
// service worker restart — all durable state lives in IndexedDB
// (src/storage/db.ts), and this file only orchestrates.
import "../bookmarks";
import "../history";
import "../tabs";

import { ensureCryptoReady } from "../crypto";
import { fetchSettings } from "../api/client";
import {
  disconnect as disconnectWebSocket,
  ensureConnected as ensureWebSocketConnected,
  onChangesAvailable,
} from "../api/websocket";
import {
  gcFieldStates,
  getDevice,
  getPendingTabRestores,
  getSyncState,
  putDevice,
  putSyncState,
  pruneAppliedOperations,
  pruneConflicts,
  pruneRemoteObjectsByType,
  resetInFlightOperations,
} from "../storage/db";
import { getPendingCount, onStatusChange, runSyncCycle, type SyncStatus } from "../sync/engine";
import { flushAllMicroBatchQueues } from "../sync/micro-batch";
import type { ObjectType } from "../sync/types";
import { backfillExisting as backfillBookmarks, registerCapture as registerBookmarkCapture } from "../bookmarks";
import { backfillExisting as backfillHistory, registerCapture as registerHistoryCapture } from "../history";
import { registerCapture as registerTabCapture, restoreTab } from "../tabs";

const SYNC_ALARM = "helixsync-periodic-sync";
const SYNC_INTERVAL_MINUTES = 1;

let lastStatus: SyncStatus = "idle";
let lastErrorDetail: string | undefined;

onStatusChange((status, detail) => {
  lastStatus = status;
  lastErrorDetail = detail;
});

// docs/protocol.md §12: purely a latency win over the alarm-driven cycle
// below — a "changes_available" push just runs the exact same sync cycle
// sooner than the next alarm tick would have.
onChangesAvailable(() => {
  runSyncCycle()
    .then(updateBadge)
    .catch((e) => console.error("HelixSync: WebSocket-triggered sync failed", e));
});

/** Reflects the count of not-yet-restored remote tabs on the toolbar icon
 * when the "ask" restore policy is active, so the user notices without
 * opening the popup. Cleared for any other policy. Best-effort: a
 * transient failure (e.g. offline) just leaves the previous badge state
 * rather than erroring the caller. */
async function updateBadge(): Promise<void> {
  try {
    const settings = await fetchSettings();
    if (settings.tabRestorePolicy !== "ask") {
      await chrome.action.setBadgeText({ text: "" });
      return;
    }
    const pending = await getPendingTabRestores();
    await chrome.action.setBadgeText({ text: pending.length > 0 ? String(pending.length) : "" });
  } catch (e) {
    console.warn("HelixSync: failed to update restore badge", e);
  }
}

async function initializeCaptureForSettings(): Promise<void> {
  const device = await getDevice();
  if (!device) return; // not registered yet; nothing to capture

  // Doesn't depend on `settings` below, so it's kept ahead of that
  // fetch/return — a WebSocket connection attempt shouldn't be skipped
  // just because the settings fetch below happens to fail offline.
  void ensureWebSocketConnected();

  let settings;
  try {
    settings = await fetchSettings();
  } catch {
    return; // offline at startup — captured once reachable on next alarm-driven attempt
  }

  // This function runs on every startup *and* every REFRESH_CAPTURE_CONFIG
  // message (device connect, every settings save) — each `registerCapture`
  // below guards itself with its own module-level "already registered"
  // flag (bookmarks/history/tabs/index.ts), so calling it again here is
  // always safe rather than re-adding the same chrome.* listeners and
  // multiplying every captured event into duplicate operations. What this
  // call site actually gates is *whether this device contributes new
  // operations at all* — chrome.bookmarks/history fire regardless of
  // HelixSync settings, so once registered the capture modules stay
  // registered for the rest of this service worker's lifetime; only
  // whether the resulting operations are useful is a product decision, to
  // simplify further in a future pass. For now bookmark/history capture
  // registers unconditionally since those default to enabled, and tab
  // capture is gated since tabs default to *disabled*.
  registerBookmarkCapture();
  registerHistoryCapture();
  if (settings.syncTabs) {
    registerTabCapture();
  }

  if (!device.initialImportCompletedAt) {
    try {
      await backfillBookmarks();
      await backfillHistory();
      await putDevice({ ...device, initialImportCompletedAt: new Date().toISOString() });
    } catch (e) {
      // Left unset so the next startup/alarm-driven call retries; both
      // backfills are safe to re-run (see their own docs).
      console.error("HelixSync: initial bookmark/history import failed", e);
    }
  }
}

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// remote_objects rows for "historyVisit"/"tab"/"window"/"tabGroup" are
// never deleted by ordinary sync (a close/delete just flips `deleted` to
// true — see tabs/index.ts and history/index.ts's own putRemoteObject
// calls), so without a cap each grows for the lifetime of the install.
// historyVisit gets the most headroom since backfill from a busy account
// can produce far more of them than the handful of open tabs/windows a
// device realistically ever has at once — all are still comfortably above
// what the popup ever actually displays (20 recent visits, the current
// pending-restore list).
const REMOTE_OBJECT_CAPS: Partial<Record<ObjectType, number>> = {
  historyVisit: 2000,
  tab: 500,
  window: 200,
  tabGroup: 200,
};
const CONFLICTS_CAP = 500;

/** Runs the daily storage-maintenance pass at most once a day — cheap to
 * call every sync cycle since it no-ops immediately otherwise, but none of
 * this needs minute-level freshness. */
async function runMaintenanceIfDue(): Promise<void> {
  const state = await getSyncState();
  const last = state.lastMaintenanceAt;
  if (last && Date.now() - new Date(last).getTime() < MAINTENANCE_INTERVAL_MS) {
    return;
  }
  await pruneAppliedOperations();
  for (const [objectType, cap] of Object.entries(REMOTE_OBJECT_CAPS) as [ObjectType, number][]) {
    await pruneRemoteObjectsByType(objectType, cap);
  }
  await pruneConflicts(CONFLICTS_CAP);
  // Cold cleanup of deleted objects' LWW provenance (storage/db.ts's
  // gcFieldStates doc comment has the full retention-window rationale) —
  // folded into this same once-a-day pass rather than given its own
  // separate throttle, since "roughly once a day" is exactly this
  // function's existing cadence and nothing about field_state GC is
  // latency-sensitive enough to need its own guard.
  await gcFieldStates();
  await putSyncState({ ...state, lastMaintenanceAt: new Date().toISOString() });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MINUTES });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MINUTES });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    // `chrome.alarms` is the one wake path guaranteed to survive a service
    // worker restart (unlike this module's own setTimeout-based WebSocket
    // backoff, which is lost along with everything else in memory when the
    // worker is torn down) — so this doubles as the reconnect backstop:
    // even if the WebSocket connection attempt never manages to establish
    // at all, reconnection is still retried at least once per alarm
    // interval, exactly matching the pre-WebSocket baseline cadence.
    void ensureWebSocketConnected();
    runSyncCycle()
      .then(updateBadge)
      .then(() =>
        runMaintenanceIfDue().catch((e) =>
          console.error("HelixSync: storage maintenance failed", e),
        ),
      )
      .catch((e) => console.error("HelixSync: periodic sync failed", e));
  }
});

// Best-effort last-chance flush of buffered bookmark/history/tab capture
// events right before Chrome tears down this service worker — see
// flushAllMicroBatchQueues's doc comment (sync/micro-batch.ts) for why this
// is a real improvement but not a guarantee (onSuspend's own processing-time
// limits).
chrome.runtime.onSuspend.addListener(() => {
  flushAllMicroBatchQueues();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "SYNC_NOW": {
        await runSyncCycle();
        await updateBadge();
        sendResponse({ ok: true });
        return;
      }
      case "RESTORE_TAB": {
        await restoreTab(message.objectId);
        await updateBadge();
        sendResponse({ ok: true });
        return;
      }
      case "RESTORE_ALL_TABS": {
        const pending = await getPendingTabRestores();
        for (const { objectId } of pending) {
          await restoreTab(objectId);
        }
        await updateBadge();
        sendResponse({ ok: true });
        return;
      }
      case "GET_STATUS": {
        const pendingCount = await getPendingCount();
        const state = await getSyncState();
        sendResponse({
          status: lastStatus,
          errorDetail: lastErrorDetail,
          pendingCount,
          lastSyncAt: state.lastSyncAt,
        });
        return;
      }
      case "REFRESH_CAPTURE_CONFIG": {
        await initializeCaptureForSettings();
        sendResponse({ ok: true });
        return;
      }
      case "DEVICE_DISCONNECTED": {
        await disconnectWebSocket();
        sendResponse({ ok: true });
        return;
      }
      default:
        sendResponse({ error: "unknown_message_type" });
    }
  })().catch((e) => {
    console.error("HelixSync: message handling failed", e);
    sendResponse({ error: "internal_error" });
  });
  return true; // keep the message channel open for the async response
});

// A service-worker restart means any `fetch` that was genuinely in flight
// when it died is now dead — there is no way for a pending_operations
// record to still legitimately be UPLOAD_IN_FLIGHT across a restart
// boundary, so resetting them all to LOCAL_QUEUED here is always safe
// unconditionally, on every startup. Kicked off immediately and
// independently of ensureCryptoReady's chain (it's pure IndexedDB, no
// crypto dependency) so it runs as early as possible — before
// uploadPending's first cycle could otherwise see stale in-flight rows
// left behind by a crash mid-upload.
resetInFlightOperations().catch((e) =>
  console.error("HelixSync: failed to reset in-flight operations", e),
);

ensureCryptoReady()
  .then(initializeCaptureForSettings)
  .then(updateBadge)
  .catch((e) => console.error("HelixSync: startup failed", e));
