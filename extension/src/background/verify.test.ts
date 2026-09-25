import { describe, expect, it, vi } from "vitest";

// Verifies perf fixes P3 (badge throttle-before-fetch + skip-identical) and
// P5 (sequential backfills) through the real background module with mocked
// collaborators.

const events: string[] = [];
let fetchSettingsCalls = 0;
let setBadgeCalls: Array<{ text: string }> = [];
let countCalls = 0;
let pendingCount = 3;
let tabRestorePolicy: "ask" | "disabled" = "ask";
let runSyncCalls = 0;

let alarmListener: ((alarm: { name: string }) => void) | undefined;
let messageListener:
  | ((message: { type: string }, sender: unknown, sendResponse: (r: unknown) => void) => boolean)
  | undefined;
let changesListener: (() => void) | undefined;

const flushMicrotasks = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    onSuspend: { addListener: vi.fn() },
    onMessage: {
      addListener: vi.fn((cb) => {
        messageListener = cb;
      }),
    },
  },
  alarms: {
    create: vi.fn(),
    onAlarm: {
      addListener: vi.fn((cb) => {
        alarmListener = cb;
      }),
    },
  },
  action: {
    setBadgeText: vi.fn(async ({ text }: { text: string }) => {
      setBadgeCalls.push({ text });
    }),
  },
};

vi.mock("../bookmarks", () => ({
  backfillExisting: vi.fn(async () => {
    events.push("bookmarks-start");
    await new Promise((r) => setTimeout(r, 1000));
    events.push("bookmarks-end");
  }),
  registerCapture: vi.fn(),
  setBookmarkCaptureEnabled: vi.fn(),
}));

// Change 2 (exact live/import partition): records the relative order of
// "historyBulkEndMs persisted" vs. "history capture registered" so the test
// below can assert the fix's actual ordering guarantee, not just that both
// eventually happen.
const orderLog: string[] = [];

vi.mock("../history", () => ({
  backfillExisting: vi.fn(async () => {
    events.push("history-start");
    events.push("history-end");
  }),
  registerCapture: vi.fn(() => {
    orderLog.push("registerHistoryCapture");
  }),
  setHistoryCaptureEnabled: vi.fn(),
}));

vi.mock("../tabs", () => ({
  flushPendingTitleDebounces: vi.fn(),
  registerCapture: vi.fn(),
  restoreTab: vi.fn(),
  restoreTabs: vi.fn(),
  setTabGroupsCaptureEnabled: vi.fn(),
  setTabsCaptureEnabled: vi.fn(),
}));

vi.mock("../crypto", () => ({
  ensureCryptoReady: vi.fn(async () => {}),
}));

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(async () => {
    fetchSettingsCalls++;
    return { tabRestorePolicy };
  }),
  // updateBadge/restorePolicy read through the long-TTL policy cache in
  // production; here it shares the same counter so the throttle assertions
  // below count policy reads exactly as they used to count settings reads.
  fetchTabRestorePolicy: vi.fn(async () => {
    fetchSettingsCalls++;
    return tabRestorePolicy;
  }),
  invalidateSettingsMemory: vi.fn(),
  invalidatePolicyMemory: vi.fn(),
}));

vi.mock("../api/websocket", () => ({
  disconnect: vi.fn(),
  ensureConnected: vi.fn(),
  onChangesAvailable: vi.fn((cb: () => void) => {
    changesListener = cb;
  }),
}));

// Stateful device mirror (rather than a fixed object `getDevice` always
// returns): Change 2's ordering test below needs `putDevice`'s write of
// `historyBulkEndMs` to actually be visible to the *next* `getDevice()`
// call, the same way the real chrome.storage.session-backed cache in
// storage/db.ts behaves — otherwise a second `initializeCaptureForSettings`
// run (e.g. via REFRESH_CAPTURE_CONFIG) could never observe that the field
// is already set and would look indistinguishable from the first run.
let mockDevice: Record<string, unknown> = {
  id: "self",
  serverUrl: "https://example.test",
  deviceId: "device-1",
  userId: "user-1",
  email: "user@example.test",
  accessToken: "t",
  accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  refreshToken: "r",
  encryptionRootKey: "rek",
  encryptionRootKeyVersion: 1,
};
const putDeviceCalls: Array<Record<string, unknown>> = [];

