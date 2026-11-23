import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeBookmarks, type FakeBookmarks } from "../test-support/fake-bookmarks";
import type { OperationOut } from "../sync/types";
import { combineRulesets, type EffectiveRules } from "../rulesets/effective";
import type { Rule } from "../rulesets/types";

// Folder rules (docs/protocol.md §17.4) against the real bookmark code, with
// an in-memory tree and an in-memory stand-in for the database.

let fake: FakeBookmarks;
let rules: EffectiveRules;

// chromiumId -> objectId
let mappings: Map<string, string>;
// `${objectId}:${field}` -> value
let fieldStates: Map<string, unknown>;
let ops: Array<{ objectType: string; objectId: string; operationType: string; payload: Record<string, unknown> }>;
let appliedFolderRules: { excluded: string[]; included: string[] } | undefined;
let initialImportCompletedAt: string | undefined;
let lamport = 0;

const rec = (chromiumLocalId: string, objectId: string) => ({ chromiumLocalId, objectId });
const stateKey = (objectId: string, field: string) => `${objectId}:${field}`;

vi.mock("../storage/db", () => ({
  getRulesetsRecord: vi.fn(async () => ({ id: "self", rulesets: [], fetchedAt: "", appliedFolderRules })),
  putRulesetsRecord: vi.fn(async (r: { appliedFolderRules?: { excluded: string[]; included: string[] } }) => {
    appliedFolderRules = r.appliedFolderRules;
  }),
  getAllMoveStates: vi.fn(async () => {
    const out = new Map<string, { parent: string | null; position: string }>();
    for (const [key, value] of fieldStates) {
      if (!key.endsWith(":move")) continue;
      const v = value as { parent: string | null; position: string };
      out.set(key.slice(0, -":move".length), { parent: v.parent ?? null, position: v.position });
    }
    return out;
  }),
  getDevice: vi.fn(async () => ({ deviceId: "device-1", initialImportCompletedAt })),
  getFieldState: vi.fn(async (objectId: string, field: string) => {
    const value = fieldStates.get(stateKey(objectId, field));
    return value === undefined ? undefined : { value };
  }),
  getFieldStatesForObjects: vi.fn(async (objectIds: string[], field: string) => {
    const out = new Map<string, { value: unknown }>();
    for (const id of objectIds) {
      const value = fieldStates.get(stateKey(id, field));
      if (value !== undefined) out.set(id, { value });
    }
    return out;
  }),
  getMappedChromiumIdsByType: vi.fn(async () => new Set(mappings.keys())),
  getMappingsByLocalIds: vi.fn(async (_t: string, ids: string[]) => {
    const found = new Map<string, ReturnType<typeof rec>>();
    for (const id of ids) if (mappings.has(id)) found.set(id, rec(id, mappings.get(id)!));
    return found;
  }),
  getMappingsByObjectIds: vi.fn(async (objectIds: string[]) => {
    const found = new Map<string, ReturnType<typeof rec>>();
    for (const [chromiumId, objectId] of mappings) if (objectIds.includes(objectId)) found.set(objectId, rec(chromiumId, objectId));
    return found;
  }),
  mappingKey: (type: string, id: string) => `${type}:${id}`,
  putMappingsBatch: vi.fn(async (records: Array<{ chromiumLocalId: string; objectId: string }>) => {
    for (const r of records) mappings.set(r.chromiumLocalId, r.objectId);
  }),
  deleteMappingsBatch: vi.fn(async (_t: string, ids: string[]) => {
    for (const id of ids) mappings.delete(id);
  }),
  commitBookmarkBackfillBatch: vi.fn(
    async (batch: {
      mappings: Array<{ chromiumLocalId: string; objectId: string }>;
      fieldStates: Array<{ objectId: string; field: string; value: unknown }>;
    }) => {
      for (const m of batch.mappings) mappings.set(m.chromiumLocalId, m.objectId);
      for (const f of batch.fieldStates) fieldStates.set(stateKey(f.objectId, f.field), f.value);
    },
  ),
  deleteDeferredMaterialization: vi.fn(),
  deleteDeferredMaterializationsBatch: vi.fn(),
  getDeferredMaterializationsWaitingOn: vi.fn(async () => []),
  putDeferredMaterialization: vi.fn(),
  putDeferredMaterializationsBatch: vi.fn(),
  recordConflict: vi.fn(),
}));

