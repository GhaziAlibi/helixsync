import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSuppressionGuard } from "../sync/suppress";

const getChildrenMock = vi.fn<(parentId: string) => Promise<Array<{ id: string }>>>();
const getMock = vi.fn<(id: string) => Promise<Array<{ id: string }>>>();
const createMock = vi.fn();
const moveMock = vi.fn();
const removeMock = vi.fn();
let stored: Record<string, unknown> = {};

(globalThis as unknown as { chrome: unknown }).chrome = {
  bookmarks: {
    getChildren: (parentId: string) => getChildrenMock(parentId),
    get: (id: string) => getMock(id),
    create: (...args: unknown[]) => createMock(...args),
    move: (...args: unknown[]) => moveMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
  },
  storage: {
    local: {
      get: async (key: string) => (key in stored ? { [key]: stored[key] } : {}),
      set: async (items: Record<string, unknown>) => {
        stored = { ...stored, ...items };
      },
    },
  },
};

const { ROOT_OBJECT_IDS, bookmarkRoots, invalidateBookmarkRoots, standInRootObjectId } = await import("./roots");

const guard = createSuppressionGuard();

describe("bookmarkRoots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored = {};
    invalidateBookmarkRoots();
  });

  it("uses the built-in roots and creates nothing on desktop", async () => {
    getChildrenMock.mockResolvedValue([{ id: "1" }, { id: "2" }, { id: "3" }]);

    const roots = await bookmarkRoots(guard);

    expect(createMock).not.toHaveBeenCalled();
    expect(roots.standInIds.size).toBe(0);
    for (const [chromiumId, objectId] of Object.entries(ROOT_OBJECT_IDS)) {
      expect(roots.objectIdByChromiumId.get(chromiumId)).toBe(objectId);
      expect(roots.chromiumIdByObjectId.get(objectId)).toBe(chromiumId);
    }
  });

  it("creates suppressed stand-ins at the top of Mobile bookmarks when the bar and Other are missing", async () => {
    getChildrenMock.mockImplementation(async (parentId) => (parentId === "0" ? [{ id: "3" }] : [{ id: "50" }]));
    let nextId = 100;
    const suppressedAtCreate: boolean[] = [];
    createMock.mockImplementation(async () => {
      suppressedAtCreate.push(guard.isSuppressed());
      return { id: String(nextId++) };
    });

    const roots = await bookmarkRoots(guard);

    expect(createMock).toHaveBeenNthCalledWith(1, { parentId: "3", title: "Bookmarks bar", index: 0 });
    expect(createMock).toHaveBeenNthCalledWith(2, { parentId: "3", title: "Other bookmarks", index: 1 });
    expect(suppressedAtCreate).toEqual([true, true]);
    expect(roots.objectIdByChromiumId.get("100")).toBe(ROOT_OBJECT_IDS["1"]);
    expect(roots.objectIdByChromiumId.get("101")).toBe(ROOT_OBJECT_IDS["2"]);
    expect(roots.objectIdByChromiumId.has("1")).toBe(false);
    expect(roots.chromiumIdByObjectId.get(ROOT_OBJECT_IDS["1"])).toBe("100");
    expect(roots.chromiumIdByObjectId.get(ROOT_OBJECT_IDS["3"])).toBe("3");
    expect([...roots.standInIds]).toEqual(["100", "101"]);
    expect(await standInRootObjectId("100")).toBe(ROOT_OBJECT_IDS["1"]);
    expect(await standInRootObjectId("50")).toBeUndefined();
  });

  it("reuses stored stand-ins on a later worker and recreates only a missing one", async () => {
    stored = { bookmarkRootStandIns: { "1": "100", "2": "101" } };
    getChildrenMock.mockImplementation(async (parentId) => (parentId === "0" ? [{ id: "3" }] : [{ id: "100" }]));
    getMock.mockImplementation(async (id) => {
      if (id === "100") return [{ id }];
      throw new Error("Can't find bookmark for id.");
    });
    createMock.mockResolvedValue({ id: "102" });

    const roots = await bookmarkRoots(guard);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({ parentId: "3", title: "Other bookmarks", index: 1 });
    expect(roots.chromiumIdByObjectId.get(ROOT_OBJECT_IDS["1"])).toBe("100");
    expect(roots.chromiumIdByObjectId.get(ROOT_OBJECT_IDS["2"])).toBe("102");
    expect(stored.bookmarkRootStandIns).toEqual({ "1": "100", "2": "102" });
  });

  it("puts a Mobile bookmarks stand-in at the top of Other bookmarks when desktop hides an empty one", async () => {
    getChildrenMock.mockImplementation(async (parentId) => (parentId === "0" ? [{ id: "1" }, { id: "2" }] : []));
    createMock.mockResolvedValue({ id: "200" });

    const roots = await bookmarkRoots(guard);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({ parentId: "2", title: "Mobile bookmarks", index: 0 });
    expect(roots.chromiumIdByObjectId.get(ROOT_OBJECT_IDS["3"])).toBe("200");
    expect(roots.chromiumIdByObjectId.get(ROOT_OBJECT_IDS["2"])).toBe("2");
    expect([...roots.standInIds]).toEqual(["200"]);
  });

  it("moves a stand-in's contents into its root once the root is shown again", async () => {
    stored = { bookmarkRootStandIns: { "3": "200" } };
    getChildrenMock.mockImplementation(async (parentId) => {
      if (parentId === "0") return [{ id: "1" }, { id: "2" }, { id: "3" }];
      if (parentId === "200") return [{ id: "201" }, { id: "202" }];
      return [];
    });
    getMock.mockImplementation(async (id) => [{ id }]);
    const suppressed: boolean[] = [];
    moveMock.mockImplementation(async () => suppressed.push(guard.isSuppressed()));
    removeMock.mockImplementation(async () => suppressed.push(guard.isSuppressed()));

    const roots = await bookmarkRoots(guard);

    expect(moveMock).toHaveBeenNthCalledWith(1, "201", { parentId: "3" });
    expect(moveMock).toHaveBeenNthCalledWith(2, "202", { parentId: "3" });
    expect(removeMock).toHaveBeenCalledWith("200");
    expect(suppressed).toEqual([true, true, true]);
    expect(createMock).not.toHaveBeenCalled();
    expect(roots.chromiumIdByObjectId.get(ROOT_OBJECT_IDS["3"])).toBe("3");
    expect(roots.standInIds.size).toBe(0);
    expect(stored.bookmarkRootStandIns).toEqual({});
  });

  it("never runs two resolves at once, so a stand-in isn't created twice", async () => {
    getChildrenMock.mockImplementation(async (parentId) => (parentId === "0" ? [{ id: "3" }] : []));
    let nextId = 300;
    createMock.mockImplementation(async () => ({ id: String(nextId++) }));
    getMock.mockImplementation(async (id) => [{ id }]);

    const first = bookmarkRoots(guard);
    invalidateBookmarkRoots();
    const second = bookmarkRoots(guard);
    await Promise.all([first, second]);

    expect(createMock).toHaveBeenCalledTimes(2);
    expect((await second).chromiumIdByObjectId.get(ROOT_OBJECT_IDS["1"])).toBe("300");
  });

  it("resolves once per worker until invalidated", async () => {
    getChildrenMock.mockResolvedValue([{ id: "1" }, { id: "2" }, { id: "3" }]);

    await bookmarkRoots(guard);
    await bookmarkRoots(guard);
    expect(getChildrenMock).toHaveBeenCalledTimes(1);

    invalidateBookmarkRoots();
    await bookmarkRoots(guard);
    expect(getChildrenMock).toHaveBeenCalledTimes(2);
  });
});
