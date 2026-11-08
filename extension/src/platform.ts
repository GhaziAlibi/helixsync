// What differs between the browsers the extension is built for. Shared code
// imports the implementation as `@platform`, which each build points at its
// own folder (chrome/platform.ts, firefox/platform.ts; see vite.config.ts).
// So a browser's package contains only its own implementation, and a change
// to one browser's folder leaves the other's package untouched.

/** The fields of a native bookmark node this contract reads. */
export type BookmarkNodeLike = { url?: string; title?: string; type?: string };

export interface Platform {
  /** Logical root key ("0"–"4", see bookmarks/roots.ts) -> this browser's
   * id for that root. A key missing here has no native folder. */
  nativeRootIds: Readonly<Record<string, string>>;
  /** True for a native node that is neither a bookmark nor a folder (a
   * Firefox separator). Its title and URL are fixed. */
  isSeparatorNode(node: BookmarkNodeLike): boolean;
  /** The URL a native node syncs with; undefined for a folder. */
  syncedUrl(node: BookmarkNodeLike): string | undefined;
  /** The title a native node syncs with. */
  syncedTitle(node: BookmarkNodeLike): string;
  /** Creates the native node for a synced bookmark or folder. */
  createBookmark(details: { parentId: string; title: string; url?: string }): Promise<chrome.bookmarks.BookmarkTreeNode>;
  /** True when the native node `id` is a separator. */
  isLocalSeparator(id: string): Promise<boolean>;
  /** The toolbar button's API. */
  toolbarAction(): Pick<typeof chrome.action, "setBadgeText">;
  /** Host permissions for the server: its http(s) origin and the ws(s)
   * counterpart for the WebSocket channel, requested together so the user is
   * prompted only once. */
  hostPermissionOrigins(serverUrl: string): string[];
  /** True when this browser's history can hold `url` (history.addUrl
   * would accept it). */
  canStoreHistoryUrl(url: string): boolean;
}
