import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeBookmarks, createFakeStorageArea, type FakeBookmarks } from "../test-support/fake-bookmarks";
import type { LocalOperation, OperationType, ObjectType } from "../sync/types";

// The bookmark code against a real IndexedDB (fake-indexeddb) and an
// in-memory Chromium tree: what a restore relies on from the engine
// (docs/protocol.md §16.4). Only the sync engine and the server client are
// stubbed.

let fake: FakeBookmarks;
let lamport: number;
let sequence: number;
const massDeletes: Array<{ origin: string; count: number }> = [];

async function load() {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  fake = createFakeBookmarks();
  lamport = 1000;
  sequence = 0;
  vi.stubGlobal("chrome", {
    bookmarks: fake.api,
    storage: { session: createFakeStorageArea(), local: createFakeStorageArea() },
  });
  vi.doMock("../storage/db", async (importActual) => ({
    ...(await importActual<typeof import("../storage/db")>()),
    getDevice: async () => ({ deviceId: "dev-A" }),
  }));
  vi.doMock("../api/client", () => ({ fetchSettings: async () => ({ syncBookmarks: true }) }));
  vi.doMock("../sync/engine", () => ({
    registerApplier: vi.fn(),
    registerBatchApplier: vi.fn(),
    scheduleLocalSync: vi.fn(),
    createLocalOperationsBatch: async (
      items: Array<{ objectType: ObjectType; objectId: string; operationType: OperationType; payload: unknown }>,
    ) =>
      items.map((item) => ({
        operation: {
          operationId: `op-${++sequence}`,
          deviceSequence: sequence,
          lamportTimestamp: ++lamport,
          objectType: item.objectType,
          objectId: item.objectId,
          operationType: item.operationType,
          encryptionVersion: 1,
          payload: "encrypted",
        } satisfies LocalOperation,
        deviceId: "dev-A",
      })),
  }));
  const bookmarks = await import("./index");
  const db = await import("../storage/db");
  bookmarks.setMassDeleteHandler((event) => {
    massDeletes.push({ origin: event.origin, count: event.count });
  });
  return { bookmarks, db };
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** Local ops for `items`, applied the way a restore applies them. */
async function applyOps(
  { bookmarks }: Loaded,
  items: Array<{ objectType: ObjectType; objectId: string; operationType: OperationType; payload: unknown }>,
) {
  const engine = await import("../sync/engine");
  const created = await engine.createLocalOperationsBatch(items);
  await bookmarks.applyRestoreOperations(
    created,
    items.map((i) => i.payload),
  );
}

async function liveByTitle(loaded: Loaded) {
  const live = await loaded.bookmarks.readLiveBookmarks();
  return { live, byTitle: new Map(live.nodes.map((n) => [n.title, n])) };
}

beforeEach(() => {
  massDeletes.length = 0;
});

describe("deleting a folder forgets what was inside it", () => {
  it("drops the mappings of descendants when the folder is removed locally", async () => {
    const loaded = await load();
    const folder = fake.add("1", "Work");
    const sub = fake.add(folder, "Docs");
    fake.add(sub, "Spec", "https://example.com/spec");
    fake.add(folder, "Wiki", "https://example.com/wiki");
    await loaded.bookmarks.backfillExisting();

    const { byTitle } = await liveByTitle(loaded);
    const ids = ["Work", "Docs", "Spec", "Wiki"].map((t) => byTitle.get(t)!.chromiumId);
    expect((await loaded.db.getMappingsByLocalIds("bookmark", ids)).size).toBe(4);

    const [subtree] = await fake.api.getSubTree(folder);
    fake.remove(folder);
    await loaded.bookmarks.flushBookmarkEvents([
      { kind: "removed", id: folder, removeInfo: { parentId: "1", index: 0, node: subtree } as never },
    ]);

    expect((await loaded.db.getMappingsByLocalIds("bookmark", ids)).size).toBe(0);
  });

  it("drops them when a remote delete removes the folder", async () => {
    const loaded = await load();
    const folder = fake.add("1", "Work");
    fake.add(folder, "Wiki", "https://example.com/wiki");
    await loaded.bookmarks.backfillExisting();
    const { byTitle } = await liveByTitle(loaded);
    const work = byTitle.get("Work")!;
    const wikiChromiumId = byTitle.get("Wiki")!.chromiumId;

    await applyOps(loaded, [{ objectType: "bookmarkFolder", objectId: work.objectId, operationType: "delete", payload: {} }]);

    expect(fake.has(folder)).toBe(false);
    expect((await loaded.db.getMappingsByLocalIds("bookmark", [work.chromiumId, wikiChromiumId])).size).toBe(0);
  });

  it("brings the children of a deleted folder back with their objectIds", async () => {
    const loaded = await load();
    const folder = fake.add("1", "Work");
    fake.add(folder, "Wiki", "https://example.com/wiki");
    fake.add(folder, "Mail", "https://example.com/mail");
    await loaded.bookmarks.backfillExisting();
    const before = (await liveByTitle(loaded)).byTitle;

    // Another device deleted the folder; this one applies it.
    await applyOps(loaded, [
      { objectType: "bookmarkFolder", objectId: before.get("Work")!.objectId, operationType: "delete", payload: {} },
    ]);
    expect((await liveByTitle(loaded)).live.nodes).toHaveLength(0);

    // A restore: the folder, then its children (still live on the account).
    const restoreOps = ["Work", "Wiki", "Mail"].map((title) => {
      const node = before.get(title)!;
      return {
        objectType: (node.kind === "f" ? "bookmarkFolder" : "bookmark") as ObjectType,
        objectId: node.objectId,
        operationType: "restore" as const,
        payload: {
          title,
          url: node.url ?? null,
          parent: node.parentObjectId,
          position: node.position!,
        },
      };
    });
    await applyOps(loaded, restoreOps);

    const after = (await liveByTitle(loaded)).byTitle;
    expect([...after.keys()].sort()).toEqual(["Mail", "Wiki", "Work"]);
    for (const title of ["Work", "Wiki", "Mail"]) {
      expect(after.get(title)!.objectId).toBe(before.get(title)!.objectId);
    }
    // In the folder, in the point's order.
    expect(fake.titles(after.get("Work")!.chromiumId)).toEqual(["Wiki", "Mail"]);
  });

  it("places a restored node where the point had it, not at the end", async () => {
    const loaded = await load();
    fake.add("1", "A", "https://example.com/a");
    fake.add("1", "B", "https://example.com/b");
    fake.add("1", "C", "https://example.com/c");
    await loaded.bookmarks.backfillExisting();
    const before = (await liveByTitle(loaded)).byTitle;
    const b = before.get("B")!;

    await applyOps(loaded, [{ objectType: "bookmark", objectId: b.objectId, operationType: "delete", payload: {} }]);
    expect(fake.titles("1")).toEqual(["A", "C"]);
    await applyOps(loaded, [
      {
        objectType: "bookmark",
        objectId: b.objectId,
        operationType: "restore",
        payload: { title: "B", url: "https://example.com/b", parent: b.parentObjectId, position: b.position! },
      },
    ]);
    expect(fake.titles("1")).toEqual(["A", "B", "C"]);
  });
});

describe("a stale mapping does not block re-creating a node", () => {
  it("creates the node when the mapped Chromium node is gone", async () => {
    const loaded = await load();
    const folder = fake.add("1", "Work");
    const child = fake.add(folder, "Wiki", "https://example.com/wiki");
    await loaded.bookmarks.backfillExisting();
    const before = (await liveByTitle(loaded)).byTitle;
    const wiki = before.get("Wiki")!;

    // A device without the fix: the folder went, the child's mapping stayed.
    fake.remove(folder);
    expect((await loaded.db.getMappingsByLocalIds("bookmark", [child])).size).toBe(1);

    await applyOps(loaded, [
      {
        objectType: "bookmarkFolder",
        objectId: before.get("Work")!.objectId,
        operationType: "restore",
        payload: { title: "Work", url: null, parent: before.get("Work")!.parentObjectId, position: before.get("Work")!.position! },
      },
      {
        objectType: "bookmark",
        objectId: wiki.objectId,
        operationType: "restore",
        payload: { title: "Wiki", url: "https://example.com/wiki", parent: wiki.parentObjectId, position: wiki.position! },
      },
    ]);

    const after = (await liveByTitle(loaded)).byTitle;
    expect(after.get("Wiki")?.objectId).toBe(wiki.objectId);
    expect(fake.has(child)).toBe(false);
    expect(fake.titles(after.get("Work")!.chromiumId)).toEqual(["Wiki"]);
  });

  it("sweeps mappings of nodes that no longer exist, once", async () => {
    const loaded = await load();
    const folder = fake.add("1", "Work");
    fake.add(folder, "Wiki", "https://example.com/wiki");
    const keep = fake.add("1", "Keep", "https://example.com/keep");
    await loaded.bookmarks.backfillExisting();
    const ids = ["Work", "Wiki"].map((t) => fake.find(t === "Work" ? "1" : folder, t)!);

    fake.remove(folder); // no event: leaves two stale mappings

    expect(await loaded.bookmarks.sweepStaleBookmarkMappings()).toBe(2);
    expect((await loaded.db.getMappingsByLocalIds("bookmark", ids)).size).toBe(0);
    expect((await loaded.db.getMappingsByLocalIds("bookmark", [keep])).size).toBe(1);

    // The one-time wrapper runs it the first time only.
    const other = fake.add("1", "Other", "https://example.com/other");
    await loaded.bookmarks.backfillExisting();
    fake.remove(keep);
    await loaded.bookmarks.sweepStaleBookmarkMappingsOnce();
    expect((await loaded.db.getMappingsByLocalIds("bookmark", [keep]))).toHaveProperty("size", 0);
    expect((await chrome.storage.local.get("bookmarkMappingSweepDone")).bookmarkMappingSweepDone).toBe(true);

    fake.remove(other);
    await loaded.bookmarks.sweepStaleBookmarkMappingsOnce();
    expect((await loaded.db.getMappingsByLocalIds("bookmark", [other]))).toHaveProperty("size", 1);
  });
});

describe("readLiveBookmarks", () => {
  it("lists parents before children, siblings in order, and counts unmapped nodes", async () => {
    const loaded = await load();
    const folder = fake.add("1", "Work");
    fake.add(folder, "Wiki", "https://example.com/wiki");
    fake.add("1", "Home", "https://example.com/home");
    await loaded.bookmarks.backfillExisting();
    fake.add("1", "New", "https://example.com/new"); // not captured yet
    fake.add(folder, "Hidden", "https://example.com/hidden");

    const live = await loaded.bookmarks.readLiveBookmarks();
    expect(live.nodes.map((n) => n.title)).toEqual(["Work", "Wiki", "Home"]);
    expect(live.unmapped).toBe(2);
    const work = live.nodes[0];
    expect(live.nodes[1].parentObjectId).toBe(work.objectId);
    expect(live.nodes[0].parentObjectId).toBe("00000000-0000-7000-8000-000000000001");
    expect(live.nodes.every((n) => typeof n.position === "string")).toBe(true);
  });
});

describe("mass deletes", () => {
  it("reports a local removal of 50 or more, with the removed subtree", async () => {
    const loaded = await load();
    const folder = fake.add("1", "Big");
    for (let i = 0; i < 55; i++) fake.add(folder, `b${i}`, `https://example.com/${i}`);
    fake.add("1", "Small", "https://example.com/small");
    await loaded.bookmarks.backfillExisting();

    const seen: unknown[] = [];
    loaded.bookmarks.setMassDeleteHandler((event) => {
      seen.push(event);
    });
    const [subtree] = await fake.api.getSubTree(folder);
    fake.remove(folder);
    await loaded.bookmarks.flushBookmarkEvents([
      { kind: "removed", id: folder, removeInfo: { parentId: "1", index: 0, node: subtree } as never },
    ]);

    expect(seen).toHaveLength(1);
    const event = seen[0] as { origin: string; count: number; removed: Array<{ title: string; position?: string }> };
    expect(event.origin).toBe("local");
    expect(event.count).toBe(56);
    expect(event.removed).toHaveLength(56);
    expect(event.removed[0].title).toBe("Big");
    expect(event.removed.every((n) => typeof n.position === "string")).toBe(true);
  });

  it("stays quiet below the threshold", async () => {
    const loaded = await load();
    const folder = fake.add("1", "Few");
    for (let i = 0; i < 10; i++) fake.add(folder, `b${i}`, `https://example.com/${i}`);
    await loaded.bookmarks.backfillExisting();
    massDeletes.length = 0;
    const [subtree] = await fake.api.getSubTree(folder);
    fake.remove(folder);
    await loaded.bookmarks.flushBookmarkEvents([
      { kind: "removed", id: folder, removeInfo: { parentId: "1", index: 0, node: subtree } as never },
    ]);
    expect(massDeletes).toHaveLength(0);
  });

  it("reports a remote batch that deletes many, before applying it", async () => {
    const loaded = await load();
    const folder = fake.add("1", "Big");
    for (let i = 0; i < 60; i++) fake.add(folder, `b${i}`, `https://example.com/${i}`);
    await loaded.bookmarks.backfillExisting();
    const { byTitle } = await liveByTitle(loaded);

    const stillThere: boolean[] = [];
    loaded.bookmarks.setMassDeleteHandler(() => {
      stillThere.push(fake.has(folder));
    });
    await applyOps(loaded, [
      { objectType: "bookmarkFolder", objectId: byTitle.get("Big")!.objectId, operationType: "delete", payload: {} },
    ]);
    expect(stillThere).toEqual([true]);
    expect(fake.has(folder)).toBe(false);
  });
});
