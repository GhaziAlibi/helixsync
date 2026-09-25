// MV3 service worker entry point. Chrome may kill and restart the worker at
// any time, so no state transition may rely on in-memory state surviving
// (docs/protocol.md §15.6): durable state lives in IndexedDB and this file
// only orchestrates.
import "../bookmarks";
import "../history";
import "../tabs";

import { ensureCryptoReady } from "../crypto";
import {
  fetchSettings,
  fetchTabRestorePolicy,
  invalidatePolicyMemory,
  invalidateSettingsMemory,
  type UserSettingsDto,
} from "../api/client";
import {
  disconnect as disconnectWebSocket,
  ensureConnected as ensureWebSocketConnected,
  onChangesAvailable,
} from "../api/websocket";
import {
  clearAllLocalData,
  countPendingTabRestores,
  gcFieldStates,
  getDevice,
  getPendingTabRestores,
  getSyncState,
  invalidateDeviceMemory,
  putDevice,
  putSyncState,
  pruneAppliedOperations,
  pruneConflicts,
  pruneDeferredMaterializations,
  pruneRemoteObjectsByType,
  resetInFlightOperations,
  type DeviceRecord,
} from "../storage/db";
import {
  clearSyncBlockedState,
  getPendingCount,
  notifyPeerChanges,
  onStatusChange,
  runSyncCycle,
  scheduleLocalSync,
  type SyncStatus,
} from "../sync/engine";
import { flushAllMicroBatchQueues } from "../sync/micro-batch";
import type { ObjectType } from "../sync/types";
import {
  backfillExisting as backfillBookmarks,
  registerCapture as registerBookmarkCapture,
  setBookmarkCaptureEnabled,
} from "../bookmarks";
import {
  backfillExisting as backfillHistory,
  registerCapture as registerHistoryCapture,
  setHistoryCaptureEnabled,
} from "../history";
import {
  flushPendingTitleDebounces,
  registerCapture as registerTabCapture,
  restoreTab,
  restoreTabs,
  setTabGroupsCaptureEnabled,
  setTabsCaptureEnabled,
} from "../tabs";

const SYNC_ALARM = "helixsync-periodic-sync";
// A backstop only: WebSocket pushes and local nudges provide the low
// latency, and every tick costs a wake plus an HTTPS round trip.
const SYNC_INTERVAL_MINUTES = 5;

function ensureSyncAlarm(): void {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MINUTES });
}

let lastStatus: SyncStatus = "idle";
let lastErrorDetail: string | undefined;

onStatusChange((status, detail) => {
  lastStatus = status;
  lastErrorDetail = detail;
});

// A push goes through the throttled local-sync path so a burst of pushes
// collapses into a couple of cycles instead of one per push.
onChangesAvailable(() => {
  notifyPeerChanges();
  scheduleLocalSync();
  void updateBadge().catch((e) => console.error("HelixSync: WebSocket-triggered badge update failed", e));
});

// Recounting walks every live remote tab and this runs on every tick and
// push, so a fresh count is reused for one alarm interval. Must stay >= the
// alarm interval or every tick recounts.
let lastBadgeAt = 0;
let lastBadgeText = "";
const BADGE_THROTTLE_MS = SYNC_INTERVAL_MINUTES * 60_000;

export function resetBadgeStateForTesting(): void {
  lastBadgeAt = 0;
  lastBadgeText = "";
}

/** Shows the number of not-yet-restored remote tabs under the "ask" policy,
 * and clears the badge otherwise. Best-effort: failures keep the previous
 * badge. */
export async function updateBadge(force = false): Promise<void> {
  try {
    // Throttled before any IPC.
    const now = Date.now();
    if (!force && now - lastBadgeAt < BADGE_THROTTLE_MS) {
      return;
    }
    const tabRestorePolicy = await fetchTabRestorePolicy();
    if (tabRestorePolicy !== "ask") {
      if (lastBadgeText !== "") {
        lastBadgeText = "";
        await chrome.action.setBadgeText({ text: "" });
      }
      lastBadgeAt = now;
      return;
    }
    const pendingCount = await countPendingTabRestores();
    lastBadgeAt = now;
    const nextText = pendingCount > 0 ? String(pendingCount) : "";
    if (nextText !== lastBadgeText || force) {
      lastBadgeText = nextText;
      await chrome.action.setBadgeText({ text: nextText });
    }
  } catch (e) {
    console.warn("HelixSync: failed to update restore badge", e);
  }
}

