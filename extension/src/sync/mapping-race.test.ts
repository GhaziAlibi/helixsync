import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A new tab's onUpdated stages can land in two tab flushes that run at the
// same time (the micro-batch queue doesn't serialize flushes). Each looked up
// the tab, found no mapping and minted its own objectId, so the tab was sent
// twice and every other device opened it twice, the first copy never closed
// (found end to end). Runs against a real IndexedDB (fake-indexeddb), not a
// mock, since the race is a storage one.

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
        onChanged: { addListener: () => {} },
      },
    },
  });
});

describe("getOrCreateObjectId", () => {
  it("gives concurrent callers for one local id the same objectId", async () => {
    const { getOrCreateObjectId, lookupObjectId } = await import("./mapping");

    const ids = await Promise.all([1, 2, 3, 4].map(() => getOrCreateObjectId("tab", "7")));

    expect(new Set(ids).size).toBe(1);
    expect(await lookupObjectId("tab", "7")).toBe(ids[0]);
  });

  it("keeps an existing mapping and mints separate ids for separate tabs", async () => {
    const { getOrCreateObjectId } = await import("./mapping");

    const first = await getOrCreateObjectId("tab", "7");
    expect(await getOrCreateObjectId("tab", "7")).toBe(first);
    expect(await getOrCreateObjectId("tab", "8")).not.toBe(first);
    expect(await getOrCreateObjectId("window", "7")).not.toBe(first);
  });
});
