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
  listAuthRequests,
  type UserSettingsDto,
} from "../api/client";
import {
  disconnect as disconnectWebSocket,
  ensureConnected as ensureWebSocketConnected,
  onAuthRequest,
  onChangesAvailable,
  onTabSend,
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
  updateSyncState,
  pruneAppliedOperations,
  pruneConflicts,
  pruneDeferredMaterializations,
  pruneRemoteObjectsByType,
  resetInFlightOperations,
  type DeviceRecord,
} from "../storage/db";
import {
  clearSyncBlockedState,
  downloadEverything,
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
  materializeWaitingLazyRoots,
  registerCapture as registerBookmarkCapture,
  setBookmarkCaptureEnabled,
  setLinkExistingBookmarks,
  sweepStaleBookmarkMappingsOnce,
} from "../bookmarks";
import {
  backfillExisting as backfillHistory,
  importOlderHistory,
  registerCapture as registerHistoryCapture,
  setHistoryCaptureEnabled,
} from "../history";
import {
  createPreImportPoint,
  drainRestorePointOutbox,
  clearRestorePointTriggerState,
  ensureRestorePointAlarm,
  installRestorePointTriggers,
  RESTORE_POINT_ALARM,
  runScheduledRestorePoint,
} from "../restore-points/triggers";
import { resumeInterruptedRestore, clearLoadedRestorePoint } from "../restore-points/restore";
import * as restorePointService from "../restore-points/service";
import {
  captureOpenTabs,
  flushPendingTitleDebounces,
  registerCapture as registerTabCapture,
  restoreTab,
  restoreTabs,
  setTabGroupsCaptureEnabled,
  setTabsCaptureEnabled,
} from "../tabs";
import { handleTabSend } from "../send-tab/receive";
import { sendTabToDevice } from "../send-tab/send";
import { refreshSendTabMenu, registerSendTabMenu } from "../send-tab/menu";
import { singleFlight } from "../util/single-flight";
import { platform } from "@platform";

const SYNC_ALARM = "helixsync-periodic-sync";
// A backstop only: WebSocket pushes and local nudges provide the low
// latency, and every tick costs a wake plus an HTTPS round trip.
const SYNC_INTERVAL_MINUTES = 5;

function ensureSyncAlarm(): void {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MINUTES });
}

let lastStatus: SyncStatus = "idle";
let lastErrorDetail: string | undefined;
let lastErrorCode: string | undefined;

onStatusChange((status, detail, code) => {
  lastStatus = status;
  lastErrorDetail = detail;
  lastErrorCode = code;
});

// A push goes through the throttled local-sync path so a burst of pushes
// collapses into a couple of cycles instead of one per push.
onChangesAvailable(() => {
  notifyPeerChanges();
  scheduleLocalSync();
  void updateBadge().catch((e) => console.error("HelixSync: WebSocket-triggered badge update failed", e));
});

// A login-with-device request was created or answered: recount right away,
// since a request expires in 15 minutes.
onAuthRequest(() => {
  void refreshPendingAuthRequests()
    .then((changed) => (changed ? updateBadge(true) : undefined))
    .catch((e) => console.error("HelixSync: sign-in request badge update failed", e));
});

// A tab another device sent to this one (docs/protocol.md §12.5).
onTabSend((frame) => {
  void handleTabSend(frame);
});

// Recounting walks every live remote tab and this runs on every tick and
// push, so a fresh count is reused for one alarm interval. Must stay >= the
// alarm interval or every tick recounts.
let lastBadgeAt = 0;
let lastBadgeText = "";
const BADGE_THROTTLE_MS = SYNC_INTERVAL_MINUTES * 60_000;

// Sign-in requests waiting for this account's approval (docs/protocol.md
// §7.4), as of the last check. The popup lists and answers them.
let pendingAuthRequestCount = 0;
const AUTH_REQUEST_BADGE = "!";

export function resetBadgeStateForTesting(): void {
  lastBadgeAt = 0;
  lastBadgeText = "";
  pendingAuthRequestCount = 0;
}

const SEND_FEEDBACK_BADGE_MS = 3_000;

/** Brief send-tab feedback on the toolbar button, then back to the usual
 * badge. Sets the badge mirror so `updateBadge` clears it afterwards. */
function flashSendBadge(text: string): void {
  lastBadgeText = text;
  void (async () => {
    try {
      await platform.toolbarAction().setBadgeText({ text });
    } catch {
      // Feedback only.
    }
  })();
  setTimeout(() => void updateBadge(true), SEND_FEEDBACK_BADGE_MS);
}

registerSendTabMenu({ flashBadge: flashSendBadge });

function refreshSendTabMenuQuietly(): void {
  void refreshSendTabMenu().catch((e) => console.warn("HelixSync: send-tab menu refresh failed", e));
}

/** Re-checks the account's waiting sign-in requests. Runs on the WebSocket
 * hint and on every periodic sync, since a hint can be missed. Returns
 * whether the count changed. */
