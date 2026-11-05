import { describe, expect, it } from "vitest";
import type { LiveBookmarkNode } from "../bookmarks";
import type { PointNode } from "./format";
import { planRestore, UnknownRestoreScopeError, type PlannedOperation } from "./planner";

const BAR = "00000000-0000-7000-8000-000000000001";
const OTHER = "00000000-0000-7000-8000-000000000002";

function p(o: string, t: string, parent: string, x: string, url?: string): PointNode {
  return url === undefined ? { o, k: "f", t, p: parent, x } : { o, k: "b", t, u: url, p: parent, x };
}

function l(o: string, t: string, parent: string, x: string | undefined, url?: string, unmodifiable = false): LiveBookmarkNode {
  return {
    chromiumId: `c-${o}`,
    objectId: o,
    kind: url === undefined ? "f" : "b",
    title: t,
    ...(url !== undefined ? { url } : {}),
    parentObjectId: parent,
    position: x,
    unmodifiable,
  };
}

const kinds = (ops: PlannedOperation[]) => ops.map((o) => `${o.operationType}:${o.title}`);

describe("planRestore: merge", () => {
  it("restores a deleted folder with its children, parent first", () => {
    const point = {
      nodes: [
        p("w", "Work", BAR, "a0"),
        p("s", "Sub", "w", "a0"),
        p("d", "Docs", "s", "a0", "https://x.test/d"),
        p("m", "Mail", "w", "a1", "https://x.test/m"),
      ],
    };
    const plan = planRestore(point, [], "merge", "all");
    expect(kinds(plan.operations)).toEqual(["restore:Work", "restore:Sub", "restore:Docs", "restore:Mail"]);
    expect(plan.operations[2].payload).toEqual({ title: "Docs", url: "https://x.test/d", parent: "s", position: "a0" });
    expect(plan.operations[0].payload).toEqual({ title: "Work", url: null, parent: BAR, position: "a0" });
    expect(plan.operations[0].objectType).toBe("bookmarkFolder");
    expect(plan.operations[2].objectType).toBe("bookmark");
    expect(plan.counts).toEqual({ restored: 4, updated: 0, moved: 0, deleted: 0, skipped: 0 });
  });

  it("reverts a rename and a changed URL with one update of the changed fields", () => {
    const point = { nodes: [p("a", "Old", BAR, "a0", "https://x.test/old"), p("b", "Same", BAR, "a1", "https://x.test/b")] };
    const live = [l("a", "New", BAR, "a0", "https://x.test/old"), l("b", "Same", BAR, "a1", "https://x.test/other")];
    const plan = planRestore(point, live, "merge", "all");
    expect(plan.operations.map((o) => [o.objectId, o.operationType, o.payload])).toEqual([
      ["a", "update", { title: "Old" }],
      ["b", "update", { url: "https://x.test/b" }],
    ]);
  });

  it("moves a node whose parent or position differs", () => {
    const point = { nodes: [p("f", "F", BAR, "a0"), p("a", "A", "f", "a0", "https://x.test/a"), p("b", "B", BAR, "a1", "https://x.test/b")] };
    const live = [
      l("f", "F", BAR, "a0"),
      l("a", "A", BAR, "a0", "https://x.test/a"), // should be inside F
      l("b", "B", BAR, "a5", "https://x.test/b"), // reordered
    ];
    const plan = planRestore(point, live, "merge", "all");
    expect(plan.operations.map((o) => [o.objectId, o.operationType, o.payload])).toEqual([
      ["a", "move", { parent: "f", position: "a0" }],
      ["b", "move", { parent: BAR, position: "a1" }],
    ]);
  });

  it("treats a node with no recorded position as needing a move", () => {
    const plan = planRestore({ nodes: [p("a", "A", BAR, "a0", "https://x.test/a")] }, [l("a", "A", BAR, undefined, "https://x.test/a")], "merge", "all");
    expect(kinds(plan.operations)).toEqual(["move:A"]);
  });

  it("emits nothing when nothing differs, and never deletes", () => {
    const point = { nodes: [p("a", "A", BAR, "a0", "https://x.test/a")] };
    const live = [l("a", "A", BAR, "a0", "https://x.test/a"), l("extra", "Extra", BAR, "a1", "https://x.test/e")];
    const plan = planRestore(point, live, "merge", "all");
    expect(plan.operations).toEqual([]);
  });

  it("leaves managed nodes alone", () => {
    const point = { nodes: [p("a", "Old", BAR, "a0", "https://x.test/a")] };
    const live = [l("a", "New", OTHER, "z", "https://x.test/a", true)];
    expect(planRestore(point, live, "merge", "all").operations).toEqual([]);
  });

  it("skips a disallowed URL scheme and counts it", () => {
    const point = {
      nodes: [p("a", "Bad", BAR, "a0", "javascript:alert(1)"), p("b", "Good", BAR, "a1", "https://x.test/g")],
    };
    const plan = planRestore(point, [], "merge", "all");
    expect(kinds(plan.operations)).toEqual(["restore:Good"]);
    expect(plan.counts.skipped).toBe(1);
  });

  it("does not update toward a disallowed URL", () => {
    const point = { nodes: [p("a", "A", BAR, "a0", "javascript:alert(1)")] };
    const live = [l("a", "A", BAR, "a0", "https://x.test/a")];
    const plan = planRestore(point, live, "merge", "all");
    expect(plan.operations).toEqual([]);
    expect(plan.counts.skipped).toBe(1);
  });

  it("orders restores, then updates, then moves", () => {
    const point = {
      nodes: [p("a", "A2", BAR, "a0", "https://x.test/a"), p("b", "B", BAR, "a1", "https://x.test/b"), p("c", "C", BAR, "a2", "https://x.test/c")],
    };
    const live = [l("a", "A", BAR, "a0", "https://x.test/a"), l("b", "B", BAR, "zz", "https://x.test/b")];
    expect(kinds(planRestore(point, live, "merge", "all").operations)).toEqual(["restore:C", "update:A2", "move:B"]);
  });
});

