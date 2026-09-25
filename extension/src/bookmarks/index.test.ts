import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingLocalOperation } from "../sync/engine";

const getChildrenMock = vi.fn<(parentId: string) => Promise<chrome.bookmarks.BookmarkTreeNode[]>>();
const getMock = vi.fn<(id: string) => Promise<chrome.bookmarks.BookmarkTreeNode[]>>();
const createMock = vi.fn();
const updateMock = vi.fn();
const moveMock = vi.fn();
const removeTreeMock = vi.fn();
const getTreeMock = vi.fn();
const getDeviceMock = vi.fn(async () => ({ deviceId: "device-1" }));

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
  deleteMappingsBatch: vi.fn(),
  getDeferredMaterializationsWaitingOn: vi.fn(),
  getDevice: () => getDeviceMock(),
  getFieldState: (objectId: string, field: string) => getFieldStateMock(objectId, field),
  getFieldStatesForObjects: (...args: unknown[]) => getFieldStatesForObjectsMock(...args),
  getMappedChromiumIdsByType: (...args: unknown[]) => getMappedChromiumIdsByTypeMock(...args),
  getMappingsByLocalIds: (type: any, ids: any) => getMappingsByLocalIdsMock(type, ids),
  getMappingsByObjectIds: vi.fn(async () => new Map()),
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

let syncBookmarks: boolean | undefined = undefined;

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(async () => ({ syncBookmarks })),
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

