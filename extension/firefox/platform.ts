// Firefox side of src/platform.ts.
import type { BookmarkNodeLike, Platform } from "../src/platform";

// A separator syncs as a bookmark with this URL (floccus's convention, so the
// two interoperate): Chromium shows it as a plain bookmark, Firefox turns it
// back into a separator. Firefox's own separator nodes carry `url: "data:"`.
export const SEPARATOR_URL = "https://separator.floccus.org/";
export const SEPARATOR_TITLE = "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯";

export function isSeparatorUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === "separator.floccus.org";
  } catch {
    return false;
  }
}

/** Longest URL Firefox's history.addUrl accepts (measured on Firefox 159). */
export const FIREFOX_HISTORY_MAX_URL_LENGTH = 2000;

const isSeparatorNode =(node: BookmarkNodeLike): boolean => node.type === "separator";

type BadgeApi = ReturnType<Platform["toolbarAction"]>;

export const platform: Platform = {
  nativeRootIds: {
    "0": "root________",
    "1": "toolbar_____",
    "2": "unfiled_____",
    "3": "mobile______",
    "4": "menu________",
  },
  isSeparatorNode,
  syncedUrl: (node) => (isSeparatorNode(node) ? SEPARATOR_URL : node.url),
  syncedTitle: (node) => (isSeparatorNode(node) ? SEPARATOR_TITLE : (node.title ?? "")),
  createBookmark: (details) =>
    isSeparatorUrl(details.url)
      ? chrome.bookmarks.create({ parentId: details.parentId, type: "separator" } as chrome.bookmarks.CreateDetails)
      : chrome.bookmarks.create(details),
  isLocalSeparator: async (id) => {
    try {
      const [node] = await chrome.bookmarks.get(id);
      return !!node && isSeparatorNode(node as BookmarkNodeLike);
    } catch {
      return false;
    }
  },
  // The Firefox build is Manifest V2, where the toolbar button is
  // browserAction.
  toolbarAction: () => (chrome as unknown as { browserAction: BadgeApi }).browserAction,
  // Firefox accepts a pattern with a port (http://localhost:8080/*) but never
  // matches it, so requests to a server on a non-default port fail. The
  // pattern names the host without a port, which covers every port on it.
  hostPermissionOrigins: (serverUrl) => {
    const url = new URL(serverUrl);
    const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
    return [`${url.protocol}//${url.hostname}/*`, `${wsScheme}//${url.hostname}/*`];
  },
  // Firefox's history refuses a URL longer than this ("An unexpected error
  // occurred"), so such a visit from another browser can't be added here.
  canStoreHistoryUrl: (url) => url.length <= FIREFOX_HISTORY_MAX_URL_LENGTH,
};
