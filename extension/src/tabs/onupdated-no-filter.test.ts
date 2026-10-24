// Regression test: chrome.tabs.onUpdated used to be registered with a
// `properties` filter. Only Firefox supports one; Chromium throws "This event
// does not support filters", which aborted tab capture registration, so no tab
// was ever synced (found end to end). The JS property check in
// handleTabUpdated is what drops status/favIcon/audible noise.
import { beforeEach, describe, expect, it, vi } from "vitest";

const onUpdatedAddListener = vi.fn();
let onUpdatedCallback: ((tabId: number, changeInfo: never, tab: never) => void) | undefined;

(globalThis as unknown as { chrome: unknown }).chrome = {
  windows: {
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  tabs: {
    query: vi.fn(async () => []),
    onCreated: { addListener: vi.fn() },
    onUpdated: {
      addListener: (cb: (tabId: number, changeInfo: never, tab: never) => void, filter?: unknown) =>
        onUpdatedAddListener(cb, filter),
    },
    onActivated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  tabGroups: undefined,
};

vi.mock("../storage/db", () => ({
  getFieldState: vi.fn(async () => undefined),
  getFieldStatesForObjects: vi.fn(async () => new Map()),
  getMappingsByLocalIds: vi.fn(async () => new Map()),
  putRemoteObject: vi.fn(),
}));

vi.mock("../sync/mapping", () => ({
  establishMapping: vi.fn(),
  forgetMapping: vi.fn(),
  getOrCreateObjectId: vi.fn(),
  lookupChromiumLocalId: vi.fn(),
  lookupObjectId: vi.fn(async () => undefined),
}));

vi.mock("../sync/conflict", () => ({
  recordLocalFieldState: vi.fn(),
  recordLocalFieldStatesBatch: vi.fn(),
  resolveField: vi.fn(),
  resolveFields: vi.fn(),
}));

vi.mock("../sync/engine", () => ({
  createLocalOperation: vi.fn(),
  createLocalOperationsBatch: vi.fn(async () => []),
  registerApplier: vi.fn(),
  registerBatchApplier: vi.fn(),
  scheduleLocalSync: vi.fn(),
}));

const { handleTabUpdated, registerCapture, resetCaptureStateForTesting } = await import("./index");

describe("onUpdated native property filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCaptureStateForTesting();
  });

  it("registers onUpdated without a filter argument, which Chromium rejects", () => {
    registerCapture();
    expect(onUpdatedAddListener).toHaveBeenCalledTimes(1);
    expect(onUpdatedAddListener.mock.calls[0][1]).toBeUndefined();
    onUpdatedCallback = onUpdatedAddListener.mock.calls[0][0];
    expect(typeof onUpdatedCallback).toBe("function");
  });

  it("drops status, favicon and audible updates in JS", () => {
    const enqueue = vi.fn();
    const tab = { id: 3, windowId: 1, url: "https://x.test/", title: "X", pinned: false, index: 0, active: true };
    handleTabUpdated(3, { status: "complete" } as never, tab as never, enqueue as never);
    handleTabUpdated(3, { audible: true } as never, tab as never, enqueue as never);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
