import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingLocalOperation } from "../sync/engine";

// Verifies perf fix P4: a lone tab-switch flush must skip the full prefetch
// pipeline, and repeat onActivated events for the same tab must not even
// reach the queue.

let onActivatedListener: ((info: { tabId: number; windowId: number }) => void) | undefined;

(globalThis as unknown as { chrome: unknown }).chrome = {
  windows: {
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  tabs: {
    onCreated: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
    onActivated: {
      addListener: vi.fn((cb) => {
        onActivatedListener = cb;
      }),
    },
    onRemoved: { addListener: vi.fn() },
    update: vi.fn(),
    create: vi.fn(),
  },
  tabGroups: undefined,
};

const getFieldStateMock = vi.fn<(objectId: string, field: string) => Promise<{ value: unknown } | undefined>>();
const getMappingsByLocalIdsMock = vi.fn(async (_t: unknown, _i: unknown) => new Map());

vi.mock("../storage/db", () => ({
  getFieldState: (objectId: string, field: string) => getFieldStateMock(objectId, field),
  getFieldStatesForObjects: vi.fn(async () => new Map()),
  getMappingsByLocalIds: (t: unknown, i: unknown) => getMappingsByLocalIdsMock(t, i),
  putRemoteObject: vi.fn(),
}));

const lookupObjectIdMock = vi.fn(
  async (_type: string, localId: string): Promise<string | undefined> => `tab-${localId}`,
);

vi.mock("../sync/mapping", () => ({
  establishMapping: vi.fn(),
  forgetMapping: vi.fn(),
  getOrCreateObjectId: vi.fn(),
  lookupChromiumLocalId: vi.fn(),
  lookupObjectId: (type: string, id: string) => lookupObjectIdMock(type, id),
}));

const recordLocalFieldStateMock = vi.fn();

vi.mock("../sync/conflict", () => ({
  recordLocalFieldState: (...args: unknown[]) => recordLocalFieldStateMock(...args),
  recordLocalFieldStatesBatch: vi.fn(),
  resolveField: vi.fn(),
  resolveFields: vi.fn(),
}));

const createLocalOperationsBatchMock = vi.fn(async (items: PendingLocalOperation[]) => {
  return items.map((_item, idx) => ({
    operation: { operationId: `op-${idx}`, lamportTimestamp: idx + 1 },
    deviceId: "device-1",
  }));
});
const scheduleLocalSyncMock = vi.fn();

vi.mock("../sync/engine", () => ({
  createLocalOperation: vi.fn(),
  createLocalOperationsBatch: (items: PendingLocalOperation[]) => createLocalOperationsBatchMock(items),
  registerApplier: vi.fn(),
  registerBatchApplier: vi.fn(),
  scheduleLocalSync: () => scheduleLocalSyncMock(),
}));

const { flushTabEvents, registerCapture, resetCaptureStateForTesting } = await import("./index");

const flushMicrotasks = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  createLocalOperationsBatchMock.mockClear();
  recordLocalFieldStateMock.mockClear();
  scheduleLocalSyncMock.mockClear();
  getMappingsByLocalIdsMock.mockClear();
  lookupObjectIdMock.mockClear();
  getFieldStateMock.mockReset();
  getFieldStateMock.mockResolvedValue(undefined);
  resetCaptureStateForTesting();
  registerCapture();
});

describe("single-activate fast path (perf fix P4)", () => {
  it("writes one activate op with 2 IDB reads and no prefetch or immediate sync", async () => {
    await flushTabEvents([{ kind: "tabActivated", activeInfo: { tabId: 7, windowId: 1 } }]);
    await flushMicrotasks();

    expect(lookupObjectIdMock).toHaveBeenCalledTimes(1);
    expect(getMappingsByLocalIdsMock).not.toHaveBeenCalled();
    expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
    const items = createLocalOperationsBatchMock.mock.calls[0][0];
    expect(items).toEqual([
      { objectType: "tab", objectId: "tab-7", operationType: "activate", payload: { active: true } },
    ]);
    expect(recordLocalFieldStateMock).toHaveBeenCalledTimes(1);
    // Activate-only batches never nudge an immediate sync cycle.
    expect(scheduleLocalSyncMock).not.toHaveBeenCalled();
  });

  it("is a no-op for an unknown tab and for an already-active tab", async () => {
    lookupObjectIdMock.mockResolvedValueOnce(undefined);
    await flushTabEvents([{ kind: "tabActivated", activeInfo: { tabId: 99, windowId: 1 } }]);
    await flushMicrotasks();
    expect(createLocalOperationsBatchMock).not.toHaveBeenCalled();

    getFieldStateMock.mockResolvedValue({ value: true });
    await flushTabEvents([{ kind: "tabActivated", activeInfo: { tabId: 7, windowId: 1 } }]);
    await flushMicrotasks();
    expect(createLocalOperationsBatchMock).not.toHaveBeenCalled();
    expect(getMappingsByLocalIdsMock).not.toHaveBeenCalled();
  });
});

describe("onActivated repeat dedup (perf fix P4)", () => {
  it("drops repeat activations of the same tab before the queue", async () => {
    expect(onActivatedListener).toBeDefined();
    onActivatedListener!({ tabId: 5, windowId: 1 });
    await vi.advanceTimersByTimeAsync(200);
    expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);

    // Window focus change re-fires onActivated for the same tab: no new flush.
    onActivatedListener!({ tabId: 5, windowId: 1 });
    await vi.advanceTimersByTimeAsync(200);
    expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);

    onActivatedListener!({ tabId: 6, windowId: 1 });
    await vi.advanceTimersByTimeAsync(200);
    expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(2);
  });
});
