import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSettings } from "../api/client";
import type { PendingLocalOperation } from "../sync/engine";
import type { QueuedTabEvent, StagedTabOp } from "./index";

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
  getMappingsByLocalIds: vi.fn(async () => new Map()),
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
  registerBatchApplier: vi.fn(),
  scheduleLocalSync: () => scheduleLocalSyncMock(),
}));

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(async () => ({ tabRestorePolicy: "disabled" })),
}));

const {
  TAB_TITLE_DEBOUNCE_MS,
  pendingTitleDebounce,
  pendingTitleTabs,
  clearAllTitleDebounce,
  coalesceStagedOps,
  flushPendingTitleDebounces,
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

      const tab1 = { id: 1, windowId: 10, url: "https://helixsync.test/page", title: "Loading...", active: true } as chrome.tabs.Tab;
      const tab2 = { id: 1, windowId: 10, url: "https://helixsync.test/page", title: "Site Name", active: true } as chrome.tabs.Tab;
      const tab3 = { id: 1, windowId: 10, url: "https://helixsync.test/page", title: "Article Title - Site Name", active: true } as chrome.tabs.Tab;

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
        titleOnly: true,
      });
      expect(pendingTitleDebounce.has(1)).toBe(false);
    });

    it("bypasses the title debounce when a URL change occurs, clearing any pending title timer", () => {
      vi.useFakeTimers();
      const mockEnqueue = vi.fn();

      const tabWithTitle = { id: 1, windowId: 10, url: "https://helixsync.test/old", title: "Old Title", active: true } as chrome.tabs.Tab;
      const tabWithNewUrl = { id: 1, windowId: 10, url: "https://helixsync.test/new", title: "New Title", active: true } as chrome.tabs.Tab;

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

      const tab = { id: 2, windowId: 10, url: "https://helixsync.test", title: "Tab 2", pinned: true, active: true } as chrome.tabs.Tab;

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

      const tabA = { id: 10, windowId: 1, url: "https://a.test", title: "A1", active: true } as chrome.tabs.Tab;
      const tabB = { id: 20, windowId: 1, url: "https://b.test", title: "B1", active: true } as chrome.tabs.Tab;

      handleTabUpdated(10, { title: "A1" }, tabA, mockEnqueue);
      vi.advanceTimersByTime(200);
      handleTabUpdated(20, { title: "B1" }, tabB, mockEnqueue);

      // At t=500ms, Tab A fires (500ms elapsed since Tab A armed)
      vi.advanceTimersByTime(300);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      expect(mockEnqueue).toHaveBeenCalledWith({ kind: "tabUpdated", tabId: 10, tab: tabA, titleOnly: true });
      expect(pendingTitleDebounce.has(10)).toBe(false);
      expect(pendingTitleDebounce.has(20)).toBe(true);

      // At t=700ms, Tab B fires (500ms elapsed since Tab B armed)
      vi.advanceTimersByTime(200);
      expect(mockEnqueue).toHaveBeenCalledTimes(2);
      expect(mockEnqueue).toHaveBeenCalledWith({ kind: "tabUpdated", tabId: 20, tab: tabB, titleOnly: true });
      expect(pendingTitleDebounce.has(20)).toBe(false);
    });

    it("stashes background-tab title tickers without arming timers (perf audit M2b)", () => {
      vi.useFakeTimers();
      const mockEnqueue = vi.fn();

      const bg = (title: string) =>
        ({ id: 30, windowId: 1, url: "https://ticker.test/", title, active: false }) as chrome.tabs.Tab;

      // 600ms ticker: no timer may ever be armed (each one would pin the
      // service worker for its whole window), so nothing emits mid-ticker —
      // only the latest snapshot is stashed.
      for (let t = 0; t < 3000; t += 600) {
        handleTabUpdated(30, { title: `count ${t}` }, bg(`count ${t}`), mockEnqueue);
        vi.advanceTimersByTime(600);
      }
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(pendingTitleDebounce.has(30)).toBe(false);
      expect(pendingTitleTabs.get(30)).toMatchObject({ title: "count 2400" });

      // Advancing past any old debounce window still emits nothing — there
      // is no timer to fire.
      vi.advanceTimersByTime(10_000);
      expect(mockEnqueue).not.toHaveBeenCalled();

      // The stash drains exactly once via the suspend flush, with the latest title.
      flushPendingTitleDebounces(mockEnqueue);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      expect(mockEnqueue).toHaveBeenCalledWith({
        kind: "tabUpdated",
        tabId: 30,
        tab: expect.objectContaining({ title: "count 2400" }),
        titleOnly: true,
      });
      expect(pendingTitleTabs.has(30)).toBe(false);
    });

    it("keeps the short debounce for the active tab", () => {
      vi.useFakeTimers();
      const mockEnqueue = vi.fn();

      const tab = { id: 31, windowId: 1, url: "https://helixsync.test/", title: "New", active: true } as chrome.tabs.Tab;
      handleTabUpdated(31, { title: "New" }, tab, mockEnqueue);
      vi.advanceTimersByTime(TAB_TITLE_DEBOUNCE_MS);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
    });

    it("downgrades a chronically ticking active tab, then drops its ticks", () => {
      vi.useFakeTimers();
      const mockEnqueue = vi.fn();
      const tab = (title: string) =>
        ({ id: 32, windowId: 1, url: "https://video.test/watch", title, active: true }) as chrome.tabs.Tab;

      // 200ms ticker, faster than the 500ms window: the first 10 ticks re-arm
      // (each clearing its predecessor, taking the pending stash entry with
      // it), and ticks past the downgrade are dropped rather than stashed —
      // the worker is no longer pinned by a perpetually re-armed timer, and
      // a chronic ticker can't mint a titleOnly op on the next unrelated
      // flush either. Nothing remains pending for this tab.
      for (let i = 0; i < 15; i++) {
        handleTabUpdated(32, { title: `t ${i}` }, tab(`t ${i}`), mockEnqueue);
        vi.advanceTimersByTime(200);
      }
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(pendingTitleDebounce.has(32)).toBe(false);
      expect(pendingTitleTabs.has(32)).toBe(false);

      // A further tick is still dropped (no stash, no timer).
      handleTabUpdated(32, { title: "t 15b" }, tab("t 15b"), mockEnqueue);
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(pendingTitleDebounce.has(32)).toBe(false);
      expect(pendingTitleTabs.has(32)).toBe(false);

      // Real (non-title) activity resets the ticker count, so the next title
      // debounces promptly again instead of staying downgraded.
      handleTabUpdated(32, { url: "https://video.test/next" }, tab("t 15"), mockEnqueue);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      handleTabUpdated(32, { title: "t 16" }, tab("t 16"), mockEnqueue);
      expect(pendingTitleDebounce.has(32)).toBe(true);
    });

    it("caps the background title stash instead of growing without bound", () => {
      vi.useFakeTimers();
      const mockEnqueue = vi.fn();
      for (let id = 1000; id < 1300; id++) {
        handleTabUpdated(
          id,
          { title: `t${id}` },
          { id, windowId: 1, url: "https://x.test/", title: `t${id}`, active: false } as chrome.tabs.Tab,
          mockEnqueue,
        );
      }
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(pendingTitleTabs.size).toBe(200);
      expect(pendingTitleDebounce.size).toBe(0);
    });

    it("clears pending title debounce timer when tab is removed", () => {
      vi.useFakeTimers();
      const mockEnqueue = vi.fn();

      const tab = { id: 5, windowId: 1, url: "https://closing.test", title: "About to close", active: true } as chrome.tabs.Tab;
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

    it("collapses a same-window switch storm to the last activation (perf)", () => {
      const staged: StagedTabOp[] = ["tab-A", "tab-B", "tab-C", "tab-B"].map((objectId) => ({
        objectType: "tab",
        objectId,
        operationType: "activate",
        payload: { active: true },
        fields: [{ field: "active", value: true }],
        windowId: 1,
      }));

      const result = coalesceStagedOps(staged);
      expect(result).toHaveLength(1);
      expect(result[0].objectId).toBe("tab-B");
      expect(result[0].operationType).toBe("activate");
    });

    it("keeps one activation per window across windows", () => {
      const staged: StagedTabOp[] = [
        { objectType: "tab", objectId: "w1-a", operationType: "activate", payload: { active: true }, fields: [], windowId: 1 },
        { objectType: "tab", objectId: "w2-a", operationType: "activate", payload: { active: true }, fields: [], windowId: 2 },
        { objectType: "tab", objectId: "w1-b", operationType: "activate", payload: { active: true }, fields: [], windowId: 1 },
        { objectType: "tab", objectId: "w2-b", operationType: "activate", payload: { active: true }, fields: [], windowId: 2 },
      ];

      const result = coalesceStagedOps(staged);
      expect(result.map((op) => op.objectId).sort()).toEqual(["w1-b", "w2-b"]);
    });

    it("still applies close-wins over a surviving per-window activation", () => {
      const staged: StagedTabOp[] = [
        { objectType: "tab", objectId: "tab-A", operationType: "activate", payload: { active: true }, fields: [], windowId: 1 },
        { objectType: "tab", objectId: "tab-B", operationType: "activate", payload: { active: true }, fields: [], windowId: 1 },
        { objectType: "tab", objectId: "tab-A", operationType: "close", payload: {}, fields: [] },
      ];

      const result = coalesceStagedOps(staged);
      expect(result.map((op) => `${op.objectId}:${op.operationType}`).sort()).toEqual([
        "tab-A:close",
        "tab-B:activate",
      ]);
    });

    it("keeps legacy per-tab behavior for activates without a windowId", () => {
      const staged: StagedTabOp[] = [
        { objectType: "tab", objectId: "tab-A", operationType: "activate", payload: { active: true }, fields: [] },
        { objectType: "tab", objectId: "tab-B", operationType: "activate", payload: { active: true }, fields: [] },
      ];

      expect(coalesceStagedOps(staged)).toHaveLength(2);
    });
  });

  describe("flushTabEvents end-to-end coalescing", () => {
    it("skips batch prefetch for a singleton tabUpdated event", async () => {
      const db = await import("../storage/db");
      const getMappingsByLocalIds = vi.mocked(db.getMappingsByLocalIds);
      getMappingsByLocalIds.mockClear();
      createLocalOperationsBatchMock.mockClear();

      const tab = { id: 300, windowId: 1, url: "https://helixsync.test/p3", title: "Solo" } as chrome.tabs.Tab;
      await flushTabEvents([{ kind: "tabUpdated", tabId: 300, tab }]);

      // Before the fast path this paid up to 3 mapping transactions + 2
      // overlay-seeding transactions for one event; now it falls back to
      // live reads with the same staged outcome.
      expect(getMappingsByLocalIds).not.toHaveBeenCalled();
      expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
      expect(stagedOpsReceived).toHaveLength(1);
      expect(stagedOpsReceived[0].operationType).toBe("update");
    });

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

    it("stages window create/remove through the shared batch path", async () => {
      createLocalOperationsBatchMock.mockClear();

      await flushTabEvents([
        { kind: "windowCreated", win: { id: 42, focused: true, incognito: false } as chrome.windows.Window },
        { kind: "windowRemoved", windowId: 43 },
      ]);

      // Window open/close used to bypass the batch (one singular encrypt +
      // singular field write each); both must flow through the batch now.
      expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
      expect(stagedOpsReceived).toHaveLength(2);
      expect(stagedOpsReceived[0]).toMatchObject({ objectType: "window", operationType: "create" });
      expect(stagedOpsReceived[1]).toMatchObject({ objectType: "window", operationType: "close" });
    });

    it("discards earlier tabUpdated when tabRemoved is in the same batch", async () => {      const tab = { id: 200, windowId: 1, url: "https://helixsync.test/p2", title: "Before Close" } as chrome.tabs.Tab;

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

  describe("title-only batches skip the immediate sync nudge", () => {
    it("queues the op but does not nudge a sync for a title-only update", async () => {
      const tab = { id: 400, windowId: 1, url: "https://helixsync.test/t", title: "Ticker (1)" } as chrome.tabs.Tab;
      await flushTabEvents([{ kind: "tabUpdated", tabId: 400, tab, titleOnly: true }]);

      // The op is still durably queued (goes out on the next alarm/push),
      // only the immediate extra sync cycle is skipped.
      expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
      expect(stagedOpsReceived).toHaveLength(1);
      expect(stagedOpsReceived[0].operationType).toBe("update");
      expect(scheduleLocalSyncMock).not.toHaveBeenCalled();
    });

    it("still nudges for a real (non-title-only) update", async () => {
      const tab = { id: 401, windowId: 1, url: "https://helixsync.test/t", title: "T" } as chrome.tabs.Tab;
      await flushTabEvents([{ kind: "tabUpdated", tabId: 401, tab }]);

      expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
      expect(scheduleLocalSyncMock).toHaveBeenCalledTimes(1);
    });

    it("still nudges for a mixed batch containing a real update", async () => {
      const ticker = { id: 402, windowId: 1, url: "https://helixsync.test/a", title: "Ticker (2)" } as chrome.tabs.Tab;
      const nav = { id: 403, windowId: 1, url: "https://helixsync.test/b", title: "Real Nav" } as chrome.tabs.Tab;
      await flushTabEvents([
        { kind: "tabUpdated", tabId: 402, tab: ticker, titleOnly: true },
        { kind: "tabUpdated", tabId: 403, tab: nav },
      ]);

      expect(scheduleLocalSyncMock).toHaveBeenCalledTimes(1);
    });

    it("marks debounced pure-title events titleOnly end to end", () => {
      vi.useFakeTimers();
      const enqueued: QueuedTabEvent[] = [];
      const tab = { id: 404, windowId: 1, url: "https://helixsync.test/t", title: "T", active: true } as chrome.tabs.Tab;

      handleTabUpdated(404, { title: "T" }, tab, (e) => enqueued.push(e));
      vi.advanceTimersByTime(TAB_TITLE_DEBOUNCE_MS);

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ kind: "tabUpdated", tabId: 404, titleOnly: true });
    });

    it("onSuspend re-enqueue preserves titleOnly without double-enqueue", () => {      vi.useFakeTimers();
      const enqueued: QueuedTabEvent[] = [];
      const tab = { id: 405, windowId: 1, url: "https://helixsync.test/t", title: "T", active: true } as chrome.tabs.Tab;

      handleTabUpdated(405, { title: "T" }, tab, (e) => enqueued.push(e));
      expect(pendingTitleDebounce.has(405)).toBe(true);
      flushPendingTitleDebounces((e) => enqueued.push(e));

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ kind: "tabUpdated", tabId: 405, titleOnly: true });
      vi.advanceTimersByTime(TAB_TITLE_DEBOUNCE_MS + 100);
      expect(enqueued).toHaveLength(1);
    });

    it("onSuspend flush also drains background-stashed titles (no timer involved)", () => {
      const enqueued: QueuedTabEvent[] = [];
      const tab = { id: 406, windowId: 1, url: "https://helixsync.test/b", title: "B", active: false } as chrome.tabs.Tab;

      handleTabUpdated(406, { title: "B" }, tab, (e) => enqueued.push(e));
      expect(enqueued).toHaveLength(0);
      expect(pendingTitleDebounce.has(406)).toBe(false);
      expect(pendingTitleTabs.has(406)).toBe(true);

      flushPendingTitleDebounces((e) => enqueued.push(e));
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ kind: "tabUpdated", tabId: 406, titleOnly: true });
      expect(pendingTitleTabs.has(406)).toBe(false);
    });

    it("flushTabEvents drains background-stashed titles ahead of the current batch", async () => {
      const bg = { id: 50, windowId: 1, url: "https://bg.test/", title: "BG", pinned: false, index: 0, active: false } as chrome.tabs.Tab;
      handleTabUpdated(50, { title: "BG" }, bg, () => {});
      expect(pendingTitleTabs.has(50)).toBe(true);

      const created = { id: 51, windowId: 1, url: "https://new.test/", title: "New", pinned: false, index: 1, active: true } as chrome.tabs.Tab;
      await flushTabEvents([{ kind: "tabCreated", tab: created }]);

      // Stash (older) stages first, then the current batch — both survive
      // coalescing since they touch different objects.
      expect(stagedOpsReceived.map((o) => o.objectId)).toEqual(["tab-50", "tab-51"]);
      expect(pendingTitleTabs.has(50)).toBe(false);
    });
  });

  describe("Integration with registerCapture", () => {
    it("registers listeners and handles title debouncing via onUpdated listener", () => {
      vi.useFakeTimers();
      registerCapture();

      expect(onUpdatedListener).toBeDefined();
      expect(onRemovedListener).toBeDefined();

      const tab1 = { id: 77, windowId: 1, url: "https://helixsync.test", title: "T1", active: true } as chrome.tabs.Tab;
      const tab2 = { id: 77, windowId: 1, url: "https://helixsync.test", title: "T2", active: true } as chrome.tabs.Tab;

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

  describe("capture toggles (perf audit: disabled-type gates)", () => {
    it("drops the whole batch and discards title state while Tabs sync is disabled", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        tabRestorePolicy: "disabled",
        syncTabs: false,
      } as never);
      const tab = { id: 500, windowId: 1, url: "https://x.test/", title: "X", pinned: false, index: 0, active: true } as chrome.tabs.Tab;
      await flushTabEvents([{ kind: "tabCreated", tab }]);
      expect(createLocalOperationsBatchMock).not.toHaveBeenCalled();
      expect(recordLocalFieldStatesBatchMock).not.toHaveBeenCalled();
      expect(scheduleLocalSyncMock).not.toHaveBeenCalled();
    });

    it("filters group events while Tab groups sync is disabled but keeps tab events", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        tabRestorePolicy: "disabled",
        syncTabs: true,
        syncTabGroups: false,
      } as never);
      await flushTabEvents([
        { kind: "groupRemoved", group: { id: 5 } as unknown as chrome.tabGroups.TabGroup },
        { kind: "tabRemoved", tabId: 9 },
      ]);
      expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
      const items = createLocalOperationsBatchMock.mock.calls[0][0];
      expect(items.map((o) => o.objectType)).toEqual(["tab"]);
    });

    it("listener-level flags drop events before the queue", async () => {
      const { setTabsCaptureEnabled } = await import("./index");
      setTabsCaptureEnabled(false);
      try {
        const enq = vi.fn();
        const tab = { id: 501, windowId: 1, url: "https://x.test/", title: "T", pinned: false, index: 0, active: true } as chrome.tabs.Tab;
        handleTabUpdated(501, { title: "T" }, tab, enq);
        expect(enq).not.toHaveBeenCalled();
        expect(pendingTitleDebounce.has(501)).toBe(false);
        expect(pendingTitleTabs.has(501)).toBe(false);
      } finally {
        setTabsCaptureEnabled(true);
      }
    });
  });
});
