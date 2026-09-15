import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingLocalOperation } from "../sync/engine";
import type { StagedTabOp } from "./index";

let onUpdatedListener: ((tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void) | undefined;
let onRemovedListener: ((tabId: number) => void) | undefined;

(globalThis as unknown as { chrome: unknown }).chrome = {
  windows: {
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  tabs: {
    onCreated: { addListener: vi.fn() },
    onUpdated: {
      addListener: vi.fn((cb) => {
        onUpdatedListener = cb;
      }),
    },
    onActivated: { addListener: vi.fn() },
    onRemoved: {
      addListener: vi.fn((cb) => {
        onRemovedListener = cb;
      }),
    },
    update: vi.fn(),
    create: vi.fn(),
  },
  tabGroups: undefined,
};

const getFieldStateMock = vi.fn<(objectId: string, field: string) => Promise<{ value: unknown } | undefined>>();
const putRemoteObjectMock = vi.fn();

vi.mock("../storage/db", () => ({
  getFieldState: (objectId: string, field: string) => getFieldStateMock(objectId, field),
  putRemoteObject: (...args: unknown[]) => putRemoteObjectMock(...args),
}));

const getOrCreateObjectIdMock = vi.fn(async (type: string, localId: string) => `${type}-${localId}`);
const lookupObjectIdMock = vi.fn(async (type: string, localId: string) => `${type}-${localId}`);
const lookupChromiumLocalIdMock = vi.fn();
const establishMappingMock = vi.fn();
const forgetMappingMock = vi.fn();

vi.mock("../sync/mapping", () => ({
  establishMapping: (...args: unknown[]) => establishMappingMock(...args),
  forgetMapping: (...args: unknown[]) => forgetMappingMock(...args),
  getOrCreateObjectId: (type: string, id: string) => getOrCreateObjectIdMock(type, id),
  lookupChromiumLocalId: (id: string) => lookupChromiumLocalIdMock(id),
  lookupObjectId: (type: string, id: string) => lookupObjectIdMock(type, id),
}));

const recordLocalFieldStatesBatchMock = vi.fn();
const recordLocalFieldStateMock = vi.fn();

vi.mock("../sync/conflict", () => ({
  recordLocalFieldState: (...args: unknown[]) => recordLocalFieldStateMock(...args),
  recordLocalFieldStatesBatch: (...args: unknown[]) => recordLocalFieldStatesBatchMock(...args),
  resolveField: vi.fn(),
  resolveFields: vi.fn(),
}));

let stagedOpsReceived: PendingLocalOperation[] = [];
const createLocalOperationsBatchMock = vi.fn(async (items: PendingLocalOperation[]) => {
  stagedOpsReceived = items;
  return items.map((_item, idx) => ({
    operation: {
      operationId: `op-${idx}`,
      lamportTimestamp: idx + 1,
    },
    deviceId: "device-1",
  }));
});
const scheduleLocalSyncMock = vi.fn();

vi.mock("../sync/engine", () => ({
  createLocalOperation: vi.fn(),
  createLocalOperationsBatch: (items: PendingLocalOperation[]) => createLocalOperationsBatchMock(items),
  registerApplier: vi.fn(),
  scheduleLocalSync: () => scheduleLocalSyncMock(),
}));

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(async () => ({ tabRestorePolicy: "disabled" })),
}));

const {
  TAB_TITLE_DEBOUNCE_MS,
  pendingTitleDebounce,
  clearAllTitleDebounce,
  coalesceStagedOps,
  handleTabUpdated,
  handleTabRemoved,
  flushTabEvents,
  registerCapture,
  resetCaptureStateForTesting,
} = await import("./index");