vi.mock("../sync/mapping", () => ({
  establishMapping: vi.fn(async (_t: string, chromiumId: string, objectId: string) => {
    mappings.set(chromiumId, objectId);
  }),
  forgetMapping: vi.fn(async (_t: string, chromiumId: string) => {
    mappings.delete(chromiumId);
  }),
  lookupChromiumLocalId: vi.fn(async (objectId: string) => [...mappings].find(([, o]) => o === objectId)?.[0]),
  lookupObjectId: vi.fn(async (_t: string, chromiumId: string) => mappings.get(chromiumId)),
}));

// Every incoming field wins, and is recorded like the real resolver does.
vi.mock("../sync/conflict", () => ({
  recordLocalFieldStatesBatch: vi.fn(async (entries: Array<{ objectId: string; field: string; value: unknown }>) => {
    for (const e of entries) fieldStates.set(stateKey(e.objectId, e.field), e.value);
  }),
  resolveFields: vi.fn(),
  resolveFieldsBatch: vi.fn(
    async (entries: Array<{ objectId: string; field: string; incoming: { value: unknown } }>) =>
      entries.map((e) => {
        fieldStates.set(stateKey(e.objectId, e.field), e.incoming.value);
        return { applied: true, value: e.incoming.value };
      }),
  ),
}));

vi.mock("../api/client", () => ({ fetchSettings: vi.fn(async () => ({ syncBookmarks: true })) }));

const registerBatchApplierMock = vi.fn();
vi.mock("../sync/engine", () => ({
  createLocalOperationsBatch: vi.fn(
    async (pending: Array<{ objectType: string; objectId: string; operationType: string; payload: Record<string, unknown> }>) =>
      pending.map((p) => {
        ops.push(p);
        lamport++;
        return { operation: { operationId: `local-${lamport}`, lamportTimestamp: lamport }, deviceId: "device-1" };
      }),
  ),
  registerApplier: vi.fn(),
  registerBatchApplier: (...args: unknown[]) => registerBatchApplierMock(...args),
  scheduleLocalSync: vi.fn(),
}));

vi.mock("../sync/micro-batch", () => ({
  createMicroBatchQueue: () => () => {},
  flushAllMicroBatchQueuesAndWait: vi.fn(async () => {}),
}));

vi.mock("./roots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./roots")>();
  const objectIdByChromiumId = new Map(Object.entries(actual.ROOT_OBJECT_IDS).filter(([k]) => ["0", "1", "2", "3"].includes(k)));
  const roots = {
    objectIdByChromiumId,
    chromiumIdByObjectId: new Map([...objectIdByChromiumId].map(([c, o]) => [o, c])),
    standInIds: new Set<string>(),
  };
  return { ...actual, bookmarkRoots: async () => roots, standInRootObjectId: async () => undefined, invalidateBookmarkRoots: () => {} };
});

vi.mock("../rulesets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rulesets")>()),
  getEffectiveRules: vi.fn(async () => rules),
}));

const bookmarks = await import("./index");
const { ROOT_OBJECT_IDS } = await import("./roots");
const applyRemoteBatch = registerBatchApplierMock.mock.calls.find(([type]) => type === "bookmark")![1] as (
  items: Array<{ op: OperationOut; payload: unknown }>,
) => Promise<void>;

const BAR_OBJ = ROOT_OBJECT_IDS["1"];
const folderRules = (...rs: Rule[]) => combineRulesets([{ v: 1, name: "R", rules: rs, isDefault: false }]);
const exclude = (folderId: string): Rule => ({ id: `x-${folderId}`, kind: "excludeFolder", folderId });
const include = (folderId: string): Rule => ({ id: `i-${folderId}`, kind: "includeFolder", folderId });

/** A folder/bookmark that already syncs: the node plus its mapping and recorded state. */
function synced(chromiumId: string, objectId: string, parent: string, title: string, url: string | null = null) {
  mappings.set(chromiumId, objectId);
  fieldStates.set(stateKey(objectId, "move"), { parent, position: "a0" });
  fieldStates.set(stateKey(objectId, "title"), title);
  fieldStates.set(stateKey(objectId, "url"), url);
  fieldStates.set(stateKey(objectId, "liveness"), "live");
}

async function nodeOf(id: string): Promise<chrome.bookmarks.BookmarkTreeNode> {
  return (await fake.api.get(id))[0];
}

