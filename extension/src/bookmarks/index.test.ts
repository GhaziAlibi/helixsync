import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingLocalOperation } from "../sync/engine";

const getChildrenMock = vi.fn<(parentId: string) => Promise<chrome.bookmarks.BookmarkTreeNode[]>>();
const getMock = vi.fn<(id: string) => Promise<chrome.bookmarks.BookmarkTreeNode[]>>();
const createMock = vi.fn();
const updateMock = vi.fn();
const moveMock = vi.fn();
const removeTreeMock = vi.fn();
const getTreeMock = vi.fn();

(globalThis as unknown as { chrome: unknown }).chrome = {
  bookmarks: {
    getChildren: (parentId: string) => getChildrenMock(parentId),
    get: (id: string) => getMock(id),
    create: createMock,
    update: updateMock,
    move: moveMock,
    removeTree: removeTreeMock,
    getTree: getTreeMock,
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() },
  },
};

const getFieldStateMock = vi.fn<(objectId: string, field: string) => Promise<{ value: unknown } | undefined>>();

vi.mock("../storage/db", () => ({
  deleteDeferredMaterialization: vi.fn(),
  deleteDeferredMaterializationsBatch: vi.fn(),
  getDeferredMaterializationsWaitingOn: vi.fn(),
  getFieldState: (objectId: string, field: string) => getFieldStateMock(objectId, field),
  getFieldStatesForObjects: vi.fn(),
  getMappedChromiumIdsByType: vi.fn(),
  getMappingsByLocalIds: vi.fn(),
  getMappingsByObjectIds: vi.fn(),
  mappingKey: (type: string, id: string) => `${type}:${id}`,
  putDeferredMaterialization: vi.fn(),
  putMappingsBatch: vi.fn(),
  recordConflict: vi.fn(),
}));

const getOrCreateObjectIdMock = vi.fn(async (_type: string, localId: string) => `obj-${localId}`);
const lookupObjectIdMock = vi.fn(async (_type: string, localId: string) => `obj-${localId}`);
const lookupChromiumLocalIdMock = vi.fn();
const establishMappingMock = vi.fn();
const forgetMappingMock = vi.fn();

vi.mock("../sync/mapping", () => ({
  establishMapping: (...args: unknown[]) => establishMappingMock(...args),
  forgetMapping: (...args: unknown[]) => forgetMappingMock(...args),
  getOrCreateObjectId: (type: string, id: string) => getOrCreateObjectIdMock(type, id),
  lookupChromiumLocalId: (id: string) => lookupChromiumLocalIdMock(id),
  lookupObjectId: (type: string, id: string) => lookupObjectIdMock(type, id),
}));

const recordLocalFieldStatesBatchMock = vi.fn();

vi.mock("../sync/conflict", () => ({
  recordLocalFieldStatesBatch: (...args: unknown[]) => recordLocalFieldStatesBatchMock(...args),
  resolveField: vi.fn(),
  resolveFields: vi.fn(),
}));

const createLocalOperationsBatchMock = vi.fn(async (items: PendingLocalOperation[]) => {
  return items.map((_item, idx) => ({
    operation: {
      operationId: `op-${idx}`,
      lamportTimestamp: idx + 1,
    },
    deviceId: "device-1",
  }));
});
const scheduleLocalSyncMock = vi.fn();

vi.mock("../sync/engine", () => ({
  createLocalOperationsBatch: (items: PendingLocalOperation[]) => createLocalOperationsBatchMock(items),
  registerApplier: vi.fn(),
  registerBatchApplier: vi.fn(),
  scheduleLocalSync: () => scheduleLocalSyncMock(),
}));

const { positionOf, computePosition, flushBookmarkEvents } = await import("./index");

