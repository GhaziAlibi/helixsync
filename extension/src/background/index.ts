// MV3 service worker entrypoint. Per docs/protocol.md §15.6, no state
// transition here may depend on an in-memory-only flag surviving a
// service worker restart — all durable state lives in IndexedDB
// (src/storage/db.ts), and this file only orchestrates.
import "../bookmarks";
import "../history";
import "../tabs";

import { ensureCryptoReady } from "../crypto";
import { fetchSettings, fetchTabRestorePolicy, invalidatePolicyMemory, invalidateSettingsMemory } from "../api/client";
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
// Backstop only: WebSocket pushes + local debounced sync give low latency,
// so the alarm can be infrequent. Every tick costs a wake + HTTPS download
// + badge walk even with zero changes — 1min was 1440 wakes/day.
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

// docs/protocol.md §12: purely a latency win over the alarm-driven cycle
// below — a "changes_available" push just runs the exact same sync cycle
// sooner than the next alarm tick would have. Routed through the debounced
// local-sync path rather than a direct runSyncCycle() call: a burst of N
// pushes collapses into one prompt cycle plus one trailing cycle (measured:
// 10 pushes at 300ms spacing ran 10 full cycles before, 2 after) instead of
// N full upload-probe + download round trips. updateBadge stays a direct
// call — it is throttle-gated before any IPC, so per-push cost is ~zero
// after the first call per window.
onChangesAvailable(() => {
  notifyPeerChanges();
  scheduleLocalSync();
  void updateBadge().catch((e) => console.error("HelixSync: WebSocket-triggered badge update failed", e));
});

/** Reflects the count of not-yet-restored remote tabs on the toolbar icon
 * when the "ask" restore policy is active, so the user notices without
 * opening the popup. Cleared for any other policy. Best-effort: a
 * transient failure (e.g. offline) just leaves the previous badge state
 * rather than erroring the caller.
 *
 * Throttled: the count walks every live tab row, and this runs on every
 * alarm tick plus every WebSocket push — reuse a fresh count for one alarm
 * interval instead of re-walking for back-to-back triggers. Must stay >=
 * SYNC_INTERVAL_MINUTES or every periodic tick re-walks unconditionally. */
let lastBadgeAt = 0;
let lastBadgeText = "";
const BADGE_THROTTLE_MS = SYNC_INTERVAL_MINUTES * 60_000;

export function resetBadgeStateForTesting(): void {
  lastBadgeAt = 0;
  lastBadgeText = "";
}