let remoteSeq = 0;
function remoteCreate(objectId: string, title: string, url: string | null, parent: string, position = "b0") {
  remoteSeq++;
  return {
    op: {
      objectType: url ? "bookmark" : "bookmarkFolder",
      objectId,
      operationType: "create",
      operationId: `remote-${remoteSeq}`,
      lamportTimestamp: 1000 + remoteSeq,
      deviceId: "other-device",
    } as unknown as OperationOut,
    payload: { title, url, parent, position },
  };
}
function remoteDelete(objectId: string, objectType = "bookmarkFolder") {
  remoteSeq++;
  return {
    op: {
      objectType,
      objectId,
      operationType: "delete",
      operationId: `remote-${remoteSeq}`,
      lamportTimestamp: 2000 + remoteSeq,
      deviceId: "other-device",
    } as unknown as OperationOut,
    payload: {},
  };
}

beforeEach(() => {
  fake = createFakeBookmarks();
  (globalThis as unknown as { chrome: unknown }).chrome = { bookmarks: fake.api, storage: { local: { get: async () => ({}), set: async () => {} } } };
  rules = combineRulesets([]);
  mappings = new Map();
  fieldStates = new Map();
  ops = [];
  appliedFolderRules = undefined;
  initialImportCompletedAt = "2026-01-01T00:00:00Z";
  lamport = 0;
  remoteSeq = 0;
});

describe("capture: exclude", () => {
  // Bar: Personal (excluded) { secret }, Work { note }
  let personal: string, secret: string, work: string, note: string;
  beforeEach(() => {
    personal = fake.add("1", "Personal");
    secret = fake.add(personal, "secret", "https://secret.test/");
    work = fake.add("1", "Work");
    note = fake.add(work, "note", "https://note.test/");
    synced(personal, "O-personal", BAR_OBJ, "Personal");
    synced(work, "O-work", BAR_OBJ, "Work");
    rules = folderRules(exclude("O-personal"));
  });

  it("a bookmark created inside an excluded folder produces no operation; outside, it does", async () => {
    const inside = fake.add(personal, "diary", "https://diary.test/");
    const outside = fake.add(work, "todo", "https://todo.test/");
    await bookmarks.flushBookmarkEvents([
      { kind: "created", id: inside, node: await nodeOf(inside) },
      { kind: "created", id: outside, node: await nodeOf(outside) },
    ]);
    expect(ops.map((o) => o.payload.title)).toEqual(["todo"]);
  });

  it("creating a subfolder inside it, and a bookmark in that, are left out too", async () => {
    const sub = fake.add(personal, "Sub");
    const deep = fake.add(sub, "deep", "https://deep.test/");
    await bookmarks.flushBookmarkEvents([
      { kind: "created", id: sub, node: await nodeOf(sub) },
      { kind: "created", id: deep, node: await nodeOf(deep) },
    ]);
    expect(ops).toEqual([]);
  });

  it("changes and removals inside it produce no operation, but a removal still forgets the mapping", async () => {
    synced(secret, "O-secret", "O-personal", "secret", "https://secret.test/");
    await bookmarks.flushBookmarkEvents([{ kind: "changed", id: secret, changeInfo: { title: "renamed" } }]);
    expect(ops).toEqual([]);
    const node = await nodeOf(secret);
    fake.remove(secret);
    await bookmarks.flushBookmarkEvents([
      { kind: "removed", id: secret, removeInfo: { parentId: personal, index: 0, node } },
    ]);
    expect(ops).toEqual([]);
    expect(mappings.has(secret)).toBe(false);
  });

  it("the excluded folder itself is frozen: renaming, moving or removing it uploads nothing", async () => {
    await bookmarks.flushBookmarkEvents([{ kind: "changed", id: personal, changeInfo: { title: "Private" } }]);
    await fake.api.move(personal, { parentId: "2", index: 0 });
    await bookmarks.flushBookmarkEvents([
      { kind: "moved", id: personal, moveInfo: { parentId: "2", index: 0, oldParentId: "1", oldIndex: 0 } },
    ]);
    expect(ops).toEqual([]);
  });

  it("moving a node into an excluded folder stops tracking it (no operation)", async () => {
    await fake.api.move(note, { parentId: personal, index: 0 });
    await bookmarks.flushBookmarkEvents([
      { kind: "moved", id: note, moveInfo: { parentId: personal, index: 0, oldParentId: work, oldIndex: 0 } },
    ]);
    expect(ops).toEqual([]);
  });

  it("moving a node out of an excluded folder creates it, and its subtree, on the account", async () => {
    const sub = fake.add(personal, "Sub");
    fake.add(sub, "a", "https://a.test/");
    fake.add(sub, "b", "https://b.test/");
    await fake.api.move(sub, { parentId: work, index: 0 });
    await bookmarks.flushBookmarkEvents([
      { kind: "moved", id: sub, moveInfo: { parentId: work, index: 0, oldParentId: personal, oldIndex: 1 } },
    ]);
    expect(ops.map((o) => `${o.operationType}:${o.payload.title}`)).toEqual(["create:Sub", "create:a", "create:b"]);
    const subOp = ops[0];
    expect(subOp.payload.parent).toBe("O-work");
    // The children hang under the folder's objectId.
    expect(ops[1].payload.parent).toBe(subOp.objectId);
    expect(ops[2].payload.parent).toBe(subOp.objectId);
  });

  it("reuses the objectId of a node the account already has (an upsert, not a copy)", async () => {
    synced(secret, "O-secret", "O-personal", "secret", "https://secret.test/");
    await fake.api.move(secret, { parentId: work, index: 0 });
    await bookmarks.flushBookmarkEvents([
      { kind: "moved", id: secret, moveInfo: { parentId: work, index: 0, oldParentId: personal, oldIndex: 0 } },
    ]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ operationType: "create", objectId: "O-secret" });
    expect(ops[0].payload.parent).toBe("O-work");
  });

  it("a folder inside the moved subtree that is itself excluded stays out", async () => {
    const sub = fake.add(personal, "Sub");
    const hidden = fake.add(sub, "Hidden");
    fake.add(hidden, "x", "https://x.test/");
    synced(hidden, "O-hidden", "O-sub", "Hidden");
    rules = folderRules(exclude("O-personal"), exclude("O-hidden"));
    await fake.api.move(sub, { parentId: work, index: 0 });
    await bookmarks.flushBookmarkEvents([
      { kind: "moved", id: sub, moveInfo: { parentId: work, index: 0, oldParentId: personal, oldIndex: 0 } },
    ]);
    expect(ops.map((o) => o.payload.title)).toEqual(["Sub"]);
  });

  it("everything outside syncs as usual, and without rules nothing is skipped", async () => {
    rules = combineRulesets([]);
    const inside = fake.add(personal, "diary", "https://diary.test/");
    await bookmarks.flushBookmarkEvents([{ kind: "created", id: inside, node: await nodeOf(inside) }]);
    expect(ops.map((o) => o.payload.title)).toEqual(["diary"]);
  });
});