const { positionOf, computePosition, flushBookmarkEvents, backfillExisting, sortedInsertIndex } = await import("./index");

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

    it("treats an overlay move entry as authoritative without re-reading getFieldState", async () => {
      const overlay = new Map<string, unknown>();
      overlay.set("obj-1:move", { parent: "parent-1" });

      // Nothing commits field_state mid-flush, so a second read could only
      // ever return the same row the overlay already holds — skip it.
      const pos = await positionOf("obj-1", overlay);
      expect(pos).toBeUndefined();
      expect(getFieldStateMock).not.toHaveBeenCalled();
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

    it("scopes overlay prefetch to move for a move-only burst (no title/url rows)", async () => {
      // Measured pre-fix: a 20-move burst fetched 21 title + 21 url rows it
      // never read. Moves only ever read `move` (own + siblings).
      getChildrenMock.mockResolvedValue([
        { id: "bm-1", title: "Item 1", parentId: "folder-1", index: 0 },
        { id: "bm-2", title: "Item 2", parentId: "folder-1", index: 1 },
      ]);
      getMock.mockImplementation(async (id) => [{ id, title: "Moved", parentId: "folder-1" }]);
      getFieldStatesForObjectsMock.mockResolvedValue(new Map());
      getFieldStateMock.mockResolvedValue(undefined);
      // Phase-1 mapping prefetch must return entries, or mappingCache stays
      // empty and the overlay-seeding phase is skipped entirely.
      const ids = ["bm-1", "bm-2", "folder-1"];
      getMappingsByLocalIdsMock.mockResolvedValueOnce(new Map(ids.map((id) => [id, { objectId: `obj-${id}` }])));

      await flushBookmarkEvents([
        { kind: "moved", id: "bm-1", moveInfo: { parentId: "folder-1", index: 0, oldParentId: "folder-0", oldIndex: 0 } },
        { kind: "moved", id: "bm-2", moveInfo: { parentId: "folder-1", index: 1, oldParentId: "folder-0", oldIndex: 1 } },
      ]);

      const fields = getFieldStatesForObjectsMock.mock.calls.map((c) => (c as unknown[])[1]);
      expect(fields).toEqual(["move"]);
    });

    it("scopes overlay prefetch to title/url for a changed-only burst (no move rows)", async () => {
      getMock.mockImplementation(async (id) => [{ id, title: "New", parentId: "folder-1", url: "https://x.test/" }]);
      getFieldStatesForObjectsMock.mockResolvedValue(new Map());
      getFieldStateMock.mockResolvedValue(undefined);
      getMappingsByLocalIdsMock.mockResolvedValueOnce(
        new Map(["bm-1", "bm-2"].map((id) => [id, { objectId: `obj-${id}` }])),
      );

      await flushBookmarkEvents([
        { kind: "changed", id: "bm-1", changeInfo: { title: "New" } },
        { kind: "changed", id: "bm-2", changeInfo: { title: "New2" } },
      ]);

      const fields = (getFieldStatesForObjectsMock.mock.calls.map((c) => (c as unknown[])[1]) as string[]).sort();
      expect(fields).toEqual(["title", "url"]);
    });

    it("still stages moves correctly when title/url prefetch is skipped (live-read fallback)", async () => {
      // Scoping must never change results: unseeded fields fall back to the
      // same per-event live read the staging loop always had.
      getChildrenMock.mockResolvedValue([
        { id: "bm-1", title: "Item 1", parentId: "folder-1", index: 0 },
        { id: "bm-2", title: "Item 2", parentId: "folder-1", index: 1 },
      ]);
      getMock.mockImplementation(async (id) => [{ id, title: "Moved", parentId: "folder-1" }]);
      getFieldStatesForObjectsMock.mockResolvedValue(new Map());
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
        { kind: "moved", id: "bm-1", moveInfo: { parentId: "folder-1", index: 1, oldParentId: "folder-0", oldIndex: 0 } },
      ]);

      expect(stagedOps).toHaveLength(1);
      expect(stagedOps[0].operationType).toBe("move");
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

    it("resolves bulk-created sibling positions with no IndexedDB fallback reads", async () => {
      // All-new folder: nothing is mapped, so every sibling objectId is
      // minted mid-flush. Minting seeds the overlay, so neighbor position
      // lookups must hit it instead of paying a getFieldState miss each.
      lookupObjectIdMock.mockImplementation(async () => undefined as unknown as string);
      getFieldStateMock.mockClear();
      getChildrenMock.mockResolvedValue([
        { id: "bm-1", title: "Item 1", parentId: "folder-new", index: 0 },
        { id: "bm-2", title: "Item 2", parentId: "folder-new", index: 1 },
        { id: "bm-3", title: "Item 3", parentId: "folder-new", index: 2 },
      ]);
      let stagedOps: PendingLocalOperation[] = [];
      createLocalOperationsBatchMock.mockImplementationOnce(async (items) => {
        stagedOps = items;
        return items.map((_item, idx) => ({
          operation: { operationId: `op-${idx}`, lamportTimestamp: idx + 1 },
          deviceId: "device-1",
        }));
      });
      try {
        await flushBookmarkEvents([
          { kind: "created", id: "bm-1", node: { id: "bm-1", title: "Item 1", parentId: "folder-new", index: 0 } },
          { kind: "created", id: "bm-2", node: { id: "bm-2", title: "Item 2", parentId: "folder-new", index: 1 } },
          { kind: "created", id: "bm-3", node: { id: "bm-3", title: "Item 3", parentId: "folder-new", index: 2 } },
        ]);
      } finally {
        lookupObjectIdMock.mockImplementation(async (_type: string, localId: string) => `obj-${localId}`);
      }

      expect(stagedOps).toHaveLength(3);
      const positions = stagedOps.map((op) => (op.payload as { position: string }).position);
      expect([...positions].sort()).toEqual(positions); // order preserved, no DB fallback needed
      expect(getFieldStateMock).not.toHaveBeenCalled();
    });

    it("pre-fetches known mapping IDs in a single batch read (EXT-04)", async () => {
      getMappingsByLocalIdsMock.mockClear();
      getOrCreateObjectIdMock.mockClear();

      const fakeMappings = new Map([
        ["bm-10", { key: "bookmark:bm-10", objectType: "bookmark" as const, chromiumLocalId: "bm-10", objectId: "obj-bm-10" }],
        ["bm-11", { key: "bookmark:bm-11", objectType: "bookmark" as const, chromiumLocalId: "bm-11", objectId: "obj-bm-11" }],
      ]);
      getMappingsByLocalIdsMock.mockResolvedValueOnce(fakeMappings);
      getMock
        .mockResolvedValueOnce([{ id: "bm-10", title: "Updated title", url: "https://helixsync.test" }])
        .mockResolvedValueOnce([{ id: "bm-11", title: "Other", url: "https://helixsync.test/2" }]);

      // Two events: batch prefetch still applies (the singleton fast path
      // below only kicks in for a lone single event).
      await flushBookmarkEvents([
        {
          kind: "changed",
          id: "bm-10",
          changeInfo: { title: "Updated title" },
        },
        {
          kind: "changed",
          id: "bm-11",
          changeInfo: { title: "Other" },
        },
      ]);

      // Verified: getMappingsByLocalIds was called in a single batch read
      // covering both events, not once per event.
      expect(getMappingsByLocalIdsMock).toHaveBeenCalledTimes(1);
      expect(getMappingsByLocalIdsMock).toHaveBeenCalledWith(
        "bookmark",
        expect.arrayContaining(["bm-10", "bm-11"]),
      );
      // And getOrCreateObjectId was bypassed because the mapping was in the batch pre-fetch
      expect(getOrCreateObjectIdMock).not.toHaveBeenCalledWith("bookmark", "bm-10");
    });

    it("skips all batch prefetch for a singleton changed event (singleton fast path)", async () => {
      getMappingsByLocalIdsMock.mockClear();
      getFieldStatesForObjectsMock.mockClear();
      getMock.mockResolvedValueOnce([{ id: "bm-10", title: "Updated title", url: "https://helixsync.test" }]);
      getFieldStateMock.mockResolvedValue({ value: "Old title" });

      await flushBookmarkEvents([
        {
          kind: "changed",
          id: "bm-10",
          changeInfo: { title: "Updated title" },
        },
      ]);

      // Before the fast path this paid 1 mapping batch + 1 node sweep + 3
      // overlay-seed reads (5 round trips); now it falls back to live reads.
      expect(getMappingsByLocalIdsMock).not.toHaveBeenCalled();
      expect(getFieldStatesForObjectsMock).not.toHaveBeenCalled();
      expect(getMock).toHaveBeenCalledTimes(1);
    });

    it("skips all batch prefetch for a singleton created event (perf audit P6)", async () => {
      getMappingsByLocalIdsMock.mockClear();
      getFieldStatesForObjectsMock.mockClear();
      getChildrenMock.mockClear();
      getChildrenMock.mockResolvedValue([
        { id: "bm-9", title: "Neighbor", parentId: "folder-1", index: 0 },
        { id: "bm-new", title: "New", parentId: "folder-1", index: 1 },
      ]);
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
          id: "bm-new",
          node: { id: "bm-new", title: "New", url: "https://new.test/", parentId: "folder-1", index: 1 },
        },
      ]);

      // One isolated create stages its op via live reads only: no mapping
      // batch, no field-state batch seeding — just the one getChildren the
      // position computation itself needs.
      expect(stagedOps).toHaveLength(1);
      expect(getMappingsByLocalIdsMock).not.toHaveBeenCalled();
      expect(getFieldStatesForObjectsMock).not.toHaveBeenCalled();
      expect(getChildrenMock).toHaveBeenCalledTimes(1);
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

  it("commits the first chunk before the walk reaches later nodes (streaming, bounded peak)", async () => {
    // 1200 leaves under one folder. The child iterator refuses to yield past
    // the first 500 until at least one commit has landed: a flatten-everything-
    // first implementation walks into the gate with zero commits and throws,
    // while the streaming walk commits the first chunk mid-walk and passes.
    const leaves = (from: number, to: number): chrome.bookmarks.BookmarkTreeNode[] =>
      Array.from({ length: to - from }, (_, k) => {
        const i = from + k;
        return { id: `bm-${i}`, title: `Bookmark ${i}`, url: `https://example.com/${i}` };
      });
    let commits = 0;
    commitBookmarkBackfillBatchMock.mockReset();
    commitBookmarkBackfillBatchMock.mockImplementation(async () => {
      commits++;
    });
    const first = leaves(0, 500);
    const rest = leaves(500, 1200);
    const gated = [...first] as chrome.bookmarks.BookmarkTreeNode[];
    const realIterator = gated[Symbol.iterator].bind(gated);
    (gated as unknown as Record<symbol, () => Generator<chrome.bookmarks.BookmarkTreeNode>>)[Symbol.iterator] =
      function* () {
        yield* realIterator();
        if (commits < 1) throw new Error("walk reached node 500 before the first commit");
        yield* rest;
      };
    getTreeMock.mockResolvedValue([
      { id: "0", title: "Root", children: [{ id: "1", title: "Bookmarks Bar", children: gated }] },
    ]);
    getMappedChromiumIdsByTypeMock.mockResolvedValue(new Set());
    getMappingsByLocalIdsMock.mockResolvedValue(new Map());
    getFieldStatesForObjectsMock.mockResolvedValue(new Map());

    let gateCalls: unknown[][] = [];
    try {
      await backfillExisting();
    } finally {
      // Snapshot the calls before restoring the bare mock — reset() clears
      // the call log, so assertions below run against the copy.
      gateCalls = [...commitBookmarkBackfillBatchMock.mock.calls];
      commitBookmarkBackfillBatchMock.mockReset();
    }

    // 1200 nodes in walk order chunked identically to before: 500 + 500 + 200.
    expect(gateCalls).toHaveLength(3);
    expect(gateCalls.map((c) => (c[0] as { mappings: unknown[] }).mappings.length)).toEqual([500, 500, 200]);
    expect((gateCalls[0][0] as { mappings: Array<{ chromiumLocalId: string }> }).mappings[0].chromiumLocalId).toBe("bm-0");
    expect((gateCalls[2][0] as { mappings: Array<{ chromiumLocalId: string }> }).mappings[199].chromiumLocalId).toBe(
      "bm-1199",
    );
  });
});