// Dedupes concurrent initial imports within one worker. The message that
// wakes a fresh worker races that worker's own startup chain; both would see
// the import as not yet done and run it twice, doubling memory (observed to
// OOM). The durable completion marker is `initialImportCompletedAt`.
let initialImportInFlight: Promise<void> | null = null;

/** The per-type flags are synchronous listener kill-switches; each module's
 * flush-time check is the backstop. Unset settings count as enabled. */
function applyCaptureToggles(settings: UserSettingsDto): void {
  setBookmarkCaptureEnabled(settings.syncBookmarks !== false);
  setHistoryCaptureEnabled(settings.syncHistory !== false);
  setTabsCaptureEnabled(settings.syncTabs !== false);
  setTabGroupsCaptureEnabled(settings.syncTabGroups !== false);
}

async function runInitialImport(device: DeviceRecord): Promise<void> {
  if (initialImportInFlight) {
    console.log("HelixSync: initial import already in flight on this worker, awaiting it instead of re-running");
    await initialImportInFlight;
    return;
  }
  console.log("HelixSync: initial import starting (initialImportCompletedAt unset)");
  const importStartedAt = Date.now();
  initialImportInFlight = (async () => {
    try {
      // Sequential: both saturate the same thread, so running them together
      // only doubles peak memory.
      await backfillBookmarks();
      console.log("HelixSync: bookmark backfill returned", { elapsedMs: Date.now() - importStartedAt });
      await backfillHistory();
      console.log("HelixSync: history backfill returned", { elapsedMs: Date.now() - importStartedAt });
      // SEC-15: re-read, and stamp only if it's still the same device.
      // Writing the stale snapshot back after a mid-import disconnect would
      // resurrect the wiped credentials.
      const current = await getDevice();
      if (current && current.deviceId === device.deviceId) {
        await putDevice({ ...current, initialImportCompletedAt: new Date().toISOString() });
        console.log("HelixSync: initial import completed, initialImportCompletedAt stamped");
      } else {
        console.log("HelixSync: device disconnected or replaced during initial import, not stamping completion");
      }
    } catch (e) {
      // Left unstamped so the next startup retries; both backfills are safe
      // to re-run.
      console.error("HelixSync: initial bookmark/history import failed", e, {
        elapsedMs: Date.now() - importStartedAt,
      });
    } finally {
      initialImportInFlight = null;
    }
  })();
  await initialImportInFlight;
}

/** Runs on startup and on every REFRESH_CAPTURE_CONFIG (connect, settings
 * save). Each module's registerCapture is idempotent. */
async function initializeCaptureForSettings(): Promise<void> {
  const device = await getDevice();
  if (!device) return;

  // Independent of settings, so an offline settings fetch doesn't skip it.
  void ensureWebSocketConnected();

  // The live/bulk history boundary must be fixed before live capture can
  // see a single visit, or a visit during the bookmark backfill would be
  // counted by both paths. Set once per device and never recomputed.
  if (!device.initialImportCompletedAt && device.historyBulkEndMs === undefined) {
    const current = await getDevice();
    if (current && current.historyBulkEndMs === undefined) {
      await putDevice({ ...current, historyBulkEndMs: Date.now() });
    }
  }

  // Fail-open, same as each module's flush-time settings check: register
  // capture before the settings fetch so a transient/offline settings
  // failure never permanently strands a device with no listeners attached.
  registerBookmarkCapture();
  registerHistoryCapture();

  let settings;
  try {
    settings = await fetchSettings();
  } catch {
    return; // offline; toggles, tab capture, and initial import retried on the next wake
  }

  applyCaptureToggles(settings);

  // Tab sync defaults to off, so only it is gated on the setting.
  if (settings.syncTabs) {
    registerTabCapture();
  }

  if (!device.initialImportCompletedAt) {
    await runInitialImport(device);
  } else {
    console.log("HelixSync: initial import already completed at", device.initialImportCompletedAt);
  }
}

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Closes and deletes only tombstone these rows, so each type is capped.
// All caps are well above what the popup shows.
const REMOTE_OBJECT_CAPS: Partial<Record<ObjectType, number>> = {
  historyVisit: 2000,
  tab: 500,
  window: 200,
  tabGroup: 200,
};
const CONFLICTS_CAP = 500;
// Long enough for an offline peer to deliver the parent; a pruned child
// still heals via the next snapshot resync.
const DEFERRED_MATERIALIZATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Storage maintenance, at most once a day; a cheap no-op otherwise. */
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
  await pruneDeferredMaterializations(DEFERRED_MATERIALIZATION_RETENTION_MS);
  await gcFieldStates();
  await putSyncState({ ...state, lastMaintenanceAt: new Date().toISOString() });
}