vi.mock("../storage/db", () => ({
  clearAllLocalData: vi.fn(async () => {}),
  countPendingTabRestores: vi.fn(async () => {
    countCalls++;
    return pendingCount;
  }),
  gcFieldStates: vi.fn(),
  getDevice: vi.fn(async () => mockDevice),
  getPendingTabRestores: vi.fn(async () => []),
  getSyncState: vi.fn(async () => ({
    id: "self",
    cursor: 0,
    lamportClock: 0,
    deviceSequence: 0,
    lastMaintenanceAt: new Date().toISOString(),
  })),
  invalidateDeviceMemory: vi.fn(),
  putDevice: vi.fn(async (record: Record<string, unknown>) => {
    mockDevice = record;
    putDeviceCalls.push(record);
    if (record.historyBulkEndMs !== undefined) {
      orderLog.push("putDevice:historyBulkEndMs");
    }
  }),
  putSyncState: vi.fn(),
  pruneAppliedOperations: vi.fn(),
  pruneConflicts: vi.fn(),
  pruneDeferredMaterializations: vi.fn(),
  pruneRemoteObjectsByType: vi.fn(),
  resetInFlightOperations: vi.fn(async () => {}),
}));

let scheduleLocalSyncCalls = 0;
let notifyPeerChangesCalls = 0;
vi.mock("../sync/engine", () => ({
  clearSyncBlockedState: vi.fn(),
  getPendingCount: vi.fn(async () => 0),
  notifyPeerChanges: vi.fn(() => {
    notifyPeerChangesCalls++;
  }),
  onStatusChange: vi.fn(),
  runSyncCycle: vi.fn(async () => {
    runSyncCalls++;
  }),
  scheduleLocalSync: vi.fn(() => {
    scheduleLocalSyncCalls++;
  }),
}));

vi.mock("../sync/micro-batch", () => ({
  flushAllMicroBatchQueues: vi.fn(),
}));

// Fake timers from here on so the P5 backfill test (which runs first, right
// after the import below kicks the startup chain) controls the bookmarks
// mock's 1000ms timer. Later describes re-enable timers per test.
vi.useFakeTimers();

const bg = await import("./index");