describe("planRestore: exact", () => {
  it("deletes live nodes the point lacks, topmost only", () => {
    const point = { nodes: [p("keep", "Keep", BAR, "a0", "https://x.test/k")] };
    const live = [
      l("keep", "Keep", BAR, "a0", "https://x.test/k"),
      l("nf", "NewFolder", BAR, "a1"),
      l("nb", "InsideNew", "nf", "a0", "https://x.test/n"),
      l("nl", "Loose", OTHER, "a0", "https://x.test/l"),
    ];
    const plan = planRestore(point, live, "exact", "all");
    expect(kinds(plan.operations)).toEqual(["delete:NewFolder", "delete:Loose"]);
    expect(plan.counts.deleted).toBe(2);
    expect(plan.operations[0].payload).toEqual({});
  });

  it("moves a kept node out of a folder it deletes, before deleting", () => {
    const point = { nodes: [p("k", "Kept", BAR, "a0", "https://x.test/k")] };
    const live = [l("nf", "Added", BAR, "a0"), l("k", "Kept", "nf", "a0", "https://x.test/k")];
    const plan = planRestore(point, live, "exact", "all");
    expect(kinds(plan.operations)).toEqual(["move:Kept", "delete:Added"]);
  });

  it("never deletes managed nodes", () => {
    const plan = planRestore({ nodes: [] }, [l("m", "Managed", BAR, "a0", "https://x.test/m", true)], "exact", "all");
    expect(plan.operations).toEqual([]);
  });

  it("does the merge work too", () => {
    const point = { nodes: [p("a", "A", BAR, "a0", "https://x.test/a")] };
    const plan = planRestore(point, [l("x", "X", BAR, "a0", "https://x.test/x")], "exact", "all");
    expect(kinds(plan.operations)).toEqual(["restore:A", "delete:X"]);
  });
});