describe("EXT-03: Sibling IPC and Transaction Amplification in bookmarks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("positionOf", () => {
    it("queries getFieldState when overlay is not provided", async () => {
      getFieldStateMock.mockResolvedValueOnce({
        value: { parent: "parent-1", position: "0|a00000:" },
      });

      const pos = await positionOf("obj-1");
      expect(pos).toBe("0|a00000:");
      expect(getFieldStateMock).toHaveBeenCalledWith("obj-1", "move");
    });

    it("retrieves position from overlay when available without querying getFieldState", async () => {
      const overlay = new Map<string, unknown>();
      overlay.set("obj-1:move", { parent: "parent-1", position: "0|overlay-pos:" });

      const pos = await positionOf("obj-1", overlay);
      expect(pos).toBe("0|overlay-pos:");
      expect(getFieldStateMock).not.toHaveBeenCalled();
    });

    it("falls back to getFieldState when overlay does not contain the entry", async () => {
      const overlay = new Map<string, unknown>();
      getFieldStateMock.mockResolvedValueOnce({
        value: { parent: "parent-1", position: "0|fallback-pos:" },
      });

      const pos = await positionOf("obj-1", overlay);
      expect(pos).toBe("0|fallback-pos:");
      expect(getFieldStateMock).toHaveBeenCalledWith("obj-1", "move");
    });

    it("falls back to getFieldState when overlay contains move entry without position property", async () => {
      const overlay = new Map<string, unknown>();
      overlay.set("obj-1:move", { parent: "parent-1" });
      getFieldStateMock.mockResolvedValueOnce({
        value: { parent: "parent-1", position: "0|db-pos:" },
      });

      const pos = await positionOf("obj-1", overlay);
      expect(pos).toBe("0|db-pos:");
      expect(getFieldStateMock).toHaveBeenCalledWith("obj-1", "move");
    });
  });

  describe("computePosition", () => {
    it("caches and reuses chrome.bookmarks.getChildren when siblingCache is provided", async () => {
      const mockChildren: chrome.bookmarks.BookmarkTreeNode[] = [
        { id: "bm-1", title: "One", parentId: "folder-1" },
        { id: "bm-2", title: "Two", parentId: "folder-1" },
      ];
      getChildrenMock.mockResolvedValue(mockChildren);
      getFieldStateMock.mockResolvedValue(undefined);

      const siblingCache = new Map<string, chrome.bookmarks.BookmarkTreeNode[]>();

      // First call: fetches and sets cache
      await computePosition("folder-1", 0, undefined, siblingCache);
      expect(getChildrenMock).toHaveBeenCalledTimes(1);
      expect(siblingCache.has("folder-1")).toBe(true);

      // Second call: reuses cache, no additional getChildren IPC
      await computePosition("folder-1", 1, undefined, siblingCache);
      expect(getChildrenMock).toHaveBeenCalledTimes(1);
    });

    it("calls chrome.bookmarks.getChildren on each invocation when siblingCache is omitted", async () => {
      getChildrenMock.mockResolvedValue([]);

      await computePosition("folder-1", 0);
      await computePosition("folder-1", 1);
      expect(getChildrenMock).toHaveBeenCalledTimes(2);
    });

    it("passes overlay when resolving positions for beforeId and afterId", async () => {
      const mockChildren: chrome.bookmarks.BookmarkTreeNode[] = [
        { id: "bm-0", title: "First", parentId: "folder-1" },
        { id: "bm-1", title: "Middle", parentId: "folder-1" },
        { id: "bm-2", title: "Last", parentId: "folder-1" },
      ];
      getChildrenMock.mockResolvedValue(mockChildren);

      const overlay = new Map<string, unknown>();
      overlay.set("obj-bm-0:move", { parent: "obj-folder-1", position: "a0" });
      overlay.set("obj-bm-2:move", { parent: "obj-folder-1", position: "a2" });

      const siblingCache = new Map<string, chrome.bookmarks.BookmarkTreeNode[]>();

      // Compute position for index 1 (between bm-0 at a0 and bm-2 at a2)
      const pos = await computePosition("folder-1", 1, overlay, siblingCache);

      // Verify overlay was used without hitting getFieldState
      expect(getFieldStateMock).not.toHaveBeenCalled();
      expect(pos > "a0" && pos < "a2").toBe(true);
    });
  });

  describe("flushBookmarkEvents", () => {
    it("reuses siblingCache across multiple events for the same parent folder", async () => {
      const mockChildren: chrome.bookmarks.BookmarkTreeNode[] = [
        { id: "bm-10", title: "Item 10", parentId: "folder-shared", index: 0 },
        { id: "bm-11", title: "Item 11", parentId: "folder-shared", index: 1 },
      ];
      getChildrenMock.mockResolvedValue(mockChildren);
      getMock.mockImplementation(async (id) => [{ id, title: "Moved", parentId: "folder-shared" }]);
      getFieldStateMock.mockResolvedValue(undefined);

      await flushBookmarkEvents([
        {
          kind: "created",
          id: "bm-10",
          node: { id: "bm-10", title: "Item 10", parentId: "folder-shared", index: 0 },
        },
        {
          kind: "created",
          id: "bm-11",
          node: { id: "bm-11", title: "Item 11", parentId: "folder-shared", index: 1 },
        },
        {
          kind: "moved",
          id: "bm-10",
          moveInfo: { parentId: "folder-shared", index: 0, oldParentId: "folder-other", oldIndex: 0 },
        },
      ]);

      // All 3 events target folder-shared, so getChildren should only have been called once
      expect(getChildrenMock).toHaveBeenCalledTimes(1);
      expect(getChildrenMock).toHaveBeenCalledWith("folder-shared");
    });

    it("ensures second event in batch sees first event's position via overlay", async () => {
      const mockChildren: chrome.bookmarks.BookmarkTreeNode[] = [
        { id: "bm-1", title: "Item 1", parentId: "folder-seq", index: 0 },
        { id: "bm-2", title: "Item 2", parentId: "folder-seq", index: 1 },
      ];
      getChildrenMock.mockResolvedValue(mockChildren);
      getFieldStateMock.mockResolvedValue(undefined);

      let stagedOps: PendingLocalOperation[] = [];
      createLocalOperationsBatchMock.mockImplementationOnce(async (items) => {
        stagedOps = items;
        return items.map((_item, idx) => ({
          operation: { operationId: `op-${idx}`, lamportTimestamp: idx + 1 },
          deviceId: "device-1",
        }));
      });

      await flushBookmarkEvents([
        {
          kind: "created",
          id: "bm-1",
          node: { id: "bm-1", title: "Item 1", parentId: "folder-seq", index: 0 },
        },
        {
          kind: "created",
          id: "bm-2",
          node: { id: "bm-2", title: "Item 2", parentId: "folder-seq", index: 1 },
        },
      ]);

      expect(stagedOps).toHaveLength(2);
      const pos1 = (stagedOps[0].payload as { position: string }).position;
      const pos2 = (stagedOps[1].payload as { position: string }).position;

      // pos1 should be < pos2 because bm-2 was at index 1 and bm-1 was at index 0
      expect(pos1 < pos2).toBe(true);
    });
  });
});