async function refreshPendingAuthRequests(): Promise<boolean> {
  if (!(await getDevice())) return false;
  let count: number;
  try {
    count = (await listAuthRequests()).length;
  } catch (e) {
    console.warn("HelixSync: could not check for sign-in requests", e);
    return false;
  }
  const changed = count !== pendingAuthRequestCount;
  pendingAuthRequestCount = count;
  return changed;
}

/** Shows "!" while a sign-in request waits for approval; otherwise the
 * number of not-yet-restored remote tabs under the "ask" policy, and clears
 * the badge otherwise. Best-effort: failures keep the previous badge. */
export async function updateBadge(force = false): Promise<void> {
  try {
    // Throttled before any IPC.
    const now = Date.now();
    if (!force && now - lastBadgeAt < BADGE_THROTTLE_MS) {
      return;
    }
    // Not connected (a new install, or after Disconnect): nothing to show,
    // and the settings the rest reads need a device.
    if (!(await getDevice())) {
      lastBadgeAt = now;
      if (lastBadgeText !== "" || force) {
        lastBadgeText = "";
        await platform.toolbarAction().setBadgeText({ text: "" });
      }
      return;
    }
    // A waiting sign-in request outranks the tab count: it expires soon.
    if (pendingAuthRequestCount > 0) {
      lastBadgeAt = now;
      if (lastBadgeText !== AUTH_REQUEST_BADGE || force) {
        lastBadgeText = AUTH_REQUEST_BADGE;
        await platform.toolbarAction().setBadgeText({ text: AUTH_REQUEST_BADGE });
      }
      return;
    }
    const tabRestorePolicy = await fetchTabRestorePolicy();
    if (tabRestorePolicy !== "ask") {
      if (lastBadgeText !== "") {
        lastBadgeText = "";
        await platform.toolbarAction().setBadgeText({ text: "" });
      }
      lastBadgeAt = now;
      return;
    }
    const pendingCount = await countPendingTabRestores();
    lastBadgeAt = now;
    const nextText = pendingCount > 0 ? String(pendingCount) : "";
    if (nextText !== lastBadgeText || force) {
      lastBadgeText = nextText;
      await platform.toolbarAction().setBadgeText({ text: nextText });
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
      // The account first, so bookmarks this browser already shares with it
      // are linked to the account's copies rather than uploaded as second
      // ones (bookmarks/index.ts). History is unaffected: its import stops
      // at historyBulkEndMs, before any visit replayed by this download.
      setLinkExistingBookmarks(true);
      try {
        await downloadEverything();
      } finally {
        setLinkExistingBookmarks(false);
      }
      console.log("HelixSync: account download before import returned", { elapsedMs: Date.now() - importStartedAt });
      // The account's own bookmarks are in; this browser's are not uploaded
      // yet. If the two differ, a point of the account's state is the way
      // back from what the import adds.
      await createPreImportPoint();
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

/** Older-history import (popup button after retention is widened). Waits for
 * an in-flight initial import, which it must not overlap. Never throws: it
 * runs detached, and a persisted scope is retried on the next startup. */
const runOlderHistoryImport = singleFlight(async (): Promise<void> => {
  if (initialImportInFlight) await initialImportInFlight;
  try {
    await importOlderHistory();
  } catch (e) {
    console.error("HelixSync: older history import failed", e);
  }
});

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
    // Every time, not only at first registration: see captureOpenTabs.
    captureOpenTabs();
  }

  if (!device.initialImportCompletedAt) {
    await runInitialImport(device);
    // The server's push announces only changes made after this device
    // connected, so nothing would prompt its first pull until the periodic
    // alarm, minutes away. Pull what the account already holds now.
    void runSyncCycle().catch((e) => console.error("HelixSync: first sync after connecting failed", e));
  } else {
    console.log("HelixSync: initial import already completed at", device.initialImportCompletedAt);
    // Resume an older-history import a worker restart interrupted. Detached:
    // it can run for minutes, and this function is awaited by settings save.
    if (device.historyOlderCutoffMs !== undefined) void runOlderHistoryImport();
  }
}

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Closes and deletes only tombstone these rows, so each type is capped.
// All caps are well above what the popup shows.
const REMOTE_OBJECT_CAPS: Partial<Record<ObjectType, number>> = {
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
  await updateSyncState({ lastMaintenanceAt: new Date().toISOString() });
}

async function runPeriodicSync(): Promise<void> {
  // Unregistered installs have nothing to sync, so skip before paying for a
  // connect attempt and a settings fetch.
  const device = await getDevice();
  if (!device) return;
  void ensureWebSocketConnected();
  refreshSendTabMenuQuietly();
  try {
    await runSyncCycle();
    await updateBadge(await refreshPendingAuthRequests());
    await runMaintenanceIfDue().catch((e) =>
      console.error("HelixSync: storage maintenance failed", e),
    );
    await drainRestorePointOutbox();
  } catch (e) {
    console.error("HelixSync: periodic sync failed", e);
  }
}

installRestorePointTriggers();

// An event that wakes a stopped worker is delivered only to listeners added
// while the script first runs, so capture is registered here and not after
// the async startup below, or a bookmark or visit that woke the worker would
// be missed. Both are idempotent; with no device their flushes do nothing.
registerBookmarkCapture();
registerHistoryCapture();

chrome.runtime.onInstalled.addListener(() => {
  ensureSyncAlarm();
  ensureRestorePointAlarm();
  refreshSendTabMenuQuietly();
});

chrome.runtime.onStartup.addListener(() => {
  ensureSyncAlarm();
  ensureRestorePointAlarm();
  refreshSendTabMenuQuietly();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // The alarm is the one wake path that survives a worker restart, so it
  // doubles as the WebSocket reconnect backstop.
  if (alarm.name === SYNC_ALARM) {
    void runPeriodicSync();
  } else if (alarm.name === RESTORE_POINT_ALARM) {
    void runScheduledRestorePoint().catch((e) => console.error("HelixSync: scheduled restore point failed", e));
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
  | { type: "IMPORT_OLDER_HISTORY" }
  | { type: "DEVICE_DISCONNECTED" }
  | { type: "LIST_RESTORE_POINTS" }
  | { type: "CREATE_RESTORE_POINT" }
  | { type: "GET_RESTORE_POINT_TREE"; pointId: string }
  | { type: "PREVIEW_RESTORE"; pointId: string; mode: "merge" | "exact"; scope: string }
  | { type: "START_RESTORE"; pointId: string; mode: "merge" | "exact"; scope: string }
  | { type: "GET_RESTORE_PROGRESS" }
  | { type: "DISMISS_RESTORE_PROGRESS" }
  | { type: "SET_RESTORE_POINT_PINNED"; pointId: string; pinned: boolean }
  | { type: "DELETE_RESTORE_POINT"; pointId: string }
  | { type: "LIST_SEND_TARGETS" }
  | { type: "SEND_TAB"; deviceId: string; url: string; title?: string };

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
        errorCode: lastErrorCode,
        pendingCount,
        lastSyncAt: state.lastSyncAt,
      };
    }
    case "REFRESH_CAPTURE_CONFIG": {
      invalidateMemoryCaches();
      await initializeCaptureForSettings();
      refreshSendTabMenuQuietly();
      return { ok: true };
    }
    case "LIST_SEND_TARGETS": {
      // Also rebuilds the context menu, so opening the popup keeps it fresh.
      try {
        return { ok: true, devices: await refreshSendTabMenu() };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    case "SEND_TAB":
      return sendTabToDevice(message.deviceId, message.url, message.title);
    case "IMPORT_OLDER_HISTORY": {
      // Detached: the popup closes long before a large import finishes.
      void runOlderHistoryImport();
      return { ok: true };
    }
    case "LIST_RESTORE_POINTS":
      return restorePointService.listForPopup();
    case "CREATE_RESTORE_POINT":
      return restorePointService.createManual();
    case "GET_RESTORE_POINT_TREE":
      return restorePointService.folderTree(message.pointId);
    case "PREVIEW_RESTORE":
      return restorePointService.preview({ pointId: message.pointId, mode: message.mode, scope: message.scope });
    case "START_RESTORE":
      return restorePointService.start({ pointId: message.pointId, mode: message.mode, scope: message.scope });
    case "GET_RESTORE_PROGRESS":
      return restorePointService.progress();
    case "DISMISS_RESTORE_PROGRESS":
      return restorePointService.dismissProgress();
    case "SET_RESTORE_POINT_PINNED":
      return restorePointService.pin(message.pointId, message.pinned);
    case "DELETE_RESTORE_POINT":
      return restorePointService.remove(message.pointId);
    case "DEVICE_DISCONNECTED": {
      await disconnectWebSocket();
      await clearSyncBlockedState();
      await clearRestorePointTriggerState();
      clearLoadedRestorePoint();
      // The popup already wiped IndexedDB from its own connection; wiping
      // here too keeps disconnect complete even if that raced or failed.
      await clearAllLocalData();
      invalidateMemoryCaches();
      // No device any more: this removes the menu.
      refreshSendTabMenuQuietly();
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
  .then(async () => {
    const device = await getDevice();
    if (!device?.initialImportCompletedAt) return;
    // Once per browser: mappings of nodes a deleted folder took with it.
    await sweepStaleBookmarkMappingsOnce().catch((e) => console.error("HelixSync: bookmark mapping sweep failed", e));
    await materializeWaitingLazyRoots().catch((e) => console.error("HelixSync: could not apply bookmarks waiting on a root", e));
    await resumeInterruptedRestore().catch((e) => console.error("HelixSync: could not resume the restore", e));
    await drainRestorePointOutbox();
  })
  .then(() => updateBadge())
  .catch((e) => console.error("HelixSync: startup failed", e));
