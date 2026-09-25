import { describe, expect, it, vi } from "vitest";

// [SEC-15] regression: disconnect during the initial import must not be
// undone by the import-completion write. The old code fell back to the
// pre-import `device` snapshot (`(await getDevice()) ?? device`) when the
// record was gone, resurrecting the wiped account key, tokens and server
// URL. This file runs the real background module's startup chain with
// `backfillBookmarks` stalled on a timer, clears the device store mid-stall
// (simulating a concurrent disconnect), then lets the chain finish and
// asserts the device store is still empty.

const flushMicrotasks = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    onSuspend: { addListener: vi.fn() },
    onMessage: { addListener: vi.fn() },
  },
  alarms: {
    create: vi.fn(),
    onAlarm: { addListener: vi.fn() },
  },
  action: {
    setBadgeText: vi.fn(async () => {}),
  },
};

vi.mock("../bookmarks", () => ({
  backfillExisting: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 1000));
  }),
  registerCapture: vi.fn(),
  setBookmarkCaptureEnabled: vi.fn(),
}));

vi.mock("../history", () => ({
  backfillExisting: vi.fn(async () => {}),
  registerCapture: vi.fn(),
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
  fetchSettings: vi.fn(async () => ({ tabRestorePolicy: "ask" })),
  fetchTabRestorePolicy: vi.fn(async () => "ask"),
  invalidateSettingsMemory: vi.fn(),
  invalidatePolicyMemory: vi.fn(),
}));

vi.mock("../api/websocket", () => ({
  disconnect: vi.fn(),
  ensureConnected: vi.fn(),
  onChangesAvailable: vi.fn(),
}));

const initialDevice: Record<string, unknown> = {
  id: "self",
  serverUrl: "https://example.test",
  deviceId: "device-1",
  userId: "user-1",
  email: "user@example.test",
  accessToken: "t",
  accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  refreshToken: "r",
  accountKey: "rek",
  accountKeyVersion: 1,
};

let mockDevice: Record<string, unknown> | undefined = { ...initialDevice };
const putDeviceCalls: Array<Record<string, unknown>> = [];

vi.mock("../storage/db", () => ({
  clearAllLocalData: vi.fn(async () => {}),
  countPendingTabRestores: vi.fn(async () => 0),
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
  }),
  putSyncState: vi.fn(),
  pruneAppliedOperations: vi.fn(),
  pruneConflicts: vi.fn(),
  pruneDeferredMaterializations: vi.fn(),
  pruneRemoteObjectsByType: vi.fn(),
  resetInFlightOperations: vi.fn(async () => {}),
}));

vi.mock("../sync/engine", () => ({
  clearSyncBlockedState: vi.fn(),
  getPendingCount: vi.fn(async () => 0),
  notifyPeerChanges: vi.fn(),
  onStatusChange: vi.fn(),
  runSyncCycle: vi.fn(async () => {}),
  scheduleLocalSync: vi.fn(),
}));

vi.mock("../sync/micro-batch", () => ({
  flushAllMicroBatchQueues: vi.fn(),
}));

vi.useFakeTimers();
await import("./index");

describe("[SEC-15] initial-import completion stamp vs. concurrent disconnect", () => {
  it("does not resurrect the device record if disconnect clears it mid-import", async () => {
    try {
      // The startup chain kicked at import and is stalled inside
      // backfillBookmarks (1000ms timer). Simulate the popup's disconnect
      // handler wiping the device store while that backfill is still running.
      await flushMicrotasks();
      mockDevice = undefined;

      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();

      expect(mockDevice).toBeUndefined();
      expect(putDeviceCalls.some((r) => r.initialImportCompletedAt !== undefined)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