describe("planRestore: one folder", () => {
  const point = {
    nodes: [
      p("top", "Top", BAR, "a0"),
      p("f", "F", "top", "a0"),
      p("fa", "FA", "f", "a0", "https://x.test/fa"),
      p("fb", "FB", "f", "a1", "https://x.test/fb"),
      p("other", "Other", BAR, "a1", "https://x.test/o"),
    ],
  };

  it("covers only the folder's subtree", () => {
    const live = [l("top", "Top", BAR, "a0"), l("f", "F", "top", "a0"), l("fa", "FA-renamed", "f", "a0", "https://x.test/fa")];
    const plan = planRestore(point, live, "merge", "f");
    expect(kinds(plan.operations)).toEqual(["restore:FB", "update:FA"]);
  });

  it("restores a missing ancestor chain too, as restores only", () => {
    const live = [l("other", "Renamed", BAR, "a1", "https://x.test/o")];
    const plan = planRestore(point, live, "merge", "f");
    expect(kinds(plan.operations)).toEqual(["restore:Top", "restore:F", "restore:FA", "restore:FB"]);
  });

  it("does not edit a live ancestor", () => {
    const live = [l("top", "Top-renamed", OTHER, "z"), l("f", "F", "top", "a0")];
    const plan = planRestore(point, live, "merge", "f");
    expect(kinds(plan.operations)).toEqual(["restore:FA", "restore:FB"]);
  });

  it("exact deletes only inside the folder", () => {
    const live = [
      l("top", "Top", BAR, "a0"),
      l("f", "F", "top", "a0"),
      l("fa", "FA", "f", "a0", "https://x.test/fa"),
      l("fb", "FB", "f", "a1", "https://x.test/fb"),
      l("extra-in", "ExtraInside", "f", "a2", "https://x.test/e1"),
      l("extra-out", "ExtraOutside", BAR, "a9", "https://x.test/e2"),
    ];
    const plan = planRestore(point, live, "exact", "f");
    expect(kinds(plan.operations)).toEqual(["delete:ExtraInside"]);
  });

  it("deletes nothing in exact mode when the folder is not live", () => {
    const live = [l("extra-out", "ExtraOutside", BAR, "a9", "https://x.test/e2")];
    const plan = planRestore(point, live, "exact", "f");
    expect(plan.counts.deleted).toBe(0);
  });

  it("rejects a folder the point doesn't have, or a bookmark", () => {
    expect(() => planRestore(point, [], "merge", "nope")).toThrow(UnknownRestoreScopeError);
    expect(() => planRestore(point, [], "merge", "other")).toThrow(UnknownRestoreScopeError);
  });
});

describe("planRestore: roots and samples", () => {
  it("never touches a built-in root, even when live lists none", () => {
    const plan = planRestore({ nodes: [p("a", "A", BAR, "a0", "https://x.test/a")] }, [], "exact", "all");
    expect(plan.operations.every((o) => o.objectId !== BAR)).toBe(true);
  });

  it("samples a few titles per kind", () => {
    const nodes = Array.from({ length: 30 }, (_, i) => p(`n${i}`, `T${i}`, BAR, `a${i.toString(36).padStart(2, "0")}`, `https://x.test/${i}`));
    const plan = planRestore({ nodes }, [], "merge", "all");
    expect(plan.counts.restored).toBe(30);
    expect(plan.sample.restored).toHaveLength(8);
  });

  it("plans a 100,000-node restore", () => {
    const nodes = Array.from({ length: 100_000 }, (_, i) =>
      p(`n${i}`, `T${i}`, BAR, `a${i.toString(36).padStart(5, "0")}`, `https://x.test/${i}`),
    );
    const live = nodes.slice(0, 50_000).map((n) => l(n.o, n.t, n.p, n.x, n.u));
    const plan = planRestore({ nodes }, live, "exact", "all");
    expect(plan.counts).toMatchObject({ restored: 50_000, updated: 0, moved: 0, deleted: 0 });
  });
});