describe("capture: include", () => {
  let work: string, projects: string, deep: string, other: string;
  beforeEach(() => {
    work = fake.add("1", "Work");
    projects = fake.add("1", "Projects");
    deep = fake.add(projects, "Deep");
    other = fake.add("1", "Other");
    synced(work, "O-work", BAR_OBJ, "Work");
    synced(deep, "O-deep", "O-projects", "Deep");
    rules = folderRules(include("O-work"), include("O-deep"));
  });

  it("only what is under an included folder syncs", async () => {
    const inWork = fake.add(work, "a", "https://a.test/");
    const inDeep = fake.add(deep, "b", "https://b.test/");
    const elsewhere = fake.add(other, "c", "https://c.test/");
    const atRoot = fake.add("1", "d", "https://d.test/");
    await bookmarks.flushBookmarkEvents(
      await Promise.all([inWork, inDeep, elsewhere, atRoot].map(async (id) => ({ kind: "created" as const, id, node: await nodeOf(id) }))),
    );
    expect(ops.map((o) => o.payload.title).sort()).toEqual(["a", "b"]);
  });

  it("an included folder inside an unsynced one is recorded under the nearest synced folder", async () => {
    // Deep sits in Projects, which is not included: another device could not place it there.
    await fake.api.move(deep, { parentId: "1", index: 0 });
    await fake.api.move(deep, { parentId: projects, index: 0 });
    await bookmarks.flushBookmarkEvents([
      { kind: "moved", id: deep, moveInfo: { parentId: projects, index: 0, oldParentId: "1", oldIndex: 0 } },
    ]);
    expect(ops).toHaveLength(1);
    expect(ops[0].operationType).toBe("move");
    expect(ops[0].payload.parent).toBe(BAR_OBJ);
  });

  it("exclude wins over include", async () => {
    const secretFolder = fake.add(work, "Secret");
    synced(secretFolder, "O-secret", "O-work", "Secret");
    rules = folderRules(include("O-work"), exclude("O-secret"));
    const inSecret = fake.add(secretFolder, "s", "https://s.test/");
    const inWork = fake.add(work, "w", "https://w.test/");
    await bookmarks.flushBookmarkEvents(
      await Promise.all([inSecret, inWork].map(async (id) => ({ kind: "created" as const, id, node: await nodeOf(id) }))),
    );
    expect(ops.map((o) => o.payload.title)).toEqual(["w"]);
  });
});

