import { describe, expect, it } from "vitest";
import { platform } from "./platform";

describe("Chrome host permissions", () => {
  it("are the server's origin and its WebSocket counterpart, port included", () => {
    expect(platform.hostPermissionOrigins("http://localhost:5174")).toEqual(["http://localhost:5174/*", "ws://localhost:5174/*"]);
    expect(platform.hostPermissionOrigins("https://sync.example.com/")).toEqual(["https://sync.example.com/*", "wss://sync.example.com/*"]);
  });
});

describe("Chrome bookmarks", () => {
  it("have no separators", async () => {
    expect(platform.isSeparatorNode({ type: "separator" })).toBe(false);
    expect(await platform.isLocalSeparator("1")).toBe(false);
    expect(platform.syncedUrl({ url: "https://a.example/" })).toBe("https://a.example/");
    expect(platform.syncedTitle({})).toBe("");
  });
});