async function runPeriodicSync(): Promise<void> {
  // Unregistered installs have nothing to sync, so skip before paying for a
  // connect attempt and a settings fetch.
  const device = await getDevice();
  if (!device) return;
  void ensureWebSocketConnected();
  try {
    await runSyncCycle();
    await updateBadge();
    await runMaintenanceIfDue().catch((e) =>
      console.error("HelixSync: storage maintenance failed", e),
    );
  } catch (e) {
    console.error("HelixSync: periodic sync failed", e);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureSyncAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensureSyncAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // The alarm is the one wake path that survives a worker restart, so it
  // doubles as the WebSocket reconnect backstop.
  if (alarm.name === SYNC_ALARM) {
    void runPeriodicSync();
  }
});

// Last-chance flush of buffered capture events before teardown. Best-effort:
// Chrome may kill the worker before the async writes complete.
chrome.runtime.onSuspend.addListener(() => {
  flushPendingTitleDebounces();
  flushAllMicroBatchQueues();
});

/** The popup runs in its own heap and may have just written the device or
 * settings, so this heap's in-memory mirrors must re-read from storage. */
function invalidateMemoryCaches(): void {
  invalidateDeviceMemory();
  invalidateSettingsMemory();
  invalidatePolicyMemory();
}

type PopupMessage =
  | { type: "SYNC_NOW" }
  | { type: "RESTORE_TAB"; objectId: string }
  | { type: "RESTORE_ALL_TABS" }
  | { type: "GET_STATUS" }
  | { type: "REFRESH_CAPTURE_CONFIG" }
  | { type: "DEVICE_DISCONNECTED" };

async function handleMessage(message: PopupMessage | undefined): Promise<unknown> {
  switch (message?.type) {
    case "SYNC_NOW": {
      await runSyncCycle();
      await updateBadge(true);
      return { ok: true };
    }
    case "RESTORE_TAB": {
      await restoreTab(message.objectId);
      await updateBadge(true);
      return { ok: true };
    }
    case "RESTORE_ALL_TABS": {
      const pending = await getPendingTabRestores();
      await restoreTabs(pending.map(({ objectId }) => objectId));
      await updateBadge(true);
      return { ok: true };
    }
    case "GET_STATUS": {
      const pendingCount = await getPendingCount();
      const state = await getSyncState();
      return {
        status: lastStatus,
        errorDetail: lastErrorDetail,
        pendingCount,
        lastSyncAt: state.lastSyncAt,
      };
    }
    case "REFRESH_CAPTURE_CONFIG": {
      invalidateMemoryCaches();
      await initializeCaptureForSettings();
      return { ok: true };
    }
    case "DEVICE_DISCONNECTED": {
      await disconnectWebSocket();
      await clearSyncBlockedState();
      // The popup already wiped IndexedDB from its own connection; wiping
      // here too keeps disconnect complete even if that raced or failed.
      await clearAllLocalData();
      invalidateMemoryCaches();
      return { ok: true };
    }
    default:
      return { error: "unknown_message_type" };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own popup may drive these handlers — one message
  // type wipes all local data, so a forged sender must never reach it.
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ error: "untrusted_sender" });
    return false;
  }

  handleMessage(message)
    .then(sendResponse)
    .catch((e) => {
      console.error("HelixSync: message handling failed", e);
      sendResponse({ error: "internal_error" });
    });
  return true; // keep the channel open for the async response
});

// No upload can survive a worker restart, so in-flight rows are reset on
// every start. Independent of crypto, so it runs as early as possible.
resetInFlightOperations().catch((e) =>
  console.error("HelixSync: failed to reset in-flight operations", e),
);

ensureCryptoReady()
  .then(initializeCaptureForSettings)
  .then(() => updateBadge())
  .catch((e) => console.error("HelixSync: startup failed", e));
