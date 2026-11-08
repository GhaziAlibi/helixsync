import { beforeEach, describe, expect, it, vi } from "vitest";

const lookupChromiumLocalIdMock = vi.fn<(objectId: string) => Promise<string | undefined>>();
const establishMappingMock = vi.fn();
const getFieldStateMock = vi.fn<(objectId: string, field: string) => Promise<{ value: unknown } | undefined>>();
const chromeTabsUpdateMock = vi.fn(async (tabId: number, props: chrome.tabs.UpdateProperties) => {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new TypeError(`Invalid type: expected integer, found ${typeof tabId}`);
  }
  return { id: tabId, ...props } as chrome.tabs.Tab;
});
const chromeTabsCreateMock = vi.fn(async (props: chrome.tabs.CreateProperties) => {
  return { id: 101, ...props } as chrome.tabs.Tab;
});

const chromeTabsGetMock = vi.fn(async (tabId: number) => ({ id: tabId }) as chrome.tabs.Tab);
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    update: chromeTabsUpdateMock,
    create: chromeTabsCreateMock,
    get: chromeTabsGetMock,
  },
  tabGroups: undefined,
};

vi.mock("../sync/mapping", () => ({
  establishMapping: (...args: unknown[]) => establishMappingMock(...args),
  forgetMapping: vi.fn(),
  getOrCreateObjectId: vi.fn(),
  lookupChromiumLocalId: (objectId: string) => lookupChromiumLocalIdMock(objectId),
  lookupObjectId: vi.fn(),
}));

vi.mock("../storage/db", () => ({
  // A connected device: capture is skipped without one.
  getDevice: vi.fn(async () => ({ deviceId: "device-1" })),
  getFieldState: (objectId: string, field: string) => getFieldStateMock(objectId, field),
  getMappingsByLocalIds: vi.fn(async () => new Map()),
  putRemoteObject: vi.fn(),
}));

const { restoreTab } = await import("./index");
const { forgetMapping } = await import("../sync/mapping");

describe("materializeTab via restoreTab (EXT-02)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A remote update for a tab closed here meanwhile threw "No tab with id"
  // and failed the whole sync cycle (found end to end).
  it("leaves a tab closed here meanwhile closed, dropping its link, without failing", async () => {
    getFieldStateMock.mockResolvedValueOnce({ value: { url: "https://helixsync.test", pinned: false } });
    lookupChromiumLocalIdMock.mockResolvedValueOnce("43");
    chromeTabsUpdateMock.mockRejectedValueOnce(new Error("No tab with id: 43."));
    chromeTabsGetMock.mockRejectedValueOnce(new Error("No tab with id: 43."));

    await expect(restoreTab("remote-tab-43")).resolves.toBeUndefined();

    expect(forgetMapping).toHaveBeenCalledWith("tab", "43");
    expect(chromeTabsCreateMock).not.toHaveBeenCalled();
  });

  it("still reports an update failure for a tab that is open", async () => {
    getFieldStateMock.mockResolvedValueOnce({ value: { url: "https://helixsync.test", pinned: false } });
    lookupChromiumLocalIdMock.mockResolvedValueOnce("44");
    chromeTabsUpdateMock.mockRejectedValueOnce(new Error("Tabs cannot be edited right now"));

    await expect(restoreTab("remote-tab-44")).rejects.toThrow("Tabs cannot be edited right now");
  });

  it("converts existingChromiumId string to a number when updating an existing tab", async () => {
    getFieldStateMock.mockResolvedValueOnce({
      value: { url: "https://helixsync.test", pinned: true },
    });
    // Mapping returns a string ID, which is the storage format
    lookupChromiumLocalIdMock.mockResolvedValueOnce("42");

    await restoreTab("remote-tab-42");

    expect(chromeTabsUpdateMock).toHaveBeenCalledTimes(1);
    // Verify that tabId was passed as a number, not as a string
    const [tabIdArg, updateProps] = chromeTabsUpdateMock.mock.calls[0];
    expect(typeof tabIdArg).toBe("number");
    expect(tabIdArg).toBe(42);
    expect(updateProps).toEqual({ url: "https://helixsync.test", pinned: true });
  });

  it("throws an error if existingChromiumId cannot be parsed to a safe integer", async () => {
    getFieldStateMock.mockResolvedValueOnce({
      value: { url: "https://helixsync.test", pinned: false },
    });
    lookupChromiumLocalIdMock.mockResolvedValueOnce("not-a-number");

    await expect(restoreTab("remote-tab-bad")).rejects.toThrow("Invalid mapped Chromium tab ID: not-a-number");
    expect(chromeTabsUpdateMock).not.toHaveBeenCalled();
  });

  it("creates a tab when no existing Chromium ID is found", async () => {
    getFieldStateMock.mockResolvedValueOnce({
      value: { url: "https://newtab.test", pinned: false },
    });
    lookupChromiumLocalIdMock.mockResolvedValueOnce(undefined);

    await restoreTab("remote-tab-new");

    expect(chromeTabsCreateMock).toHaveBeenCalledTimes(1);
    expect(chromeTabsCreateMock).toHaveBeenCalledWith({
      url: "https://newtab.test",
      pinned: false,
      active: false,
    });
    expect(establishMappingMock).toHaveBeenCalledWith("tab", "101", "remote-tab-new");
    expect(chromeTabsUpdateMock).not.toHaveBeenCalled();
  });

  it("does not create a tab for a javascript: URL (F-10)", async () => {
    getFieldStateMock.mockResolvedValueOnce({
      value: { url: "javascript:alert(1)", pinned: false },
    });
    lookupChromiumLocalIdMock.mockResolvedValueOnce(undefined);

    await restoreTab("remote-tab-js");

    expect(chromeTabsCreateMock).not.toHaveBeenCalled();
    expect(chromeTabsUpdateMock).not.toHaveBeenCalled();
    expect(establishMappingMock).not.toHaveBeenCalled();
  });

  it("does not update an existing tab to a non-http(s) URL (F-10)", async () => {
    getFieldStateMock.mockResolvedValueOnce({
      value: { url: "file:///etc/passwd", pinned: false },
    });
    lookupChromiumLocalIdMock.mockResolvedValueOnce("42");

    await restoreTab("remote-tab-file");

    expect(chromeTabsUpdateMock).not.toHaveBeenCalled();
    expect(chromeTabsCreateMock).not.toHaveBeenCalled();
  });
});
