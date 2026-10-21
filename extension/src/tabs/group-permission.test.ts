// Regression test: `tabGroups` is an optional permission, so chrome.tabGroups
// only exists once the popup has asked for it. Availability used to be read
// once at load and the group listeners added only then, so a grant made while
// the worker ran never turned tab group capture on.
import { beforeEach, describe, expect, it, vi } from "vitest";

const tabsOnCreatedAddListener = vi.fn();
const chromeMock = {
  windows: {
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  tabs: {
    query: vi.fn(async () => []),
    onCreated: { addListener: tabsOnCreatedAddListener },
    onUpdated: { addListener: vi.fn() },
    onActivated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  tabGroups: undefined as unknown,
};
(globalThis as unknown as { chrome: unknown }).chrome = chromeMock;

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
  createLocalOperationsBatch: vi.fn(async () => []),
  registerApplier: vi.fn(),
  registerBatchApplier: vi.fn(),
  scheduleLocalSync: vi.fn(),
}));

const { registerCapture, resetCaptureStateForTesting } = await import("./index");

function grantTabGroups() {
  const tabGroups = {
    TAB_GROUP_ID_NONE: -1,
    onUpdated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  };
  chromeMock.tabGroups = tabGroups;
  return tabGroups;
}

describe("tab group capture follows the optional tabGroups permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCaptureStateForTesting();
    chromeMock.tabGroups = undefined;
  });

  it("adds the group listeners on a later registerCapture once the permission is granted", () => {
    registerCapture();
    expect(tabsOnCreatedAddListener).toHaveBeenCalledTimes(1);

    const tabGroups = grantTabGroups();
    registerCapture();

    expect(tabGroups.onUpdated.addListener).toHaveBeenCalledTimes(1);
    expect(tabGroups.onRemoved.addListener).toHaveBeenCalledTimes(1);
    // The tab listeners are not added a second time.
    expect(tabsOnCreatedAddListener).toHaveBeenCalledTimes(1);
  });

  it("adds the group listeners only once across repeated registerCapture calls", () => {
    const tabGroups = grantTabGroups();
    registerCapture();
    registerCapture();
    registerCapture();

    expect(tabGroups.onUpdated.addListener).toHaveBeenCalledTimes(1);
    expect(tabGroups.onRemoved.addListener).toHaveBeenCalledTimes(1);
  });
});
