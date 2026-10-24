import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the chunked cursor walks in db.ts: each chunk must
// resume after the last row the previous chunk visited, never on it.
// IndexedDB's continuePrimaryKey lands on a row >= the given key and throws
// DataError when that is the current row, so the fake below does the same.

type Row = Record<string, unknown>;
const stores = vi.hoisted(() => ({
  remote_objects: new Map<string, Row>(),
  object_mappings: new Map<string, Row>(),
}));
// Runs between chunks, where real code yields and the tree could change.
const betweenChunks = vi.hoisted(() => ({ hook: () => {} }));

vi.mock("../util/yield", () => ({ yieldToEventLoop: async () => betweenChunks.hook() }));

vi.mock("idb", () => {
  const INDEX_KEYS: Record<string, (row: Row) => unknown> = {
    "by-type-deleted": (row) => JSON.stringify([row.objectType, row.deleted]),
    "by-type": (row) => row.objectType,
  };
  const matches = (key: unknown, range: unknown) =>
    key === (typeof range === "object" ? JSON.stringify((range as { lower: unknown }).lower) : range);

  function cursorAt(rows: Array<[string, Row]>, i: number): unknown {
    if (i >= rows.length) return null;
    const [primaryKey, value] = rows[i];
    return {
      primaryKey,
      value,
      continue: async () => cursorAt(rows, i + 1),
      continuePrimaryKey: async (_key: unknown, target: string) => {
        if (target <= primaryKey) throw new DOMException("not after current position", "DataError");
        const j = rows.findIndex(([pk]) => pk >= target);
        return j === -1 ? null : cursorAt(rows, j);
      },
    };
  }
  const openIndexCursor = (store: string, index: string, range: unknown) => {
    const rows = [...stores[store as keyof typeof stores]]
      .filter(([, row]) => matches(INDEX_KEYS[index](row), range))
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return cursorAt(rows, 0);
  };
  const db = {
    transaction: (store: string) => ({
      store: { index: (index: string) => ({ openCursor: async (range: unknown) => openIndexCursor(store, index, range) }) },
      done: Promise.resolve(),
    }),
    getAllFromIndex: async (store: string, index: string, key: unknown) =>
      [...stores[store as keyof typeof stores].values()].filter((row) => matches(INDEX_KEYS[index](row), key)),
  };
  return { openDB: async () => db };
});

(globalThis as Record<string, unknown>).IDBKeyRange = { only: (lower: unknown) => ({ lower }) };
(globalThis as Record<string, unknown>).chrome = {
  storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
};

const db = await import("./db");

const id = (i: number) => `t${String(i).padStart(4, "0")}`;

function seedTabs(count: number): void {
  for (let i = 0; i < count; i++) {
    stores.remote_objects.set(id(i), {
      objectId: id(i),
      objectType: "tab",
      originDeviceId: "peer",
      payload: { url: `https://example.test/${i}` },
      deleted: 0,
      updatedAt: "",
    });
  }
}

beforeEach(() => {
  stores.remote_objects.clear();
  stores.object_mappings.clear();
  betweenChunks.hook = () => {};
});

describe("chunked live-tab walk", () => {
  it.each([0, 1, 199, 200, 201, 650])("counts each of %i pending tabs exactly once", async (count) => {
    seedTabs(count);
    const page = await db.getPendingTabRestoresPage(15);
    expect(await db.countPendingTabRestores()).toBe(count);
    expect(page.total).toBe(count);
    expect(page.items.map((item) => item.objectId)).toEqual(
      Array.from({ length: Math.min(15, count) }, (_, i) => id(i)),
    );
  });

  it("excludes deleted and already-materialized tabs", async () => {
    seedTabs(650);
    for (let i = 0; i < 650; i += 10) stores.remote_objects.get(id(i))!.deleted = 1;
    for (let i = 1; i < 650; i += 10) {
      stores.object_mappings.set(`tab:${i}`, { key: `tab:${i}`, objectType: "tab", chromiumLocalId: String(i), objectId: id(i) });
    }
    expect(await db.countPendingTabRestores()).toBe(520);
    expect(await db.countPendingTabRestores()).toBe((await db.getPendingTabRestores()).length);
  });

  it("resumes correctly when the last visited row is deleted between chunks", async () => {
    seedTabs(650);
    // Removing every row visited so far leaves the last one as the cursor's
    // first row, where continuePrimaryKey would throw.
    let removed = 0;
    betweenChunks.hook = () => {
      for (const key of [...stores.remote_objects.keys()].slice(0, 199)) {
        stores.remote_objects.delete(key);
        removed++;
      }
    };
    expect(await db.countPendingTabRestores()).toBe(650);
    expect(removed).toBeGreaterThan(0);
  });
});

describe("getMappedChromiumIdsByType", () => {
  it("returns every mapped id across chunk boundaries", async () => {
    for (let i = 0; i < 450; i++) {
      const key = `bookmark:${String(i).padStart(4, "0")}`;
      stores.object_mappings.set(key, { key, objectType: "bookmark", chromiumLocalId: String(i), objectId: `o${i}` });
    }
    const ids = await db.getMappedChromiumIdsByType("bookmark");
    expect(ids.size).toBe(450);
  });
});
