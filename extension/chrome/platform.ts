// Chrome (and other Chromium browsers) side of src/platform.ts.
import type { Platform } from "../src/platform";

export const platform: Platform = {
  // Chromium's root ids are the logical keys themselves. It has no
  // Bookmarks menu ("4"); see bookmarks/roots.ts for its stand-in.
  nativeRootIds: { "0": "0", "1": "1", "2": "2", "3": "3" },
  // Chromium has no separators.
  isSeparatorNode: () => false,
  syncedUrl: (node) => node.url,
  syncedTitle: (node) => node.title ?? "",
  createBookmark: (details) => chrome.bookmarks.create(details),
  isLocalSeparator: async () => false,
  toolbarAction: () => chrome.action,
  hostPermissionOrigins: (serverUrl) => {
    const url = new URL(serverUrl);
    const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
    return [`${url.origin}/*`, `${wsScheme}//${url.host}/*`];
  },
  canStoreHistoryUrl: () => true,
};