describe("backfill", () => {
  it("leaves an excluded subtree out and uploads the rest", async () => {
    const personal = fake.add("1", "Personal");
    fake.add(personal, "secret", "https://secret.test/");
    const work = fake.add("1", "Work");
    fake.add(work, "note", "https://note.test/");
    synced(personal, "O-personal", BAR_OBJ, "Personal");
    rules = folderRules(exclude("O-personal"));
    await bookmarks.backfillExisting();
    expect(ops.map((o) => o.payload.title).sort()).toEqual(["Work", "note"]);
    // Nothing of the excluded subtree got a mapping beyond the one it had.
    expect([...mappings.values()].filter((o) => o !== "O-personal")).toHaveLength(2);
  });

  it("with include rules, descends only into included folders, which hang under the nearest synced folder", async () => {
    const projects = fake.add("1", "Projects");
    const deep = fake.add(projects, "Deep");
    fake.add(deep, "kept", "https://kept.test/");
    fake.add(projects, "loose", "https://loose.test/");
    fake.add("1", "elsewhere", "https://e.test/");
    synced(deep, "O-deep", "O-projects", "Deep");
    rules = folderRules(include("O-deep"));
    await bookmarks.backfillExisting();
    // Deep is already mapped (so skipped as before), its child is new; nothing else goes.
    expect(ops.map((o) => o.payload.title)).toEqual(["kept"]);
    expect(ops[0].payload.parent).toBe("O-deep");
  });

  it("an included folder that is new goes under the root when its parents aren't synced", async () => {
    const projects = fake.add("1", "Projects");
    const deep = fake.add(projects, "Deep");
    fake.add(deep, "kept", "https://kept.test/");
    mappings.set(deep, "O-deep"); // mapped, but never uploaded (no recorded move)
    rules = folderRules(include("O-deep"));
    await bookmarks.backfillExisting();
    const folderOp = ops.find((o) => o.payload.title === "Deep");
    expect(folderOp?.payload.parent).toBe(BAR_OBJ);
    expect(ops.map((o) => o.payload.title).sort()).toEqual(["Deep", "kept"]);
  });
});

