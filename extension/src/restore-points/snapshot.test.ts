import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveBookmarkNode, LiveBookmarkTree } from "../bookmarks";

const readLiveBookmarksMock = vi.fn<() => Promise<LiveBookmarkTree>>();
vi.mock("../bookmarks", () => ({ readLiveBookmarks: () => readLiveBookmarksMock() }));

const { buildPointNodes, captureNodes, hashNodes, BookmarksNotReadyError } = await import("./snapshot");

const BAR = "00000000-0000-7000-8000-000000000001";
const OTHER = "00000000-0000-7000-8000-000000000002";

function node(partial: Partial<LiveBookmarkNode> & { objectId: string; title: string }): LiveBookmarkNode {
  return {
    chromiumId: `c-${partial.objectId}`,
    kind: partial.url ? "b" : "f",
    parentObjectId: BAR,
    unmodifiable: false,
    ...partial,
  };
}

beforeEach(() => {
  readLiveBookmarksMock.mockReset();
});

describe("buildPointNodes", () => {
  it("lists parents before children, siblings in order, across roots", () => {
    const nodes = buildPointNodes([
      node({ objectId: "w", title: "Work", position: "a0" }),
      node({ objectId: "d", title: "Docs", url: "https://x.test/d", parentObjectId: "w", position: "a0" }),
      node({ objectId: "h", title: "Home", url: "https://x.test/h", position: "a1" }),
      node({ objectId: "o", title: "Other", url: "https://x.test/o", parentObjectId: OTHER, position: "a0" }),
    ]);
    expect(nodes.map((n) => n.t)).toEqual(["Work", "Docs", "Home", "Other"]);
    expect(nodes[1]).toEqual({ o: "d", k: "b", t: "Docs", u: "https://x.test/d", p: "w", x: "a0" });
    expect(nodes[0].k).toBe("f");
    expect(nodes[0]).not.toHaveProperty("u");
  });

  it("never lists a root", () => {
    const nodes = buildPointNodes([node({ objectId: "a", title: "A", url: "https://x.test", position: "a0" })]);
    expect(nodes.some((n) => n.o === BAR)).toBe(false);
  });

  it("skips managed nodes together with everything under them", () => {
    const nodes = buildPointNodes([
      node({ objectId: "m", title: "Managed", unmodifiable: true, position: "a0" }),
      node({ objectId: "mc", title: "Inside", url: "https://x.test/i", parentObjectId: "m", position: "a0" }),
      node({ objectId: "k", title: "Kept", url: "https://x.test/k", position: "a1" }),
    ]);
    expect(nodes.map((n) => n.t)).toEqual(["Kept"]);
  });

  it("keeps recorded positions and derives missing ones in order", () => {
    const nodes = buildPointNodes([
      node({ objectId: "a", title: "A", url: "https://x.test/a", position: "a0" }),
      node({ objectId: "b", title: "B", url: "https://x.test/b" }),
      node({ objectId: "c", title: "C", url: "https://x.test/c", position: "a5" }),
      node({ objectId: "d", title: "D", url: "https://x.test/d" }),
    ]);
    const positions = nodes.map((n) => n.x);
    expect(positions[0]).toBe("a0");
    expect(positions[2]).toBe("a5");
    expect([...positions].sort()).toEqual(positions);
    expect(new Set(positions).size).toBe(4);
  });

  it("repairs positions that are out of order", () => {
    const nodes = buildPointNodes([
      node({ objectId: "a", title: "A", url: "https://x.test/a", position: "a5" }),
      node({ objectId: "b", title: "B", url: "https://x.test/b", position: "a1" }),
    ]);
    expect(nodes[0].x < nodes[1].x).toBe(true);
  });

  it("merges removed subtrees back in by position", () => {
    const live = [
      node({ objectId: "a", title: "A", url: "https://x.test/a", position: "a0" }),
      node({ objectId: "c", title: "C", url: "https://x.test/c", position: "a2" }),
    ];
    const removed = [
      node({ objectId: "f", title: "Gone", position: "a1" }),
      node({ objectId: "fc", title: "Child", url: "https://x.test/f", parentObjectId: "f", position: "a0" }),
    ];
    const nodes = buildPointNodes(live, removed);
    expect(nodes.map((n) => n.t)).toEqual(["A", "Gone", "Child", "C"]);
  });

  it("drops nodes that don't lead to a root", () => {
    const nodes = buildPointNodes([
      node({ objectId: "x", title: "Orphan", url: "https://x.test/x", parentObjectId: "missing", position: "a0" }),
    ]);
    expect(nodes).toEqual([]);
  });

  it("handles a deeply nested tree without recursion limits", () => {
    const deep: LiveBookmarkNode[] = [];
    let parent = BAR;
    for (let i = 0; i < 20000; i++) {
      deep.push(node({ objectId: `n${i}`, title: `n${i}`, parentObjectId: parent, position: "a0" }));
      parent = `n${i}`;
    }
    expect(buildPointNodes(deep)).toHaveLength(20000);
  });
});

describe("captureNodes", () => {
  it("refuses a full capture while any bookmark is unmapped", async () => {
    readLiveBookmarksMock.mockResolvedValue({
      nodes: [node({ objectId: "a", title: "A", url: "https://x.test/a", position: "a0" })],
      unmapped: 2,
    });
    await expect(captureNodes({ kind: "full" })).rejects.toBeInstanceOf(BookmarksNotReadyError);
  });

  it("captures mapped nodes only when asked, ignoring unmapped ones", async () => {
    readLiveBookmarksMock.mockResolvedValue({
      nodes: [node({ objectId: "a", title: "A", url: "https://x.test/a", position: "a0" })],
      unmapped: 2,
    });
    expect((await captureNodes({ kind: "mapped-only" })).map((n) => n.t)).toEqual(["A"]);
  });

  it("adds removed subtrees to the live tree", async () => {
    readLiveBookmarksMock.mockResolvedValue({
      nodes: [node({ objectId: "a", title: "A", url: "https://x.test/a", position: "a0" })],
      unmapped: 0,
    });
    const removed = [node({ objectId: "r", title: "Removed", url: "https://x.test/r", position: "a1" })];
    expect((await captureNodes({ kind: "plus-removed", removed })).map((n) => n.t)).toEqual(["A", "Removed"]);
  });
});

describe("hashNodes", () => {
  it("is stable for the same tree and changes with it", async () => {
    const a = buildPointNodes([node({ objectId: "a", title: "A", url: "https://x.test/a", position: "a0" })]);
    const b = buildPointNodes([node({ objectId: "a", title: "A2", url: "https://x.test/a", position: "a0" })]);
    expect(await hashNodes(a)).toBe(await hashNodes([...a]));
    expect(await hashNodes(a)).not.toBe(await hashNodes(b));
    expect(await hashNodes(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