describe("sortedInsertIndex (perf: move-batch sort-once)", () => {
  function legacyIndex(positions: string[], target: string): number {
    const sorted = [...positions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const idx = sorted.findIndex((p) => p > target);
    return idx === -1 ? sorted.length : idx;
  }

  it("matches the legacy sort+findIndex slot on randomized inputs, including duplicate positions", () => {
    let seed = 123456789;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const randPos = () => {
      // Small alphabet forces frequent duplicate keys, the edge case where
      // lower-bound vs upper-bound semantics diverge.
      let s = "";
      for (let i = 0; i < 3; i++) s += "abc"[Math.floor(rand() * 3)];
      return s;
    };
    for (let trial = 0; trial < 300; trial++) {
      const n = Math.floor(rand() * 30);
      const positions = Array.from({ length: n }, randPos);
      const target = randPos();
      const sorted = [...positions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(sortedInsertIndex(sorted.map((p) => ({ position: p })), target)).toBe(
        legacyIndex(positions, target),
      );
    }
  });

  it("places after pre-existing equals and handles empty/singleton arrays", () => {
    expect(sortedInsertIndex([], "m")).toBe(0);
    expect(sortedInsertIndex([{ position: "a" }], "m")).toBe(1);
    expect(sortedInsertIndex([{ position: "z" }], "m")).toBe(0);
    expect(
      sortedInsertIndex([{ position: "m" }, { position: "m" }, { position: "z" }], "m"),
    ).toBe(2);
  });
});

describe("capture toggle (perf audit: disabled-type gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncBookmarks = undefined;
  });

  it("flushBookmarkEvents no-ops while Bookmarks sync is disabled", async () => {
    syncBookmarks = false;
    try {
      await flushBookmarkEvents([
        { kind: "changed", id: "bm-1", changeInfo: { title: "New title" } },
      ]);
      expect(createLocalOperationsBatchMock).not.toHaveBeenCalled();
      expect(scheduleLocalSyncMock).not.toHaveBeenCalled();
    } finally {
      syncBookmarks = undefined;
    }
  });

  it("backfillExisting no-ops while Bookmarks sync is disabled", async () => {
    syncBookmarks = false;
    try {
      await backfillExisting();
      expect(getTreeMock).not.toHaveBeenCalled();
      expect(commitBookmarkBackfillBatchMock).not.toHaveBeenCalled();
    } finally {
      syncBookmarks = undefined;
    }
  });
});
