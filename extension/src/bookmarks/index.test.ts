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
const commitBookmarkBackfillBatchMock = vi.fn();
const getFieldStatesForObjectsMock = vi.fn();
const getMappedChromiumIdsByTypeMock = vi.fn();
const getMappingsByLocalIdsMock = vi.fn(async (_type: any, _ids: any) => new Map<string, any>());

vi.mock("../storage/db", () => ({
  commitBookmarkBackfillBatch: (...args: unknown[]) => commitBookmarkBackfillBatchMock(...args),
  deleteDeferredMaterialization: vi.fn(),
  deleteDeferredMaterializationsBatch: vi.fn(),
  getDeferredMaterializationsWaitingOn: vi.fn(),
  getFieldState: (objectId: string, field: string) => getFieldStateMock(objectId, field),
  getFieldStatesForObjects: (...args: unknown[]) => getFieldStatesForObjectsMock(...args),
  getMappedChromiumIdsByType: (...args: unknown[]) => getMappedChromiumIdsByTypeMock(...args),
  getMappingsByLocalIds: (type: any, ids: any) => getMappingsByLocalIdsMock(type, ids),
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

const createLocalOperationsBatchMock = vi.fn(
  async (items: PendingLocalOperation[], _options?: { enqueue?: boolean }) => {
    return items.map((_item, idx) => ({
      operation: {
        operationId: `op-${idx}`,
        lamportTimestamp: idx + 1,
      },
      deviceId: "device-1",
    }));
  },
);
const scheduleLocalSyncMock = vi.fn();

vi.mock("../sync/engine", () => ({
  createLocalOperationsBatch: (items: PendingLocalOperation[], options?: { enqueue?: boolean }) =>
    createLocalOperationsBatchMock(items, options),
  registerApplier: vi.fn(),
  registerBatchApplier: vi.fn(),
  scheduleLocalSync: () => scheduleLocalSyncMock(),
}));

const { positionOf, computePosition, flushBookmarkEvents, backfillExisting } = await import("./index");

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

    it("pre-fetches known mapping IDs in a single batch read (EXT-04)", async () => {
      getMappingsByLocalIdsMock.mockClear();
      getOrCreateObjectIdMock.mockClear();

      const fakeMappings = new Map([
        ["bm-10", { key: "bookmark:bm-10", objectType: "bookmark" as const, chromiumLocalId: "bm-10", objectId: "obj-bm-10" }],
      ]);
      getMappingsByLocalIdsMock.mockResolvedValueOnce(fakeMappings);
      getMock.mockResolvedValueOnce([{ id: "bm-10", title: "Updated title", url: "https://helixsync.test" }]);

      await flushBookmarkEvents([
        {
          kind: "changed",
          id: "bm-10",
          changeInfo: { title: "Updated title" },
        },
      ]);

      // Verified: getMappingsByLocalIds was called in a single batch read
      expect(getMappingsByLocalIdsMock).toHaveBeenCalledTimes(1);
      expect(getMappingsByLocalIdsMock).toHaveBeenCalledWith("bookmark", expect.arrayContaining(["bm-10"]));
      // And getOrCreateObjectId was bypassed because the mapping was in the batch pre-fetch
      expect(getOrCreateObjectIdMock).not.toHaveBeenCalledWith("bookmark", "bm-10");
    });
  });
});