describe("sequential backfills (perf fix P5)", () => {
  it("starts history backfill only after bookmarks backfill finishes", async () => {
    try {
      // The startup chain was kicked at import; bookmarks stalls 1000ms on a
      // timer while history would resolve immediately — under the old
      // Promise.all, history-start would already be recorded.
      await flushMicrotasks();
      expect(events).toEqual(["bookmarks-start"]);
      expect(events).not.toContain("history-start");

      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
      expect(events).toEqual(["bookmarks-start", "bookmarks-end", "history-start", "history-end"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("historyBulkEndMs set before capture registration (Change 2)", () => {
  it("persists historyBulkEndMs before registerHistoryCapture runs, on first initialize", () => {
    // The startup chain already ran to completion during the "sequential
    // backfills" test above (it awaited the full bookmarks->history chain).
    // `historyBulkEndMs` must have been persisted strictly before
    // `registerCapture` (history) was called — not merely "at some point".
    const putIndex = orderLog.indexOf("putDevice:historyBulkEndMs");
    const registerIndex = orderLog.indexOf("registerHistoryCapture");
    expect(putIndex).toBeGreaterThanOrEqual(0);
    expect(registerIndex).toBeGreaterThanOrEqual(0);
    expect(putIndex).toBeLessThan(registerIndex);
    expect(mockDevice.historyBulkEndMs).toEqual(expect.any(Number));
  });

  it("does not overwrite historyBulkEndMs on a later REFRESH_CAPTURE_CONFIG", async () => {
    const persisted = mockDevice.historyBulkEndMs;
    const putCallsBefore = putDeviceCalls.filter((r) => r.historyBulkEndMs !== undefined).length;

    expect(messageListener).toBeDefined();
    messageListener!({ type: "REFRESH_CAPTURE_CONFIG" }, {}, vi.fn());
    await flushMicrotasks();

    const putCallsAfter = putDeviceCalls.filter((r) => r.historyBulkEndMs !== undefined).length;
    expect(putCallsAfter).toBe(putCallsBefore);
    expect(mockDevice.historyBulkEndMs).toBe(persisted);
  });
});

describe("badge throttle (perf fix P3)", () => {
  it("throttles recounts, skips identical badge writes, forces on demand", async () => {
    vi.useFakeTimers();
    try {
      bg.resetBadgeStateForTesting();
      fetchSettingsCalls = 0;
      setBadgeCalls = [];
      countCalls = 0;
      pendingCount = 3;
      tabRestorePolicy = "ask";

      await bg.updateBadge();
      expect(fetchSettingsCalls).toBe(1);
      expect(countCalls).toBe(1);
      expect(setBadgeCalls).toEqual([{ text: "3" }]);

      // Immediate second tick: fully throttled — no settings IPC at all.
      await bg.updateBadge();
      expect(fetchSettingsCalls).toBe(1);
      expect(countCalls).toBe(1);
      expect(setBadgeCalls).toHaveLength(1);

      // After the window with an unchanged count: re-fetches, but skips the
      // identical chrome.action write. Window tracks SYNC_INTERVAL_MINUTES
      // (5min) so periodic ticks re-walk at most once per interval.
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
      await bg.updateBadge();
      expect(fetchSettingsCalls).toBe(2);
      expect(countCalls).toBe(2);
      expect(setBadgeCalls).toHaveLength(1);

      // Changed count: writes once.
      pendingCount = 5;
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
      await bg.updateBadge();
      expect(setBadgeCalls).toEqual([{ text: "3" }, { text: "5" }]);

      // Forced updates bypass the throttle.
      await bg.updateBadge();
      expect(fetchSettingsCalls).toBe(3);
      await bg.updateBadge(true);
      expect(fetchSettingsCalls).toBe(4);
      expect(countCalls).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a non-ask badge once and does not rewrite it", async () => {
    vi.useFakeTimers();
    try {
      bg.resetBadgeStateForTesting();
      fetchSettingsCalls = 0;
      setBadgeCalls = [];
      tabRestorePolicy = "ask";
      pendingCount = 2;
      await bg.updateBadge();
      expect(setBadgeCalls).toEqual([{ text: "2" }]);

      tabRestorePolicy = "disabled";
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
      await bg.updateBadge();
      expect(setBadgeCalls).toEqual([{ text: "2" }, { text: "" }]);
      await bg.updateBadge();
      expect(setBadgeCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      tabRestorePolicy = "ask";
    }
  });
});

describe("alarm and push wiring (unchanged behavior)", () => {
  it("alarm triggers sync and badge; WS push debounces instead of syncing directly", async () => {
    vi.useFakeTimers();
    try {
      bg.resetBadgeStateForTesting();
      runSyncCalls = 0;
      scheduleLocalSyncCalls = 0;
      fetchSettingsCalls = 0;
      expect(alarmListener).toBeDefined();
      alarmListener!({ name: "helixsync-periodic-sync" });
      await flushMicrotasks();
      // runSyncCycle + updateBadge + maintenance-check all ran.
      expect(runSyncCalls).toBe(1);
      expect(fetchSettingsCalls).toBe(1);

      // A push burst coalesces through the debounced local-sync path (perf:
      // 10 pushes at 300ms spacing ran 10 full cycles before, 2 after)
      // instead of one direct runSyncCycle per push. The badge still updates
      // via its own throttle-gated path.
      expect(changesListener).toBeDefined();
      for (let i = 0; i < 10; i++) changesListener!();
      await flushMicrotasks();
      expect(scheduleLocalSyncCalls).toBe(10);
      expect(notifyPeerChangesCalls).toBe(10);
      expect(runSyncCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("SYNC_NOW forces a badge recount inside the throttle window", async () => {
    vi.useFakeTimers();
    try {
      bg.resetBadgeStateForTesting();
      fetchSettingsCalls = 0;
      countCalls = 0;
      runSyncCalls = 0;
      tabRestorePolicy = "ask";
      pendingCount = 1;

      expect(messageListener).toBeDefined();
      messageListener!({ type: "SYNC_NOW" }, {}, vi.fn());
      await flushMicrotasks();
      expect(runSyncCalls).toBe(1);
      const afterFirst = fetchSettingsCalls;
      expect(afterFirst).toBe(1);

      // Second SYNC_NOW immediately after: force bypasses the throttle.
      messageListener!({ type: "SYNC_NOW" }, {}, vi.fn());
      await flushMicrotasks();
      expect(fetchSettingsCalls).toBe(afterFirst + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
