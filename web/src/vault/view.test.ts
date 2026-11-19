import { describe, expect, it } from "vitest";
import type { VaultBookmark, VaultFolder, VaultTab, VaultTabGroup, VaultWindow } from "./types";
import {
  bookmarkPath,
  buildBookmarkTree,
  filterBookmarks,
  filterHistory,
  groupTabs,
  matchesTerms,
  safeHref,
  searchTerms,
} from "./view";

const folder = (id: string, parent: string | null, position: string, title = id): VaultFolder => ({
  id,
  title,
  parent,
  position,
});
const bookmark = (id: string, parent: string | null, position: string, title = id, url = `https://${id}.test/`): VaultBookmark => ({
  id,
  title,
  url,
  parent,
  position,
});

describe("search", () => {
  it("needs every term, in title or url, ignoring case", () => {
    const terms = searchTerms("  Rust  DOCS ");
    expect(matchesTerms(terms, "The Rust Book", "https://doc.rust-lang.org/")).toBe(false);
    expect(matchesTerms(terms, "The Rust Book", "https://docs.rust-lang.org/")).toBe(true);
    expect(matchesTerms([], "anything", "")).toBe(true);
  });

  it("filters history and bookmarks", () => {
    const terms = searchTerms("example");
    expect(
      filterHistory(
        [
          { url: "https://example.com/", title: "", t: 2 },
          { url: "https://other.test/", title: "An Example", t: 1 },
          { url: "https://nope.test/", title: "x", t: 0 },
        ],
        terms,
      ),
    ).toHaveLength(2);
    expect(filterBookmarks([bookmark("a", null, "a", "Zed", "https://example.com/"), bookmark("b", null, "b", "Alpha", "https://example.org/")], terms).map((b) => b.id)).toEqual(["b", "a"]);
  });
});

describe("buildBookmarkTree", () => {
  it("nests by parent and orders by position", () => {
    const tree = buildBookmarkTree(
      [folder("f1", null, "b"), folder("f2", "f1", "a")],
      [bookmark("b1", "f1", "b"), bookmark("b0", null, "a")],
    );
    expect(tree.map((n) => (n.kind === "folder" ? n.folder.id : n.bookmark.id))).toEqual(["b0", "f1"]);
    const f1 = tree[1];
    if (f1.kind !== "folder") throw new Error("expected folder");
    expect(f1.children.map((n) => (n.kind === "folder" ? n.folder.id : n.bookmark.id))).toEqual(["f2", "b1"]);
  });

  it("puts items whose parent is missing at the top, and drops folder loops", () => {
    const tree = buildBookmarkTree(
      [folder("loopA", "loopB", "a"), folder("loopB", "loopA", "a")],
      [bookmark("orphan", "gone", "a")],
    );
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ kind: "bookmark" });
  });

  it("gives a bookmark's folder path", () => {
    const folders = new Map([folder("f1", null, "a", "Work"), folder("f2", "f1", "a", "Docs")].map((f) => [f.id, f]));
    expect(bookmarkPath(bookmark("b", "f2", "a"), folders)).toEqual(["Work", "Docs"]);
    expect(bookmarkPath(bookmark("b", null, "a"), folders)).toEqual([]);
  });
});

describe("groupTabs", () => {
  const tab = (id: string, deviceId: string, windowId: string, index: number, groupId: string | null = null, title = id): VaultTab => ({
    id,
    deviceId,
    windowId,
    groupId,
    url: `https://${id}.test/`,
    title,
    pinned: false,
    index,
    active: false,
  });
  const windows: VaultWindow[] = [
    { id: "w1", deviceId: "d1", focused: false, incognito: false },
    { id: "w2", deviceId: "d1", focused: true, incognito: false },
  ];
  const tabGroups: VaultTabGroup[] = [{ id: "g1", deviceId: "d1", title: "G", color: "red", collapsed: false }];

  it("groups by device, window and tab group, tabs in index order", () => {
    const views = groupTabs(
      {
        windows,
        tabGroups,
        tabs: [tab("a", "d1", "w1", 1, "g1"), tab("b", "d1", "w1", 0), tab("c", "d1", "w2", 0), tab("d", "d2", "w9", 0, "missing")],
      },
      [],
    );
    expect(views.map((v) => v.deviceId)).toEqual(["d1", "d2"]);
    const d1 = views[0];
    expect(d1.windows.map((w) => w.windowId)).toEqual(["w2", "w1"]); // focused first
    const w1 = d1.windows[1];
    expect(w1.groups.map((g) => g.group?.id ?? null)).toEqual([null, "g1"]);
    expect(w1.groups[0].tabs.map((t) => t.id)).toEqual(["b"]);
    // A tab pointing at a group that isn't there is shown ungrouped.
    expect(views[1].windows[0].groups[0].group).toBeNull();
    expect(views[1].windows[0].window).toBeNull();
  });

  it("keeps only matching tabs and drops empty devices", () => {
    const views = groupTabs(
      { windows, tabGroups, tabs: [tab("a", "d1", "w1", 0, null, "Alpha"), tab("b", "d2", "w2", 0, null, "Beta")] },
      searchTerms("alpha"),
    );
    expect(views).toHaveLength(1);
    expect(views[0].deviceId).toBe("d1");
  });
});

describe("safeHref", () => {
  it("links web addresses only", () => {
    expect(safeHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHref("http://example.com")).toBe("http://example.com/");
    for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "chrome://settings", "file:///etc/passwd", "not a url", ""]) {
      expect(safeHref(url), url).toBeNull();
    }
  });
});
