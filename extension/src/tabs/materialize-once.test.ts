// Regression test: a page of remote operations often carries a new tab's
// create and its first update. Under the "automatic" policy both were
// materialized at the same time; neither found a mapping yet, so the tab
// opened twice on the receiving device (found end to end).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationOut } from "../sync/types";

let nextTabId = 500;
const tabsCreate = vi.fn(async (props: chrome.tabs.CreateProperties) => {
  // Let the other materialization run while this one awaits the browser.
  await new Promise((r) => setTimeout(r, 5));
  return { id: nextTabId++, ...props };
});
(globalThis as unknown as { chrome: unknown }).chrome = {
  windows: { onCreated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
  tabs: {
    query: async () => [],
    create: tabsCreate,
    update: vi.fn(async () => ({})),
    onCreated: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
    onActivated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  tabGroups: undefined,
};

const mappings = new Map<string, string>(); // objectId -> local tab id
vi.mock("../sync/mapping", () => ({
  establishMapping: vi.fn(async (_type: string, localId: string, objectId: string) => {
    await new Promise((r) => setTimeout(r, 5));
    mappings.set(objectId, localId);
  }),
  forgetMapping: vi.fn(),
  getOrCreateObjectId: vi.fn(async (type: string, localId: string) => `${type}-${localId}`),
  lookupChromiumLocalId: vi.fn(async (objectId: string) => mappings.get(objectId)),
  lookupObjectId: vi.fn(async () => undefined),
}));

vi.mock("../storage/db", () => ({
  // A connected device: capture is skipped without one.
  getDevice: vi.fn(async () => ({ deviceId: "device-1" })),
  deleteMappingsBatch: vi.fn(),
  getFieldState: vi.fn(async () => undefined),
  getFieldStatesForObjects: vi.fn(async () => new Map()),
  getMappingsByLocalIds: vi.fn(async () => new Map()),
  getMappingsByObjectIds: vi.fn(async () => new Map()),
  putRemoteObject: vi.fn(),
  putRemoteObjectsBatch: vi.fn(),
}));

// Every incoming state wins, as it does for a create and its later update.
vi.mock("../sync/conflict", () => ({
  recordLocalFieldState: vi.fn(),
  recordLocalFieldStatesBatch: vi.fn(),
  resolveField: vi.fn(async (_id: string, _f: string, incoming: { value: unknown }) => ({ applied: true, value: incoming.value })),
  resolveFields: vi.fn(async (_id: string, fields: Array<{ incoming: { value: unknown } }>) =>
    fields.map((f) => ({ applied: true, value: f.incoming.value })),
  ),
  resolveFieldsBatch: vi.fn(async (entries: Array<{ incoming: { value: unknown } }>) =>
    entries.map((e) => ({ applied: true, value: e.incoming.value })),
  ),
}));

const batchAppliers = new Map<string, (items: Array<{ op: OperationOut; payload: unknown }>) => Promise<void>>();
vi.mock("../sync/engine", () => ({
  createLocalOperationsBatch: vi.fn(async () => []),
  registerApplier: vi.fn(),
  registerBatchApplier: (type: string, fn: never) => batchAppliers.set(type, fn),
  scheduleLocalSync: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(async () => ({ syncTabs: true, syncTabGroups: true, tabRestorePolicy: "automatic" })),
  fetchTabRestorePolicy: vi.fn(async () => "automatic"),
}));

const { flushTabEvents, restoreTab } = await import("./index");

function op(operationType: string, lamportTimestamp: number): OperationOut {
  return {
    operationId: `op-${lamportTimestamp}`,
    deviceId: "other-device",
    lamportTimestamp,
    objectType: "tab",
    objectId: "remote-tab",
    operationType,
  } as unknown as OperationOut;
}
const payload = (title: string) => ({ url: "https://remote.test/", title, pinned: false, index: 0, windowObjectId: "w", active: false, groupObjectId: null });

describe("materializing a remote tab under the automatic policy", () => {
  beforeEach(() => {
    tabsCreate.mockClear();
    mappings.clear();
  });

  it("opens it once when one page carries its create and its update", async () => {
    await batchAppliers.get("tab")!([
      { op: op("create", 1), payload: payload("Loading") },
      { op: op("update", 2), payload: payload("Remote page") },
    ]);

    expect(tabsCreate).toHaveBeenCalledTimes(1);
  });

  it("opens it once when two applies overlap", async () => {
    const { getFieldState } = await import("../storage/db");
    vi.mocked(getFieldState).mockResolvedValue({ value: payload("Remote page") } as never);

    await Promise.all([batchAppliers.get("tab")!([{ op: op("create", 1), payload: payload("Remote page") }]), restoreTab("remote-tab")]);

    expect(tabsCreate).toHaveBeenCalledTimes(1);
  });
});

describe("tab capture without a connected device", () => {
  it("records nothing (a new install, or after Disconnect)", async () => {
    const { getDevice } = await import("../storage/db");
    const { createLocalOperationsBatch } = await import("../sync/engine");
    vi.mocked(getDevice).mockResolvedValueOnce(undefined);

    await flushTabEvents([
      { kind: "tabUpdated", tabId: 9, tab: { id: 9, windowId: 1, url: "https://site.test/", index: 0, pinned: false, active: false } as chrome.tabs.Tab },
    ]);

    expect(createLocalOperationsBatch).not.toHaveBeenCalled();
  });
});