describe("remote apply", () => {
  let personal: string;
  beforeEach(() => {
    personal = fake.add("1", "Personal");
    synced(personal, "O-personal", BAR_OBJ, "Personal");
    rules = folderRules(exclude("O-personal"));
  });

  it("records an operation that lands in an excluded folder but creates nothing", async () => {
    const before = fake.count();
    await applyRemoteBatch([remoteCreate("R-1", "from-phone", "https://phone.test/", "O-personal")]);
    expect(fake.count()).toBe(before);
    expect([...mappings.values()]).not.toContain("R-1");
    // Recorded, so lifting the rule later can create it.
    expect(fieldStates.get(stateKey("R-1", "move"))).toMatchObject({ parent: "O-personal" });
    expect(fieldStates.get(stateKey("R-1", "title"))).toBe("from-phone");
  });

  it("leaves a node of a subfolder of an excluded folder out as well", async () => {
    const sub = fake.add(personal, "Sub");
    synced(sub, "O-sub", "O-personal", "Sub");
    const before = fake.count();
    await applyRemoteBatch([remoteCreate("R-2", "deep", "https://deep.test/", "O-sub")]);
    expect(fake.count()).toBe(before);
  });

  it("applies an operation outside an excluded folder as usual", async () => {
    await applyRemoteBatch([remoteCreate("R-3", "shared", "https://shared.test/", BAR_OBJ)]);
    expect(fake.titles("1")).toContain("shared");
  });

  it("a remote delete of an excluded folder does not delete it here (frozen)", async () => {
    await applyRemoteBatch([remoteDelete("O-personal")]);
    expect(fake.titles("1")).toContain("Personal");
  });

  it("a remote delete of something under an excluded folder keeps it too", async () => {
    const note = fake.add(personal, "note", "https://note.test/");
    synced(note, "O-note", "O-personal", "note", "https://note.test/");
    await applyRemoteBatch([remoteDelete("O-note", "bookmark")]);
    expect(fake.has(note)).toBe(true);
  });

  it("a remote move out of an excluded folder applies, since it lands outside", async () => {
    const note = fake.add(personal, "note", "https://note.test/");
    synced(note, "O-note", "O-personal", "note", "https://note.test/");
    remoteSeq++;
    await applyRemoteBatch([
      {
        op: {
          objectType: "bookmark",
          objectId: "O-note",
          operationType: "move",
          operationId: `remote-${remoteSeq}`,
          lamportTimestamp: 5000,
          deviceId: "other-device",
        } as unknown as OperationOut,
        payload: { parent: BAR_OBJ, position: "z0" },
      },
    ]);
    expect(fake.childIds("1")).toContain(note);
  });

  it("include rules: what is outside an included folder is not created here", async () => {
    rules = folderRules(include("O-work"));
    const work = fake.add("1", "Work");
    synced(work, "O-work", BAR_OBJ, "Work");
    const before = fake.count();
    await applyRemoteBatch([
      remoteCreate("R-out", "outside", "https://o.test/", BAR_OBJ),
      remoteCreate("R-in", "inside", "https://i.test/", "O-work"),
    ]);
    expect(fake.count()).toBe(before + 1);
    expect(fake.titles(work)).toEqual(["inside"]);
  });

  it("include rules: an included folder whose parent isn't synced here is created under the root", async () => {
    rules = folderRules(include("O-deep"));
    fieldStates.set(stateKey("O-projects", "move"), { parent: BAR_OBJ, position: "a0" });
    await applyRemoteBatch([remoteCreate("O-deep", "Deep", null, "O-projects")]);
    expect(fake.titles("1")).toContain("Deep");
  });
});

