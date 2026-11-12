import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn(async (details: unknown) => ({ id: "new", details }));
const getMock = vi.fn<(id: string) => Promise<Array<{ id: string; type?: string }>>>();

(globalThis as unknown as { chrome: unknown }).chrome = {
  bookmarks: { create: (details: unknown) => createMock(details), get: (id: string) => getMock(id) },
  browserAction: { setBadgeText: vi.fn() },
};

const { platform, SEPARATOR_URL, SEPARATOR_TITLE, isSeparatorUrl } = await import("./platform");

describe("Firefox separators", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sync as a bookmark with floccus's marker URL", () => {
    const separator = { type: "separator", url: "data:", title: "" };
    expect(platform.syncedUrl(separator)).toBe(SEPARATOR_URL);
    expect(platform.syncedTitle(separator)).toBe(SEPARATOR_TITLE);
    expect(platform.syncedUrl({ type: "bookmark", url: "https://a.example/", title: "A" })).toBe("https://a.example/");
    expect(platform.syncedUrl({ type: "folder", title: "Folder" })).toBeUndefined();
  });

  it("recognise the marker by host only", () => {
    expect(isSeparatorUrl("https://separator.floccus.org/?id=42")).toBe(true);
    expect(isSeparatorUrl("https://separator.floccus.org/vertical.html")).toBe(true);
    expect(isSeparatorUrl("https://floccus.org/")).toBe(false);
    expect(isSeparatorUrl(null)).toBe(false);
    expect(isSeparatorUrl("not a url")).toBe(false);
  });

  it("are created back as native separators", async () => {
    await platform.createBookmark({ parentId: "toolbar_____", title: SEPARATOR_TITLE, url: SEPARATOR_URL });
    expect(createMock).toHaveBeenCalledWith({ parentId: "toolbar_____", type: "separator" });

    await platform.createBookmark({ parentId: "toolbar_____", title: "A", url: "https://a.example/" });
    expect(createMock).toHaveBeenLastCalledWith({ parentId: "toolbar_____", title: "A", url: "https://a.example/" });
  });

  it("are detected locally, so their title and URL are never set", async () => {
    getMock.mockResolvedValueOnce([{ id: "s", type: "separator" }]);
    expect(await platform.isLocalSeparator("s")).toBe(true);
    getMock.mockResolvedValueOnce([{ id: "b", type: "bookmark" }]);
    expect(await platform.isLocalSeparator("b")).toBe(false);
    getMock.mockRejectedValueOnce(new Error("gone"));
    expect(await platform.isLocalSeparator("x")).toBe(false);
  });
});

describe("Firefox toolbar button", () => {
  it("is browserAction under Manifest V2", () => {
    expect(platform.toolbarAction()).toBe((globalThis as unknown as { chrome: { browserAction: unknown } }).chrome.browserAction);
  });
});

describe("Firefox host permissions", () => {
  // Firefox never matches a pattern that names a port, so the pattern names
  // the host alone.
  it("leave the port out", () => {
    expect(platform.hostPermissionOrigins("http://localhost:5174")).toEqual(["http://localhost/*", "ws://localhost/*"]);
    expect(platform.hostPermissionOrigins("https://sync.example.com:8443/")).toEqual(["https://sync.example.com/*", "wss://sync.example.com/*"]);
    expect(platform.hostPermissionOrigins("https://sync.example.com")).toEqual(["https://sync.example.com/*", "wss://sync.example.com/*"]);
    expect(platform.hostPermissionOrigins("http://[::1]:8080")).toEqual(["http://[::1]/*", "ws://[::1]/*"]);
  });
});

describe("Firefox history", () => {
  // Firefox's history.addUrl rejects a longer URL ("An unexpected error
  // occurred"), measured on Firefox 159.
  it("holds URLs up to 2000 characters", () => {
    const url = (length: number) => "https://example.com/" + "a".repeat(length - "https://example.com/".length);
    expect(platform.canStoreHistoryUrl(url(2000))).toBe(true);
    expect(platform.canStoreHistoryUrl(url(2001))).toBe(false);
  });
});