describe("EXT-05: Redundant Tab Update Op Churn During Progressive Navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    clearAllTitleDebounce();
    resetCaptureStateForTesting();
    stagedOpsReceived = [];
    getFieldStateMock.mockResolvedValue(undefined);
  });

  describe("Per-tab trailing debounce for pure title changes", () => {
    it("buffers successive title updates within the debounce window and produces only one enqueued event with the latest title", () => {
      vi.useFakeTimers();
      const mockEnqueue = vi.fn();

      const tab1 = { id: 1, windowId: 10, url: "https://helixsync.test/page", title: "Loading...", active: false } as chrome.tabs.Tab;
      const tab2 = { id: 1, windowId: 10, url: "https://helixsync.test/page", title: "Site Name", active: false } as chrome.tabs.Tab;
      const tab3 = { id: 1, windowId: 10, url: "https://helixsync.test/page", title: "Article Title - Site Name", active: false } as chrome.tabs.Tab;

      // Event 1: Initial load title
      handleTabUpdated(1, { title: "Loading..." }, tab1, mockEnqueue);
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(pendingTitleDebounce.has(1)).toBe(true);

      // Event 2: Site name settles after 200ms
      vi.advanceTimersByTime(200);
      handleTabUpdated(1, { title: "Site Name" }, tab2, mockEnqueue);
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(pendingTitleDebounce.has(1)).toBe(true);

      // Event 3: Article title settles after another 200ms (t=400ms)
      vi.advanceTimersByTime(200);
      handleTabUpdated(1, { title: "Article Title - Site Name" }, tab3, mockEnqueue);
      expect(mockEnqueue).not.toHaveBeenCalled();

      // At t=400 + 490ms = 890ms: debounce timer not yet expired
      vi.advanceTimersByTime(490);
      expect(mockEnqueue).not.toHaveBeenCalled();

      // Advance remaining 10ms (t=500ms after the last title update)
      vi.advanceTimersByTime(10);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      expect(mockEnqueue).toHaveBeenCalledWith({
        kind: "tabUpdated",
        tabId: 1,
        tab: tab3,
      });
      expect(pendingTitleDebounce.has(1)).toBe(false);
    });

    it("bypasses the title debounce when a URL change occurs, clearing any pending title timer", () => {
      vi.useFakeTimers();
      const mockEnqueue = vi.fn();

      const tabWithTitle = { id: 1, windowId: 10, url: "https://helixsync.test/old", title: "Old Title", active: false } as chrome.tabs.Tab;
      const tabWithNewUrl = { id: 1, windowId: 10, url: "https://helixsync.test/new", title: "New Title", active: false } as chrome.tabs.Tab;

      // Pure title change arms debounce
      handleTabUpdated(1, { title: "Old Title" }, tabWithTitle, mockEnqueue);
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(pendingTitleDebounce.has(1)).toBe(true);

      // 100ms later, URL changes: should bypass debounce and enqueue immediately
      vi.advanceTimersByTime(100);
      handleTabUpdated(1, { url: "https://helixsync.test/new" }, tabWithNewUrl, mockEnqueue);

      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      expect(mockEnqueue).toHaveBeenCalledWith({
        kind: "tabUpdated",
        tabId: 1,
        tab: tabWithNewUrl,
      });
      expect(pendingTitleDebounce.has(1)).toBe(false);

      // Advancing past original debounce window: should not emit another event
      vi.advanceTimersByTime(TAB_TITLE_DEBOUNCE_MS + 100);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
    });

    it("bypasses debounce for pinned and groupId changes, clearing any pending title timer", () => {
      vi.useFakeTimers();
      const mockEnqueue = vi.fn();

      const tab = { id: 2, windowId: 10, url: "https://helixsync.test", title: "Tab 2", pinned: true } as chrome.tabs.Tab;

      handleTabUpdated(2, { title: "Tab 2" }, tab, mockEnqueue);
      expect(pendingTitleDebounce.has(2)).toBe(true);

      // Pinned update bypasses
      handleTabUpdated(2, { pinned: true }, tab, mockEnqueue);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      expect(pendingTitleDebounce.has(2)).toBe(false);

      vi.advanceTimersByTime(TAB_TITLE_DEBOUNCE_MS);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
    });

    it("maintains independent debounce timers for distinct tabs", () => {
      vi.useFakeTimers();
      const mockEnqueue = vi.fn();

      const tabA = { id: 10, windowId: 1, url: "https://a.test", title: "A1" } as chrome.tabs.Tab;
      const tabB = { id: 20, windowId: 1, url: "https://b.test", title: "B1" } as chrome.tabs.Tab;

      handleTabUpdated(10, { title: "A1" }, tabA, mockEnqueue);
      vi.advanceTimersByTime(200);
      handleTabUpdated(20, { title: "B1" }, tabB, mockEnqueue);

      // At t=500ms, Tab A fires (500ms elapsed since Tab A armed)
      vi.advanceTimersByTime(300);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      expect(mockEnqueue).toHaveBeenCalledWith({ kind: "tabUpdated", tabId: 10, tab: tabA });
      expect(pendingTitleDebounce.has(10)).toBe(false);
      expect(pendingTitleDebounce.has(20)).toBe(true);

      // At t=700ms, Tab B fires (500ms elapsed since Tab B armed)
      vi.advanceTimersByTime(200);
      expect(mockEnqueue).toHaveBeenCalledTimes(2);
      expect(mockEnqueue).toHaveBeenCalledWith({ kind: "tabUpdated", tabId: 20, tab: tabB });
      expect(pendingTitleDebounce.has(20)).toBe(false);
    });

    it("clears pending title debounce timer when tab is removed", () => {
      vi.useFakeTimers();
      const mockEnqueue = vi.fn();

      const tab = { id: 5, windowId: 1, url: "https://closing.test", title: "About to close" } as chrome.tabs.Tab;
      handleTabUpdated(5, { title: "About to close" }, tab, mockEnqueue);
      expect(pendingTitleDebounce.has(5)).toBe(true);

      handleTabRemoved(5, mockEnqueue);
      expect(mockEnqueue).toHaveBeenCalledWith({ kind: "tabRemoved", tabId: 5 });
      expect(pendingTitleDebounce.has(5)).toBe(false);

      vi.advanceTimersByTime(TAB_TITLE_DEBOUNCE_MS + 100);
      // No title update was fired
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
    });

    it("ignores changeInfo without url, title, pinned, or groupId", () => {
      vi.useFakeTimers();
      const mockEnqueue = vi.fn();

      const tab = { id: 1, windowId: 1, url: "https://helixsync.test" } as chrome.tabs.Tab;
      handleTabUpdated(1, { status: "loading" }, tab, mockEnqueue);
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(pendingTitleDebounce.has(1)).toBe(false);
    });
  });

  describe("Batch coalescing (coalesceStagedOps)", () => {
    it("collapses multiple updates for the same tab into the latest update operation", () => {
      const staged: StagedTabOp[] = [
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "update",
          payload: { title: "Title 1" },
          fields: [{ field: "state", value: { title: "Title 1" } }],
        },
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "update",
          payload: { title: "Title 2" },
          fields: [{ field: "state", value: { title: "Title 2" } }],
        },
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "update",
          payload: { title: "Title 3" },
          fields: [{ field: "state", value: { title: "Title 3" } }],
        },
      ];

      const result = coalesceStagedOps(staged);
      expect(result).toHaveLength(1);
      expect(result[0].payload).toEqual({ title: "Title 3" });
    });

    it("discards earlier updates for an objectId when a close operation is staged in the same batch", () => {
      const staged: StagedTabOp[] = [
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "update",
          payload: { title: "Title 1" },
          fields: [{ field: "state", value: { title: "Title 1" } }],
        },
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "update",
          payload: { title: "Title 2" },
          fields: [{ field: "state", value: { title: "Title 2" } }],
        },
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "close",
          payload: {},
          fields: [{ field: "liveness", value: "deleted" }],
        },
      ];

      const result = coalesceStagedOps(staged);
      expect(result).toHaveLength(1);
      expect(result[0].operationType).toBe("close");
      expect(result[0].objectId).toBe("tab-1");
    });

    it("correctly coalesces interleaved operations for distinct tabs", () => {
      const staged: StagedTabOp[] = [
        {
          objectType: "tab",
          objectId: "tab-A",
          operationType: "update",
          payload: { title: "A1" },
          fields: [],
        },
        {
          objectType: "tab",
          objectId: "tab-B",
          operationType: "update",
          payload: { title: "B1" },
          fields: [],
        },
        {
          objectType: "tab",
          objectId: "tab-A",
          operationType: "update",
          payload: { title: "A2" },
          fields: [],
        },
        {
          objectType: "tab",
          objectId: "tab-B",
          operationType: "close",
          payload: {},
          fields: [],
        },
      ];

      const result = coalesceStagedOps(staged);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        objectType: "tab",
        objectId: "tab-A",
        operationType: "update",
        payload: { title: "A2" },
        fields: [],
      });
      expect(result[1]).toEqual({
        objectType: "tab",
        objectId: "tab-B",
        operationType: "close",
        payload: {},
        fields: [],
      });
    });

    it("collapses multiple activate operations for the same tab into the latest activate operation (EXT-03)", () => {
      const staged: StagedTabOp[] = [
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "activate",
          payload: { active: true },
          fields: [{ field: "active", value: true }],
        },
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "activate",
          payload: { active: true },
          fields: [{ field: "active", value: true }],
        },
      ];

      const result = coalesceStagedOps(staged);
      expect(result).toHaveLength(1);
      expect(result[0].operationType).toBe("activate");
      expect(result[0].objectId).toBe("tab-1");
    });

    it("discards earlier activate operations for an objectId when a close operation is staged in the same batch (EXT-03)", () => {
      const staged: StagedTabOp[] = [
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "activate",
          payload: { active: true },
          fields: [{ field: "active", value: true }],
        },
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "update",
          payload: { title: "Tab 1" },
          fields: [{ field: "state", value: { title: "Tab 1" } }],
        },
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "close",
          payload: {},
          fields: [{ field: "liveness", value: "deleted" }],
        },
      ];

      const result = coalesceStagedOps(staged);
      expect(result).toHaveLength(1);
      expect(result[0].operationType).toBe("close");
      expect(result[0].objectId).toBe("tab-1");
    });

    it("preserves non-update operations such as create and activate", () => {
      const staged: StagedTabOp[] = [
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "create",
          payload: { url: "https://helixsync.test" },
          fields: [],
        },
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "update",
          payload: { title: "Old Title" },
          fields: [],
        },
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "activate",
          payload: { active: true },
          fields: [],
        },
        {
          objectType: "tab",
          objectId: "tab-1",
          operationType: "update",
          payload: { title: "New Title" },
          fields: [],
        },
      ];

      const result = coalesceStagedOps(staged);
      expect(result).toHaveLength(3);
      expect(result.map((op) => op.operationType)).toEqual(["create", "activate", "update"]);
      expect((result[2].payload as { title: string }).title).toBe("New Title");
    });

    it("returns an empty array when given an empty array", () => {
      expect(coalesceStagedOps([])).toEqual([]);
    });
  });

  describe("flushTabEvents end-to-end coalescing", () => {
    it("collapses multiple tabUpdated events for the same tab into a single staged operation", async () => {
      const tab1 = { id: 100, windowId: 1, url: "https://helixsync.test/p1", title: "Version 1" } as chrome.tabs.Tab;
      const tab2 = { id: 100, windowId: 1, url: "https://helixsync.test/p1", title: "Version 2" } as chrome.tabs.Tab;

      await flushTabEvents([
        { kind: "tabUpdated", tabId: 100, tab: tab1 },
        { kind: "tabUpdated", tabId: 100, tab: tab2 },
      ]);

      expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
      expect(stagedOpsReceived).toHaveLength(1);
      expect(stagedOpsReceived[0].operationType).toBe("update");
      expect((stagedOpsReceived[0].payload as { title: string }).title).toBe("Version 2");
    });

    it("discards earlier tabUpdated when tabRemoved is in the same batch", async () => {
      const tab = { id: 200, windowId: 1, url: "https://helixsync.test/p2", title: "Before Close" } as chrome.tabs.Tab;

      await flushTabEvents([
        { kind: "tabUpdated", tabId: 200, tab },
        { kind: "tabRemoved", tabId: 200 },
      ]);

      expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
      expect(stagedOpsReceived).toHaveLength(1);
      expect(stagedOpsReceived[0].operationType).toBe("close");
      expect(stagedOpsReceived[0].objectId).toBe("tab-200");
    });
  });

  describe("Integration with registerCapture", () => {
    it("registers listeners and handles title debouncing via onUpdated listener", () => {
      vi.useFakeTimers();
      registerCapture();

      expect(onUpdatedListener).toBeDefined();
      expect(onRemovedListener).toBeDefined();

      const tab1 = { id: 77, windowId: 1, url: "https://helixsync.test", title: "T1" } as chrome.tabs.Tab;
      const tab2 = { id: 77, windowId: 1, url: "https://helixsync.test", title: "T2" } as chrome.tabs.Tab;

      onUpdatedListener!(77, { title: "T1" }, tab1);
      expect(pendingTitleDebounce.has(77)).toBe(true);

      vi.advanceTimersByTime(200);
      onUpdatedListener!(77, { title: "T2" }, tab2);
      expect(pendingTitleDebounce.has(77)).toBe(true);

      // Advance past debounce
      vi.advanceTimersByTime(500);
      expect(pendingTitleDebounce.has(77)).toBe(false);

      // On removed clears debounce
      onUpdatedListener!(77, { title: "T3" }, tab2);
      expect(pendingTitleDebounce.has(77)).toBe(true);
      onRemovedListener!(77);
      expect(pendingTitleDebounce.has(77)).toBe(false);
    });
  });
});