describe("rules changed", () => {
  it("lifting an exclusion creates what the account has there, linking to a matching local node, and uploads the rest", async () => {
    const personal = fake.add("1", "Personal");
    synced(personal, "O-personal", BAR_OBJ, "Personal");
    // A local node already in the folder that matches an account object, and one that doesn't exist on the account.
    const mine = fake.add(personal, "shared", "https://shared.test/");
    const mineOnly = fake.add(personal, "mine only", "https://mine.test/");
    // Account state recorded while the folder was excluded.
    fieldStates.set(stateKey("R-shared", "move"), { parent: "O-personal", position: "a1" });
    fieldStates.set(stateKey("R-shared", "title"), "shared");
    fieldStates.set(stateKey("R-shared", "url"), "https://shared.test/");
    fieldStates.set(stateKey("R-shared", "liveness"), "live");
    fieldStates.set(stateKey("R-new", "move"), { parent: "O-personal", position: "a2" });
    fieldStates.set(stateKey("R-new", "title"), "new from phone");
    fieldStates.set(stateKey("R-new", "url"), "https://phone.test/");
    fieldStates.set(stateKey("R-new", "liveness"), "live");

    appliedFolderRules = { excluded: ["O-personal"], included: [] };
    rules = combineRulesets([]); // lifted
    await bookmarks.reconcileFolderRules();

    // Linked, not duplicated.
    expect(mappings.get(mine)).toBe("R-shared");
    expect(fake.titles(personal).filter((t) => t === "shared")).toHaveLength(1);
    // Created from recorded state.
    expect(fake.titles(personal)).toContain("new from phone");
    // The local-only one is uploaded.
    expect(ops.map((o) => o.payload.title)).toEqual(["mine only"]);
    expect(mappings.has(mineOnly)).toBe(true);
    expect(appliedFolderRules).toEqual({ excluded: [], included: [] });
  });

  it("does not create an object that is deleted on the account", async () => {
    const personal = fake.add("1", "Personal");
    synced(personal, "O-personal", BAR_OBJ, "Personal");
    fieldStates.set(stateKey("R-gone", "move"), { parent: "O-personal", position: "a1" });
    fieldStates.set(stateKey("R-gone", "title"), "gone");
    fieldStates.set(stateKey("R-gone", "url"), "https://gone.test/");
    fieldStates.set(stateKey("R-gone", "liveness"), "deleted");
    appliedFolderRules = { excluded: ["O-personal"], included: [] };
    rules = combineRulesets([]);
    await bookmarks.reconcileFolderRules();
    expect(fake.titles(personal)).not.toContain("gone");
  });

  it("narrowing only records the rules; nothing is created, uploaded or deleted", async () => {
    const personal = fake.add("1", "Personal");
    fake.add(personal, "a", "https://a.test/");
    synced(personal, "O-personal", BAR_OBJ, "Personal");
    fieldStates.set(stateKey("R-x", "move"), { parent: BAR_OBJ, position: "a1" });
    fieldStates.set(stateKey("R-x", "liveness"), "live");
    appliedFolderRules = { excluded: [], included: [] };
    rules = folderRules(exclude("O-personal"));
    const before = fake.count();
    await bookmarks.reconcileFolderRules();
    expect(fake.count()).toBe(before);
    expect(ops).toEqual([]);
    expect(appliedFolderRules).toEqual({ excluded: ["O-personal"], included: [] });
  });

  it("before the first import it only records the rules (the import follows them)", async () => {
    initialImportCompletedAt = undefined;
    appliedFolderRules = { excluded: ["O-personal"], included: [] };
    rules = combineRulesets([]);
    await bookmarks.reconcileFolderRules();
    expect(ops).toEqual([]);
    expect(appliedFolderRules).toEqual({ excluded: [], included: [] });
  });

  it("does nothing when the rules are the ones last applied", async () => {
    appliedFolderRules = { excluded: ["O-personal"], included: [] };
    rules = folderRules(exclude("O-personal"));
    await bookmarks.reconcileFolderRules();
    expect(ops).toEqual([]);
  });

  it("is repeatable: an interrupted catch-up is not marked applied", async () => {
    const { putRulesetsRecord } = await import("../storage/db");
    appliedFolderRules = { excluded: ["O-personal"], included: [] };
    rules = combineRulesets([]);
    vi.mocked(putRulesetsRecord).mockClear();
    const flush = await import("../sync/micro-batch");
    vi.mocked(flush.flushAllMicroBatchQueuesAndWait).mockRejectedValueOnce(new Error("worker killed"));
    await expect(bookmarks.reconcileFolderRules()).rejects.toThrow("worker killed");
    expect(putRulesetsRecord).not.toHaveBeenCalled();
    expect(appliedFolderRules).toEqual({ excluded: ["O-personal"], included: [] });
  });
});

describe("restore points", () => {
  it("do not read an excluded subtree", async () => {
    const personal = fake.add("1", "Personal");
    const secret = fake.add(personal, "secret", "https://secret.test/");
    const work = fake.add("1", "Work");
    const note = fake.add(work, "note", "https://note.test/");
    synced(personal, "O-personal", BAR_OBJ, "Personal");
    synced(secret, "O-secret", "O-personal", "secret", "https://secret.test/");
    synced(work, "O-work", BAR_OBJ, "Work");
    synced(note, "O-note", "O-work", "note", "https://note.test/");
    rules = folderRules(exclude("O-personal"));
    const live = await bookmarks.readLiveBookmarks();
    expect(live.nodes.map((n) => n.title)).toEqual(["Work", "note"]);
    expect(live.unmapped).toBe(0);
  });

  it("under include rules records an included folder under the nearest synced one", async () => {
    const projects = fake.add("1", "Projects");
    const deep = fake.add(projects, "Deep");
    const kept = fake.add(deep, "kept", "https://k.test/");
    fake.add("1", "elsewhere", "https://e.test/");
    synced(projects, "O-projects", BAR_OBJ, "Projects");
    synced(deep, "O-deep", "O-projects", "Deep");
    synced(kept, "O-kept", "O-deep", "kept", "https://k.test/");
    rules = folderRules(include("O-deep"));
    const live = await bookmarks.readLiveBookmarks();
    expect(live.nodes.map((n) => `${n.title}<${n.parentObjectId}`)).toEqual([`Deep<${BAR_OBJ}`, "kept<O-deep"]);
  });

  it("read everything without rules", async () => {
    const personal = fake.add("1", "Personal");
    synced(personal, "O-personal", BAR_OBJ, "Personal");
    const live = await bookmarks.readLiveBookmarks();
    expect(live.nodes.map((n) => n.title)).toEqual(["Personal"]);
  });
});
