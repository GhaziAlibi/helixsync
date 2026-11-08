import { describe, expect, it, vi } from "vitest";
import { createSuppressionGuard } from "../src/sync/suppress";

// The shared root code, run with Firefox's platform.
vi.mock("@platform", () => import("./platform"));

const getChildrenMock = vi.fn<(parentId: string) => Promise<Array<{ id: string }>>>();
const createMock = vi.fn();

(globalThis as unknown as { chrome: unknown }).chrome = {
  bookmarks: {
    getChildren: (parentId: string) => getChildrenMock(parentId),
    get: async (id: string) => [{ id }],
    create: (...args: unknown[]) => createMock(...args),
  },
  storage: { local: { get: async () => ({}), set: async () => {} } },
};

const { ROOT_OBJECT_IDS, bookmarkRoots, ensureStandInRoot, isNativeRootId } = await import("../src/bookmarks/roots");

describe("Firefox bookmark roots", () => {
  it("maps every built-in root, Bookmarks menu included, and creates nothing", async () => {
    const guard = createSuppressionGuard();
    getChildrenMock.mockImplementation(async (parentId) =>
      parentId === "root________"
        ? [{ id: "menu________" }, { id: "toolbar_____" }, { id: "unfiled_____" }, { id: "mobile______" }]
        : [],
    );

    const roots = await bookmarkRoots(guard);

    expect(createMock).not.toHaveBeenCalled();
    expect(roots.standInIds.size).toBe(0);
    const expected: Record<string, string> = {
      root________: ROOT_OBJECT_IDS["0"],
      toolbar_____: ROOT_OBJECT_IDS["1"],
      unfiled_____: ROOT_OBJECT_IDS["2"],
      mobile______: ROOT_OBJECT_IDS["3"],
      menu________: ROOT_OBJECT_IDS["4"],
    };
    for (const [firefoxId, objectId] of Object.entries(expected)) {
      expect(roots.objectIdByChromiumId.get(firefoxId)).toBe(objectId);
      expect(roots.chromiumIdByObjectId.get(objectId)).toBe(firefoxId);
      expect(isNativeRootId(firefoxId)).toBe(true);
    }
    expect(isNativeRootId("1")).toBe(false);
    // Already there, so nothing to make.
    expect((await ensureStandInRoot(guard, ROOT_OBJECT_IDS["4"])).chromiumIdByObjectId.get(ROOT_OBJECT_IDS["4"])).toBe(
      "menu________",
    );
    expect(createMock).not.toHaveBeenCalled();
  });
});
