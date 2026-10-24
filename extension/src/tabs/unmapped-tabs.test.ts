// Regression tests for tab capture in Chromium. A new tab reaches onCreated
// before it has a URL (`url` is "" and the destination only in `pendingUrl`),
// so its create was skipped, and every later update was dropped because the
// tab had no object: no tab was ever synced (found end to end). Tabs open
// before tab sync was turned on were never captured either.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingLocalOperation } from "../sync/engine";

const chromeTabsQueryMock = vi.fn<() => Promise<chrome.tabs.Tab[]>>(async () => []);
let createdTabId = 101;

(globalThis as unknown as { chrome: unknown }).chrome = {
  windows: {
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  tabs: {
    query: () => chromeTabsQueryMock(),
    create: vi.fn(async (props: chrome.tabs.CreateProperties) => ({ id: createdTabId, ...props })),
    update: vi.fn(),
    onCreated: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
    onActivated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  tabGroups: undefined,
};

// Tab ids that have an object, and the state recorded for each object.
const mapped = new Map<string, string>();
const recordedState = new Map<string, unknown>();

vi.mock("../storage/db", () => ({
  getFieldState: vi.fn(async (objectId: string) => {
    const value = recordedState.get(objectId);
    return value === undefined ? undefined : { value };
  }),
  getFieldStatesForObjects: vi.fn(async (objectIds: string[]) => {
    const out = new Map<string, { value: unknown }>();
    for (const id of objectIds) if (recordedState.has(id)) out.set(id, { value: recordedState.get(id) });
    return out;
  }),
  getMappingsByLocalIds: vi.fn(async (type: string, ids: string[]) => {
    const out = new Map<string, { objectId: string }>();
    if (type !== "tab") return out;
    for (const id of ids) if (mapped.has(id)) out.set(id, { objectId: mapped.get(id)! });
    return out;
  }),
  putRemoteObject: vi.fn(),
}));

let releaseMapping: (() => void) | undefined;
vi.mock("../sync/mapping", () => ({
  establishMapping: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releaseMapping = resolve;
      }),
  ),
  forgetMapping: vi.fn(),
  getOrCreateObjectId: vi.fn(async (type: string, localId: string) => `${type}-${localId}`),
  lookupChromiumLocalId: vi.fn(async () => undefined),
  lookupObjectId: vi.fn(async (type: string, localId: string) => (type === "tab" ? mapped.get(localId) : `${type}-${localId}`)),
}));

vi.mock("../sync/conflict", () => ({
  recordLocalFieldState: vi.fn(),
  recordLocalFieldStatesBatch: vi.fn(),
  resolveField: vi.fn(),
  resolveFields: vi.fn(),
}));

const createLocalOperationsBatchMock = vi.fn(async (items: PendingLocalOperation[]) =>
  items.map((_item, idx) => ({ operation: { operationId: `op-${idx}`, lamportTimestamp: idx + 1 }, deviceId: "device-1" })),
);
vi.mock("../sync/engine", () => ({
  createLocalOperationsBatch: (items: PendingLocalOperation[]) => createLocalOperationsBatchMock(items),
  registerApplier: vi.fn(),
  registerBatchApplier: vi.fn(),
  scheduleLocalSync: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(async () => ({ syncTabs: true, syncTabGroups: true, tabRestorePolicy: "ask" })),
  fetchTabRestorePolicy: vi.fn(async () => "ask"),
}));

const { flushTabEvents, registerCapture, resetCaptureStateForTesting, restoreTab } = await import("./index");

function tab(id: number, url: string): chrome.tabs.Tab {
  return { id, windowId: 1, url, title: url, pinned: false, index: 0, active: false } as chrome.tabs.Tab;
}

const stagedOps = () => createLocalOperationsBatchMock.mock.calls.flatMap((call) => call[0]);

describe("capturing tabs that have no object yet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCaptureStateForTesting();
    mapped.clear();
    recordedState.clear();
    chromeTabsQueryMock.mockResolvedValue([]);
  });

  it("creates the object when a tab without one gets its URL", async () => {
    await flushTabEvents([{ kind: "tabUpdated", tabId: 7, tab: tab(7, "https://site.test/") }]);

    expect(stagedOps()).toEqual([
      expect.objectContaining({ objectType: "tab", objectId: "tab-7", operationType: "create" }),
    ]);
  });

  it("captures the tabs already open when capture starts, skipping unchanged ones", async () => {
    const known = tab(1, "https://known.test/");
    mapped.set("1", "tab-1");
    recordedState.set("tab-1", { url: known.url, title: known.title, pinned: false, index: 0, windowObjectId: "window-1", active: false, groupObjectId: null });
    chromeTabsQueryMock.mockResolvedValue([known, tab(2, "https://new.test/")]);

    registerCapture();
    await vi.waitFor(() => expect(createLocalOperationsBatchMock).toHaveBeenCalled(), { timeout: 2_000 });

    expect(stagedOps()).toEqual([
      expect.objectContaining({ objectId: "tab-2", operationType: "create" }),
    ]);
  });

  it("does not take a tab it is opening for a remote tab for a new local one", async () => {
    const { getFieldState } = await import("../storage/db");
    vi.mocked(getFieldState).mockResolvedValueOnce({ value: { url: "https://remote.test/", pinned: false } } as never);
    createdTabId = 101;

    const restoring = restoreTab("remote-tab");
    await vi.waitFor(() => expect(releaseMapping).toBeDefined());
    // The new tab's URL commits while its mapping is still being stored.
    await flushTabEvents([{ kind: "tabUpdated", tabId: 101, tab: tab(101, "https://remote.test/") }]);
    releaseMapping!();
    await restoring;

    expect(createLocalOperationsBatchMock).not.toHaveBeenCalled();
  });
});

// A group's first operation was always an `update`, which the server refuses
// for an object it never saw created, so group titles and colors never synced.
describe("tab group operations", () => {
  const group = (title: string) =>
    ({ id: 5, title, color: "purple", collapsed: false, windowId: 1 }) as unknown as chrome.tabGroups.TabGroup;

  beforeEach(() => {
    vi.clearAllMocks();
    recordedState.clear();
  });

  it("creates a group with no recorded state", async () => {
    await flushTabEvents([{ kind: "groupUpdated", group: group("Work") }]);
    expect(stagedOps()).toEqual([expect.objectContaining({ objectType: "tabGroup", operationType: "create" })]);
  });

  it("updates a group whose state is already recorded", async () => {
    recordedState.set("tabGroup-5", { title: "Work", color: "purple", collapsed: false });
    await flushTabEvents([{ kind: "groupUpdated", group: group("Home") }]);
    expect(stagedOps()).toEqual([expect.objectContaining({ objectType: "tabGroup", operationType: "update" })]);
  });
});
