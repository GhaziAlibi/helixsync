// Pure helpers behind the Vault page: search, bookmark tree, tab grouping.
import type { VaultBookmark, VaultData, VaultFolder, VaultTab, VaultTabGroup, VaultVisit, VaultWindow } from "./types";

/** Lower-cased whitespace-separated terms of a search box. */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when every term appears in `title` or `url`, ignoring case. An empty
 * query matches everything. */
export function matchesTerms(terms: string[], title: string, url: string): boolean {
  if (terms.length === 0) return true;
  const haystack = `${title}\n${url}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterHistory(history: VaultVisit[], terms: string[]): VaultVisit[] {
  return terms.length === 0 ? history : history.filter((v) => matchesTerms(terms, v.title, v.url));
}

export type BookmarkNode =
  | { kind: "folder"; folder: VaultFolder; children: BookmarkNode[] }
  | { kind: "bookmark"; bookmark: VaultBookmark };

function byPosition(a: { position: string; title: string }, b: { position: string; title: string }): number {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return a.title.localeCompare(b.title);
}

/** The folder tree. A folder or bookmark whose parent is missing from the
 * data (not synced, or deleted) goes at the top. Folders that only reference
 * each other in a loop are unreachable and left out. */
export function buildBookmarkTree(folders: VaultFolder[], bookmarks: VaultBookmark[]): BookmarkNode[] {
  const folderIds = new Set(folders.map((f) => f.id));
  const parentKey = (parent: string | null): string | null => (parent !== null && folderIds.has(parent) ? parent : null);

  const foldersByParent = new Map<string | null, VaultFolder[]>();
  for (const folder of folders) {
    const key = parentKey(folder.parent);
    const list = foldersByParent.get(key);
    if (list) list.push(folder);
    else foldersByParent.set(key, [folder]);
  }
  const bookmarksByParent = new Map<string | null, VaultBookmark[]>();
  for (const bookmark of bookmarks) {
    const key = parentKey(bookmark.parent);
    const list = bookmarksByParent.get(key);
    if (list) list.push(bookmark);
    else bookmarksByParent.set(key, [bookmark]);
  }

  const visiting = new Set<string>();
  const build = (parent: string | null): BookmarkNode[] => {
    const nodes: Array<BookmarkNode & { position: string; title: string }> = [];
    for (const folder of foldersByParent.get(parent) ?? []) {
      if (visiting.has(folder.id)) continue;
      visiting.add(folder.id);
      nodes.push({
        kind: "folder",
        folder,
        children: build(folder.id),
        position: folder.position,
        title: folder.title,
      });
      visiting.delete(folder.id);
    }
    for (const bookmark of bookmarksByParent.get(parent) ?? []) {
      nodes.push({ kind: "bookmark", bookmark, position: bookmark.position, title: bookmark.title });
    }
    nodes.sort(byPosition);
    return nodes;
  };
  return build(null);
}

/** Folder names from the top down to `bookmark`, for a search result row. */
export function bookmarkPath(bookmark: VaultBookmark, folders: Map<string, VaultFolder>): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let parent = bookmark.parent;
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    const folder = folders.get(parent);
    if (!folder) break;
    path.unshift(folder.title);
    parent = folder.parent;
  }
  return path;
}

export function filterBookmarks(bookmarks: VaultBookmark[], terms: string[]): VaultBookmark[] {
  const matches = bookmarks.filter((b) => matchesTerms(terms, b.title, b.url));
  return matches.sort((a, b) => a.title.localeCompare(b.title));
}

export interface TabGroupView {
  /** Null for tabs that are in no group. */
  group: VaultTabGroup | null;
  tabs: VaultTab[];
}

export interface TabWindowView {
  windowId: string;
  window: VaultWindow | null;
  groups: TabGroupView[];
}

export interface TabDeviceView {
  deviceId: string;
  windows: TabWindowView[];
}

/** Open tabs grouped by device, then window, then tab group, keeping only tabs
 * that match `terms`. Each tab's device is the one whose operation produced
 * its current state. */
export function groupTabs(data: Pick<VaultData, "tabs" | "windows" | "tabGroups">, terms: string[]): TabDeviceView[] {
  const windowsById = new Map(data.windows.map((w) => [w.id, w]));
  const groupsById = new Map(data.tabGroups.map((g) => [g.id, g]));

  const devices = new Map<string, Map<string, Map<string | null, VaultTab[]>>>();
  for (const tab of data.tabs) {
    if (!matchesTerms(terms, tab.title, tab.url)) continue;
    const windows = devices.get(tab.deviceId) ?? new Map<string, Map<string | null, VaultTab[]>>();
    devices.set(tab.deviceId, windows);
    const groups = windows.get(tab.windowId) ?? new Map<string | null, VaultTab[]>();
    windows.set(tab.windowId, groups);
    const groupKey = tab.groupId !== null && groupsById.has(tab.groupId) ? tab.groupId : null;
    const list = groups.get(groupKey) ?? [];
    groups.set(groupKey, list);
    list.push(tab);
  }

  const views: TabDeviceView[] = [];
  for (const [deviceId, windows] of devices) {
    const windowViews: TabWindowView[] = [];
    for (const [windowId, groups] of windows) {
      const groupViews: TabGroupView[] = [];
      for (const [groupKey, tabs] of groups) {
        tabs.sort((a, b) => a.index - b.index);
        groupViews.push({ group: groupKey === null ? null : (groupsById.get(groupKey) ?? null), tabs });
      }
      // Ungrouped tabs first, then groups by their first tab's position.
      groupViews.sort((a, b) => {
        if (a.group === null) return -1;
        if (b.group === null) return 1;
        return a.tabs[0].index - b.tabs[0].index;
      });
      windowViews.push({ windowId, window: windowsById.get(windowId) ?? null, groups: groupViews });
    }
    windowViews.sort((a, b) => Number(b.window?.focused ?? false) - Number(a.window?.focused ?? false));
    views.push({ deviceId, windows: windowViews });
  }
  views.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  return views;
}

/** The URL to put in a link's `href`, or null when it shouldn't be one. Only
 * web addresses are linked: a bookmark can hold `javascript:` or `data:`, which
 * must never run from the dashboard's origin. */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "ftp:" ? parsed.href : null;
  } catch {
    return null;
  }
}