export async function updateBadge(force = false): Promise<void> {
  try {
    // Throttle first, before any IPC: this runs on every alarm tick plus
    // every WebSocket push, and the count walks every live tab row.
    const now = Date.now();
    if (!force && now - lastBadgeAt < BADGE_THROTTLE_MS) {
      return;
    }
    // Long-TTL policy cache (api/client.ts::fetchTabRestorePolicy): the badge
    // only needs tabRestorePolicy, and a 60s settings TTL would re-fetch over
    // HTTPS on every 5-minute tick just to re-learn an unchanged policy.
    const tabRestorePolicy = await fetchTabRestorePolicy();
    if (tabRestorePolicy !== "ask") {
      if (lastBadgeText !== "") {
        lastBadgeText = "";
        await chrome.action.setBadgeText({ text: "" });
      }
      // Throttle the settings fetch itself: most installs never use "ask",
      // so without this every tick pays a storage.session IPC (+ occasional
      // HTTPS) just to learn nothing changed.
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

// Guards the one-time bookmark/history import below against running twice
// concurrently within the same service-worker lifetime. `initializeCaptureForSettings`
// runs both from this module's own startup chain and from the
// REFRESH_CAPTURE_CONFIG message handler — and sending that message to a
// terminated service worker wakes a *fresh* one, whose startup chain then
// races the very message that woke it. Both racers read `initialImportCompletedAt`
// as unset (neither has stamped it yet) and both proceed to run the full
// bookmark+history backfill in parallel, doubling memory/CPU for the history
// enumeration below — observed to head straight for an OOM on a real profile.
// In-memory only (not durable state, per this file's header comment): it only
// needs to dedupe races within one worker instance, not survive a restart —
// `initialImportCompletedAt` in IndexedDB remains the durable completion marker.
let initialImportInFlight: Promise<void> | null = null;

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
  // operations at all*. The per-module capture-enabled flags below are the
  // synchronous listener-level kill-switches (no enqueue, no micro-batch
  // timer per event); each module's flush-time async gate is the backstop
  // for bursts already queued when the toggle flips. Flags fail-open to
  // true (see each module) so an offline settings fetch here simply keeps
  // capturing rather than losing user data. Tab capture registration itself
  // stays gated since tabs default to *disabled*.
  setBookmarkCaptureEnabled(settings.syncBookmarks !== false);
  setHistoryCaptureEnabled(settings.syncHistory !== false);
  setTabsCaptureEnabled(settings.syncTabs !== false);
  setTabGroupsCaptureEnabled(settings.syncTabGroups !== false);

  // Change 2 (exact live/import partition): fix `historyBulkEndMs` — the
  // boundary between what the one-time bulk import covers and what live
  // capture covers (history/index.ts's `flushVisitEvents` drops any visit
  // before it) — *before* `registerHistoryCapture` below can observe a
  // single visit. Previously this was set inside history/bulk.ts, only once
  // the history backfill itself started, which runs *after* the bookmark
  // backfill just below; any visit made during that bookmark backfill was
  // captured live (registerHistoryCapture had already run) *and* fell
  // inside the bulk enumeration's window (whose end was "now" at that later
  // point), double-counting it. Only set once per device — a device that
  // already has this (mid-import resume, or one that already completed its
  // import) must never have it recomputed to a fresh `Date.now()`, and a
  // device whose import already finished (`initialImportCompletedAt` set)
  // has nothing left to bound.
  if (!device.initialImportCompletedAt && device.historyBulkEndMs === undefined) {
    const current = await getDevice();
    if (current && current.historyBulkEndMs === undefined) {
      await putDevice({ ...current, historyBulkEndMs: Date.now() });
    }
  }

  registerBookmarkCapture();
  registerHistoryCapture();
  if (settings.syncTabs) {
    registerTabCapture();
  }

  if (!device.initialImportCompletedAt) {
    if (initialImportInFlight) {
      console.log("HelixSync: initial import already in flight on this worker, awaiting it instead of re-running");
      await initialImportInFlight;
      return;
    }
    console.log("HelixSync: initial import starting (initialImportCompletedAt unset)");
    const importStartedAt = Date.now();
    initialImportInFlight = (async () => {
      try {
        // Sequential rather than concurrent: both backfills hammer the same
        // single MV3 thread (IndexedDB + pure-TS crypto + browser IPC), so
        // running them together doubles peak memory/transaction contention
        // for no wall-clock win. History's high-water mark is persisted via
        // fresh getDevice() reads mid-run, so re-read the device before
        // stamping completion to avoid clobbering it with this stale snapshot.
        await backfillBookmarks();
        console.log("HelixSync: bookmark backfill returned", { elapsedMs: Date.now() - importStartedAt });
        await backfillHistory();
        console.log("HelixSync: history backfill returned", { elapsedMs: Date.now() - importStartedAt });
        const current = (await getDevice()) ?? device;
        await putDevice({ ...current, initialImportCompletedAt: new Date().toISOString() });
        console.log("HelixSync: initial import completed, initialImportCompletedAt stamped");
      } catch (e) {
        // Left unset so the next startup/alarm-driven call retries; both
        // backfills are safe to re-run (see their own docs).
        console.error("HelixSync: initial bookmark/history import failed", e, {
          elapsedMs: Date.now() - importStartedAt,
        });
      } finally {
        initialImportInFlight = null;
      }
    })();
    await initialImportInFlight;
  } else {
    console.log("HelixSync: initial import already completed at", device.initialImportCompletedAt);
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
// Deferred rows whose parent never arrives would otherwise sit forever —
// a 30-day retention matches gcFieldStates' own window: long enough for any
// legitimately offline peer to deliver the parent, short enough to bound the
// table. A pruned child still heals via the next snapshot resync.
const DEFERRED_MATERIALIZATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
  await pruneDeferredMaterializations(DEFERRED_MATERIALIZATION_RETENTION_MS);
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
  ensureSyncAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensureSyncAlarm();
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
    void (async () => {
      // Never-registered installs have nothing to sync, poll, or badge —
      // skip before paying for a WS connect attempt plus a settings fetch
      // that can only fail (measured: 1 fetchSettings + 1 ensureConnected
      // per tick before this gate). getDevice is memory/session-cached, so
      // the gate itself costs ~zero after the first tick per worker lifetime.
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
    })();
  }
});

// Best-effort last-chance flush of buffered bookmark/history/tab capture
// events right before Chrome tears down this service worker — see
// flushAllMicroBatchQueues's doc comment (sync/micro-batch.ts) for why this
// is a real improvement but not a guarantee (onSuspend's own processing-time
// limits).
chrome.runtime.onSuspend.addListener(() => {
  flushPendingTitleDebounces();
  flushAllMicroBatchQueues();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "SYNC_NOW": {
        await runSyncCycle();
        await updateBadge(true);
        sendResponse({ ok: true });
        return;
      }
      case "RESTORE_TAB": {
        await restoreTab(message.objectId);
        await updateBadge(true);
        sendResponse({ ok: true });
        return;
      }
      case "RESTORE_ALL_TABS": {
        // Field states are prefetched once inside restoreTabs (one batch
        // read) instead of one transaction per tab, and materialization
        // runs with bounded concurrency there — see its doc comment.
        const pending = await getPendingTabRestores();
        await restoreTabs(pending.map(({ objectId }) => objectId));
        await updateBadge(true);
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
        // Popup (different heap) just wrote device/settings to session+IDB.
        // Drop this heap's mirrors first so initializeCaptureForSettings
        // re-hydrates fresh instead of serving stale pre-register/pre-save
        // values until the next worker restart (perf audit P0-1).
        invalidateDeviceMemory();
        invalidateSettingsMemory();
        invalidatePolicyMemory();
        await initializeCaptureForSettings();
        sendResponse({ ok: true });
        return;
      }
      case "DEVICE_DISCONNECTED": {
        await disconnectWebSocket();
        await clearSyncBlockedState();
        // Full local wipe, not just credential removal: the popup already
        // cleared IDB from its heap, but this heap holds a separate IDB
        // connection — clearing here too makes disconnect robust even if the
        // popup's clear raced or failed partway. All stores are empty after
        // this, so a later reconnect starts clean instead of resuming a stale
        // pending queue / mappings.
        await clearAllLocalData();
        // Popup already cleared session+IDB; drop this heap's mirrors too
        // so the next alarm does not sync with a deleted device's tokens.
        invalidateDeviceMemory();
        invalidateSettingsMemory();
        invalidatePolicyMemory();
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
  .then(() => updateBadge())
  .catch((e) => console.error("HelixSync: startup failed", e));