describe("EXT-05: Non-Atomic Mapping vs. Operation Creation in backfillExisting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("atomically commits mappings, operations, and field states in a single batch on clean run", async () => {
    const tree: chrome.bookmarks.BookmarkTreeNode[] = [
      {
        id: "0",
        title: "Root",
        children: [
          {
            id: "1",
            title: "Bookmarks Bar",
            children: [
              {
                id: "folder-1",
                title: "Folder 1",
                children: [
                  { id: "bm-1", title: "Bookmark 1", url: "https://example.com/1" },
                ],
              },
              {
                id: "bm-2",
                title: "Bookmark 2",
                url: "https://example.com/2",
              },
            ],
          },
        ],
      },
    ];

    getTreeMock.mockResolvedValue(tree);
    getMappedChromiumIdsByTypeMock.mockResolvedValue(new Set());
    getMappingsByLocalIdsMock.mockResolvedValue(new Map());
    getFieldStatesForObjectsMock.mockResolvedValue(new Map());

    await backfillExisting();

    // Verify operations were prepared with { enqueue: false } so they aren't committed before mappings
    expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
    expect(createLocalOperationsBatchMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ objectType: "bookmarkFolder" }),
        expect.objectContaining({ objectType: "bookmark" }),
      ]),
      { enqueue: false },
    );

    // Verify atomic multi-store commit was invoked
    expect(commitBookmarkBackfillBatchMock).toHaveBeenCalledTimes(1);
    const batch = commitBookmarkBackfillBatchMock.mock.calls[0][0];

    // Mappings for the 3 new nodes: folder-1, bm-1, bm-2
    expect(batch.mappings).toHaveLength(3);
    const mappingIds = batch.mappings.map((m: { chromiumLocalId: string }) => m.chromiumLocalId);
    expect(mappingIds).toEqual(["folder-1", "bm-1", "bm-2"]);

    // Operations for the 3 new nodes
    expect(batch.operations).toHaveLength(3);

    // Field states: 4 per node (title, url, move, liveness) = 12 total
    expect(batch.fieldStates).toHaveLength(12);

    // Verify child references parent objectId
    const folderMapping = batch.mappings.find((m: { chromiumLocalId: string }) => m.chromiumLocalId === "folder-1");
    const childOp = batch.operations.find((_op: unknown, idx: number) => batch.mappings[idx].chromiumLocalId === "bm-1");
    expect(childOp).toBeDefined();
    expect(folderMapping).toBeDefined();
  });

  it("survives mid-backfill crash and resumes without re-creating already-committed operations", async () => {
    // 501 items so it spans across the 500-item chunk boundary:
    // Chunk 1 has 500 items, Chunk 2 has 1 item
    const bookmarks: chrome.bookmarks.BookmarkTreeNode[] = Array.from({ length: 501 }, (_, i) => ({
      id: `bm-${i}`,
      title: `Bookmark ${i}`,
      url: `https://example.com/${i}`,
    }));

    const tree: chrome.bookmarks.BookmarkTreeNode[] = [
      {
        id: "0",
        title: "Root",
        children: [
          {
            id: "1",
            title: "Bookmarks Bar",
            children: bookmarks,
          },
        ],
      },
    ];

    getTreeMock.mockResolvedValue(tree);
    getMappedChromiumIdsByTypeMock.mockResolvedValue(new Set());
    getMappingsByLocalIdsMock.mockResolvedValue(new Map());
    getFieldStatesForObjectsMock.mockResolvedValue(new Map());

    // First call: chunk 1 commits successfully, chunk 2 fails with simulated crash
    let chunkCount = 0;
    const committedMappings = new Map<string, { objectId: string }>();
    const committedFieldStates = new Map<string, { value: unknown }>();

    commitBookmarkBackfillBatchMock.mockImplementation(async (batch) => {
      chunkCount++;
      if (chunkCount === 1) {
        // Record committed records for chunk 1
        for (const m of batch.mappings) {
          committedMappings.set(m.chromiumLocalId, { objectId: m.objectId });
        }
        for (const fs of batch.fieldStates) {
          if (fs.field === "move") {
            committedFieldStates.set(fs.objectId, { value: fs.value });
          }
        }
        return;
      }
      // Chunk 2 simulates service worker termination
      throw new Error("simulated service worker termination");
    });

    await expect(backfillExisting()).rejects.toThrow("simulated service worker termination");

    // Chunk 1 committed 500 items
    expect(committedMappings.size).toBe(500);

    // Reset mocks for service worker restart
    commitBookmarkBackfillBatchMock.mockReset();
    commitBookmarkBackfillBatchMock.mockImplementation(async () => {});
    createLocalOperationsBatchMock.mockClear();

    // On restart: DB has chunk 1's 500 items
    getMappedChromiumIdsByTypeMock.mockResolvedValue(new Set(committedMappings.keys()));
    getMappingsByLocalIdsMock.mockImplementation(async (_type: string, ids: string[]) => {
      const res = new Map();
      for (const id of ids) {
        if (committedMappings.has(id)) res.set(id, committedMappings.get(id));
      }
      return res;
    });
    getFieldStatesForObjectsMock.mockImplementation(async (objectIds: string[]) => {
      const res = new Map();
      for (const oid of objectIds) {
        if (committedFieldStates.has(oid)) res.set(oid, committedFieldStates.get(oid));
      }
      return res;
    });

    // Run backfillExisting on restart
    await backfillExisting();

    // Chunk 2 only has 1 item remaining — must be committed in exactly 1 call
    expect(commitBookmarkBackfillBatchMock).toHaveBeenCalledTimes(1);
    const resumedBatch = commitBookmarkBackfillBatchMock.mock.calls[0][0];

    // Only the remaining 1 item is processed; chunk 1's 500 items were NOT re-created
    expect(resumedBatch.mappings).toHaveLength(1);
    expect(resumedBatch.mappings[0].chromiumLocalId).toBe("bm-500");
    expect(resumedBatch.operations).toHaveLength(1);
  });

  it("heals orphaned mappings lacking field states left by past non-atomic crash", async () => {
    // Older buggy version wrote object_mappings but crashed before operations/field_state
    const tree: chrome.bookmarks.BookmarkTreeNode[] = [
      {
        id: "0",
        title: "Root",
        children: [
          {
            id: "1",
            title: "Bookmarks Bar",
            children: [
              { id: "bm-orphan", title: "Orphaned Bookmark", url: "https://example.com/orphan" },
            ],
          },
        ],
      },
    ];

    getTreeMock.mockResolvedValue(tree);
    // Mappings table has the orphan
    getMappedChromiumIdsByTypeMock.mockResolvedValue(new Set(["bm-orphan"]));
    getMappingsByLocalIdsMock.mockResolvedValue(
      new Map([["bm-orphan", { objectId: "old-orphaned-obj-id" }]]),
    );
    // But field_state has NO move state for the orphan (since it was never committed)
    getFieldStatesForObjectsMock.mockResolvedValue(new Map());

    await backfillExisting();

    // Node was NOT skipped! It was healed and committed atomically
    expect(commitBookmarkBackfillBatchMock).toHaveBeenCalledTimes(1);
    const batch = commitBookmarkBackfillBatchMock.mock.calls[0][0];
    expect(batch.mappings).toHaveLength(1);
    expect(batch.mappings[0].chromiumLocalId).toBe("bm-orphan");
    expect(batch.operations).toHaveLength(1);
    expect(batch.fieldStates).toHaveLength(4);
  });
});
