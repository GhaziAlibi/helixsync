import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationOut } from "../sync/types";

// Local tree: children by parent id.
let tree: Record<string, chrome.bookmarks.BookmarkTreeNode[]> = {};
let nextCreatedId = 100;
const createMock = vi.fn(async (details: chrome.bookmarks.CreateDetails) => {
  const node = { id: String(nextCreatedId++), title: details.title ?? "", url: details.url, syncing: false };
  (tree[details.parentId!] ??= []).push(node);
  return node;
});
const moveMock = vi.fn(async () => ({}));

(globalThis as unknown as { chrome: unknown }).chrome = {
  bookmarks: {
    getChildren: async (parentId: string) => tree[parentId] ?? [],
    get: async (id: string) => Object.values(tree).flat().filter((n) => n.id === id),
    create: createMock,
    move: moveMock,
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() },
  },
};

// chromiumId -> objectId
let mappings = new Map<string, string>();
const record = (chromiumLocalId: string, objectId: string) => ({ chromiumLocalId, objectId });

vi.mock("../storage/db", () => ({
  commitBookmarkBackfillBatch: vi.fn(),
  deleteDeferredMaterialization: vi.fn(),
  deleteDeferredMaterializationsBatch: vi.fn(),
  deleteMappingsBatch: vi.fn(),
  getDeferredMaterializationsWaitingOn: vi.fn(async () => []),
  getDevice: vi.fn(async () => ({ deviceId: "device-1" })),
  getFieldState: vi.fn(async () => undefined),
  getFieldStatesForObjects: vi.fn(async () => new Map()),
  getMappedChromiumIdsByType: vi.fn(async () => new Set()),
  getMappingsByLocalIds: vi.fn(async (_type: string, ids: string[]) => {
    const found = new Map<string, ReturnType<typeof record>>();
    for (const id of ids) if (mappings.has(id)) found.set(id, record(id, mappings.get(id)!));
    return found;
  }),
  getMappingsByObjectIds: vi.fn(async (objectIds: string[]) => {
    const found = new Map<string, ReturnType<typeof record>>();
    for (const [chromiumId, objectId] of mappings) {
      if (objectIds.includes(objectId)) found.set(objectId, record(chromiumId, objectId));
    }
    return found;
  }),
  mappingKey: (type: string, id: string) => `${type}:${id}`,
  putDeferredMaterialization: vi.fn(),
  putDeferredMaterializationsBatch: vi.fn(),
  putMappingsBatch: vi.fn(),
  recordConflict: vi.fn(),
}));

vi.mock("../sync/mapping", () => ({
  establishMapping: vi.fn(async (_type: string, chromiumId: string, objectId: string) => {
    mappings.set(chromiumId, objectId);
  }),
  forgetMapping: vi.fn(),
  lookupChromiumLocalId: vi.fn(async (objectId: string) =>
    [...mappings].find(([, mapped]) => mapped === objectId)?.[0],
  ),
  lookupObjectId: vi.fn(async (_type: string, chromiumId: string) => mappings.get(chromiumId)),
}));

// Every incoming field wins.
vi.mock("../sync/conflict", () => ({
  recordLocalFieldStatesBatch: vi.fn(),
  resolveFields: vi.fn(),
  resolveFieldsBatch: vi.fn(async (entries: Array<{ incoming: { value: unknown } }>) =>
    entries.map((entry) => ({ applied: true, value: entry.incoming.value })),
  ),
}));

vi.mock("../api/client", () => ({ fetchSettings: vi.fn(async () => ({})) }));

const registerBatchApplierMock = vi.fn();
vi.mock("../sync/engine", () => ({
  createLocalOperationsBatch: vi.fn(),
  registerApplier: vi.fn(),
  registerBatchApplier: (...args: unknown[]) => registerBatchApplierMock(...args),
  scheduleLocalSync: vi.fn(),
}));

vi.mock("./roots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./roots")>();
  const objectIdByChromiumId = new Map(Object.entries(actual.ROOT_OBJECT_IDS));
  const roots = {
    objectIdByChromiumId,
    chromiumIdByObjectId: new Map([...objectIdByChromiumId].map(([chromiumId, objectId]) => [objectId, chromiumId])),
    standInIds: new Set<string>(),
  };
  return { ...actual, bookmarkRoots: async () => roots, standInRootObjectId: async () => undefined };
});

const { setLinkExistingBookmarks } = await import("./index");
const { ROOT_OBJECT_IDS } = await import("./roots");
const applyRemoteBatch = registerBatchApplierMock.mock.calls.find(([type]) => type === "bookmark")![1] as (
  items: Array<{ op: OperationOut; payload: unknown }>,
) => Promise<void>;

const BAR = ROOT_OBJECT_IDS["1"];
let lamport = 0;

function remoteCreate(objectId: string, title: string, url: string | null, parent: string, position: string) {
  lamport++;
  return {
    op: {
      objectType: url ? "bookmark" : "bookmarkFolder",
      objectId,
      operationType: "create",
      operationId: `op-${lamport}`,
      lamportTimestamp: lamport,
      deviceId: "other-device",
    } as unknown as OperationOut,
    payload: { title, url, parent, position },
  };
}

describe("linking remote bookmarks to matching local ones on first connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nextCreatedId = 100;
    mappings = new Map();
    tree = {
      "1": [
        { id: "10", title: "Docs", url: "https://docs.example", syncing: false },
        { id: "11", title: "Mine only", url: "https://mine.example", syncing: false },
        { id: "12", title: "Favorites", syncing: false },
      ],
      "12": [{ id: "13", title: "Blog", url: "https://blog.example", syncing: false }],
    };
  });

  it("links instead of creating a duplicate while linking is on", async () => {
    setLinkExistingBookmarks(true);
    try {
      await applyRemoteBatch([
        remoteCreate("R-docs", "Docs", "https://docs.example", BAR, "a"),
        remoteCreate("R-fav", "Favorites", null, BAR, "b"),
        remoteCreate("R-blog", "Blog", "https://blog.example", "R-fav", "a"),
      ]);
    } finally {
      setLinkExistingBookmarks(false);
    }

    expect(createMock).not.toHaveBeenCalled();
    expect(mappings.get("10")).toBe("R-docs");
    expect(mappings.get("12")).toBe("R-fav");
    expect(mappings.get("13")).toBe("R-blog");
    // Left for the import to upload.
    expect(mappings.has("11")).toBe(false);
  });

  it("creates the remote bookmark when nothing matches", async () => {
    setLinkExistingBookmarks(true);
    try {
      await applyRemoteBatch([remoteCreate("R-new", "Docs", "https://other.example", BAR, "a")]);
    } finally {
      setLinkExistingBookmarks(false);
    }

    expect(createMock).toHaveBeenCalledWith({ parentId: "1", title: "Docs", url: "https://other.example" });
    expect(mappings.has("10")).toBe(false);
  });

  it("links one local bookmark to only one remote object", async () => {
    setLinkExistingBookmarks(true);
    try {
      await applyRemoteBatch([
        remoteCreate("R-1", "Docs", "https://docs.example", BAR, "a"),
        remoteCreate("R-2", "Docs", "https://docs.example", BAR, "b"),
      ]);
    } finally {
      setLinkExistingBookmarks(false);
    }

    expect(mappings.get("10")).toBe("R-1");
    expect(createMock).toHaveBeenCalledTimes(1);
    expect([...mappings.values()]).toContain("R-2");
  });

  it("creates as before when linking is off", async () => {
    await applyRemoteBatch([remoteCreate("R-docs", "Docs", "https://docs.example", BAR, "a")]);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(mappings.has("10")).toBe(false);
  });
});
