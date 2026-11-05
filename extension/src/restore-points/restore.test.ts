import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toB64 } from "../crypto";
import { createFakeBookmarks, createFakeStorageArea, type FakeBookmarks } from "../test-support/fake-bookmarks";
import type { LocalOperation, ObjectType, OperationType } from "../sync/types";

// A whole restore against a real IndexedDB, real crypto and an in-memory
// Chromium tree. The server (restore point storage) and the sync engine's
// network side are stubbed.

const AK = toB64(crypto.getRandomValues(new Uint8Array(32)));

let fake: FakeBookmarks;
let events: string[];
let lamport: number;
let sequence: number;
let failCreateOnCall: number | undefined;
let createCalls: number;
let failPreRestoreUpload: "generic" | "disabled" | undefined;
let stored: Map<string, { meta: Record<string, unknown>; envelope: unknown }>;
let mockSyncFails = false;

async function load() {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  fake = createFakeBookmarks();
  events = [];
  lamport = 1000;
  sequence = 0;
  createCalls = 0;
  failCreateOnCall = undefined;
  failPreRestoreUpload = undefined;
  mockSyncFails = false;
  stored = new Map();
  vi.stubGlobal("chrome", {
    bookmarks: fake.api,
    storage: { session: createFakeStorageArea(), local: createFakeStorageArea() },
    runtime: { getPlatformInfo: (cb: () => void) => cb() },
  });

  vi.doMock("../storage/db", async (importActual) => ({
    ...(await importActual<typeof import("../storage/db")>()),
    getDevice: async () => ({ deviceId: "dev-A", accountKey: AK, accountKeyVersion: 1, serverUrl: "https://x.test" }),
  }));
  vi.doMock("../api/client", async (importActual) => {
    const actual = await importActual<typeof import("../api/client")>();
    return {
      ...actual,
      fetchSettings: async () => ({ syncBookmarks: true }),
      serverSupportsRestorePoints: async () => true,
      uploadRestorePoint: async (point: { id: string; kind: string; envelope: unknown; codec?: string }) => {
        if (point.kind === "pre_restore" && failPreRestoreUpload === "generic") {
          throw new actual.ApiError("boom", 500);
        }
        if (point.kind === "pre_restore" && failPreRestoreUpload === "disabled") {
          throw new actual.ApiError("off", 409, "restore_points_disabled");
        }
        events.push(`upload:${point.kind}`);
        const meta = { id: point.id, kind: point.kind, codec: point.codec ?? null, pinned: false };
        stored.set(point.id, { meta, envelope: point.envelope });
        return meta;
      },
      downloadRestorePoint: async (id: string) => {
        const entry = stored.get(id);
        if (!entry) throw new actual.ApiError("not found", 404, "not_found");
        return { ...entry.meta, envelope: entry.envelope };
      },
      reportRestoreApplied: async () => {
        events.push("reported");
      },
    };
  });
  vi.doMock("../sync/engine", () => ({
    registerApplier: vi.fn(),
    registerBatchApplier: vi.fn(),
    registerPreSnapshotHook: vi.fn(),
    scheduleLocalSync: () => events.push("schedule-sync"),
    runExclusive: async <T>(fn: () => Promise<T>) => fn(),
    uploadPending: async () => {
      if (mockSyncFails) throw new Error("offline");
      events.push("upload-pending");
      return false;
    },
    downloadAndApply: async () => {
      events.push("download");
      return false;
    },
    createLocalOperationsBatch: async (
      items: Array<{ objectType: ObjectType; objectId: string; operationType: OperationType }>,
    ) => {
      createCalls++;
      if (failCreateOnCall !== undefined && createCalls === failCreateOnCall) throw new Error("worker killed");
      events.push(`ops:${items.length}`);
      return items.map((item) => ({
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
      }));
    },
  }));

  const bookmarks = await import("../bookmarks");
  const restore = await import("./restore");
  const create = await import("./create");
  const state = await import("./state");
  const db = await import("../storage/db");
  return { bookmarks, restore, create, state, db };
}
type Loaded = Awaited<ReturnType<typeof load>>;

/** What the browser's user (and the capture code) would do. */
async function userAdds(loaded: Loaded, parent: string, title: string, url?: string) {
  const id = fake.add(parent, title, url);
  const [node] = await fake.api.get(id);
  await loaded.bookmarks.flushBookmarkEvents([{ kind: "created", id, node }]);
  return id;
}

async function userRenames(loaded: Loaded, id: string, title: string) {
  await fake.api.update(id, { title });
  await loaded.bookmarks.flushBookmarkEvents([{ kind: "changed", id, changeInfo: { title } }]);
}

async function userRemoves(loaded: Loaded, id: string) {
  const [subtree] = await fake.api.getSubTree(id);
  const parentId = subtree.parentId!;
  fake.remove(id);
  await loaded.bookmarks.flushBookmarkEvents([
    { kind: "removed", id, removeInfo: { parentId, index: 0, node: subtree } as never },
  ]);
}

async function settled(loaded: Loaded) {
  await loaded.restore.whenRestoreSettled();
  return loaded.state.getRestoreProgress();
}

async function titlesOf(loaded: Loaded) {
  return (await loaded.bookmarks.readLiveBookmarks()).nodes.map((n) => n.title);
}

async function seed(loaded: Loaded) {
  const work = fake.add("1", "Work");
  fake.add(work, "Wiki", "https://example.com/wiki");
  fake.add(work, "Mail", "https://example.com/mail");
  fake.add("1", "Home", "https://example.com/home");
  await loaded.bookmarks.backfillExisting();
  const point = await loaded.create.createUploadedRestorePoint("manual", { kind: "full" });
  events.length = 0;
  return { work, pointId: point.id as string };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("a merge restore", () => {
  it("brings back a deleted folder and reverts a rename, saving a copy first", async () => {
    const loaded = await load();
    const { work, pointId } = await seed(loaded);
    const home = fake.find("1", "Home")!;

    await userRemoves(loaded, work);
    await userRenames(loaded, home, "Home (edited)");
    const extra = await userAdds(loaded, "1", "Extra", "https://example.com/extra");
    expect(await titlesOf(loaded)).toEqual(["Home (edited)", "Extra"]);

    events.length = 0;
    await loaded.restore.startRestore({ pointId, mode: "merge", scope: "all" });
    const progress = await settled(loaded);

    expect(progress.phase).toBe("done");
    expect(progress.counts).toMatchObject({ restored: 3, updated: 1, deleted: 0 });
    // The safety copy is uploaded before the first operation exists.
    expect(events.indexOf("upload:pre_restore")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("upload:pre_restore")).toBeLessThan(events.findIndex((e) => e.startsWith("ops:")));
    expect(events).toContain("reported");
    expect(events.at(-1)).toBe("reported");
    expect(events).toContain("schedule-sync");

    const titles = await titlesOf(loaded);
    expect(titles.sort()).toEqual(["Extra", "Home", "Mail", "Wiki", "Work"]);
    expect(fake.has(extra)).toBe(true);
    expect(await loaded.db.getRestoreJob()).toBeUndefined();

    // The pre_restore point captured the tree as it was before the restore.
    const preRestore = [...stored.values()].find((e) => e.meta.kind === "pre_restore")!;
    expect(preRestore).toBeDefined();
  });

  it("brings the same objectIds back", async () => {
    const loaded = await load();
    const { work, pointId } = await seed(loaded);
    const before = new Map((await loaded.bookmarks.readLiveBookmarks()).nodes.map((n) => [n.title, n.objectId]));
    await userRemoves(loaded, work);

    await loaded.restore.startRestore({ pointId, mode: "merge", scope: "all" });
    await settled(loaded);

    const after = new Map((await loaded.bookmarks.readLiveBookmarks()).nodes.map((n) => [n.title, n.objectId]));
    for (const title of ["Work", "Wiki", "Mail", "Home"]) expect(after.get(title)).toBe(before.get(title));
  });

  it("restores one folder only", async () => {
    const loaded = await load();
    const { work, pointId } = await seed(loaded);
    const home = fake.find("1", "Home")!;
    await userRemoves(loaded, work);
    await userRemoves(loaded, home);

    const point = (await loaded.restore.loadRestorePoint(pointId)).point;
    const workId = point.nodes.find((n) => n.t === "Work")!.o;
    await loaded.restore.startRestore({ pointId, mode: "merge", scope: workId });
    expect((await settled(loaded)).phase).toBe("done");

    expect((await titlesOf(loaded)).sort()).toEqual(["Mail", "Wiki", "Work"]);
  });
});

describe("an exact restore", () => {
  it("also removes bookmarks the point doesn't have", async () => {
    const loaded = await load();
    const { pointId } = await seed(loaded);
    const extraFolder = await userAdds(loaded, "1", "NewFolder");
    await userAdds(loaded, extraFolder, "Inside", "https://example.com/inside");
    await userAdds(loaded, "2", "Loose", "https://example.com/loose");

    await loaded.restore.startRestore({ pointId, mode: "exact", scope: "all" });
    const progress = await settled(loaded);

    expect(progress.phase).toBe("done");
    expect(progress.counts?.deleted).toBe(2); // the folder (with its contents) and the loose bookmark
    expect((await titlesOf(loaded)).sort()).toEqual(["Home", "Mail", "Wiki", "Work"]);
    expect(fake.has(extraFolder)).toBe(false);
  });

  it("can be undone with the pre_restore point", async () => {
    const loaded = await load();
    const { pointId } = await seed(loaded);
    await userAdds(loaded, "1", "Precious", "https://example.com/precious");

    await loaded.restore.startRestore({ pointId, mode: "exact", scope: "all" });
    expect((await settled(loaded)).phase).toBe("done");
    expect(await titlesOf(loaded)).not.toContain("Precious");

    loaded.state.resetRestoreProgress();
    const safety = [...stored.values()].find((e) => e.meta.kind === "pre_restore")!;
    await loaded.restore.startRestore({ pointId: safety.meta.id as string, mode: "merge", scope: "all" });
    expect((await settled(loaded)).phase).toBe("done");
    expect(await titlesOf(loaded)).toContain("Precious");
  });
});

describe("a restore that cannot start safely", () => {
  it("applies nothing when the safety copy can't be saved", async () => {
    const loaded = await load();
    const { work, pointId } = await seed(loaded);
    await userRemoves(loaded, work);
    failPreRestoreUpload = "generic";
    events.length = 0;

    await loaded.restore.startRestore({ pointId, mode: "merge", scope: "all" });
    const progress = await settled(loaded);

    expect(progress.phase).toBe("error");
    expect(progress.error?.code).toBe("pre_restore_failed");
    expect(events.some((e) => e.startsWith("ops:"))).toBe(false);
    expect(await titlesOf(loaded)).toEqual(["Home"]);
    expect(await loaded.db.getRestoreJob()).toBeUndefined();
  });

  it("saves the safety copy as a manual point when automatic points are off", async () => {
    const loaded = await load();
    const { work, pointId } = await seed(loaded);
    await userRemoves(loaded, work);
    failPreRestoreUpload = "disabled";
    events.length = 0;

    await loaded.restore.startRestore({ pointId, mode: "merge", scope: "all" });
    expect((await settled(loaded)).phase).toBe("done");
    expect(events.indexOf("upload:manual")).toBeLessThan(events.findIndex((e) => e.startsWith("ops:")));
  });

  it("fails closed on a point that can't be authenticated", async () => {
    const loaded = await load();
    const { work, pointId } = await seed(loaded);
    await userRemoves(loaded, work);
    const entry = stored.get(pointId)!;
    (entry.envelope as { ciphertext: string }).ciphertext = "AAAA" + (entry.envelope as { ciphertext: string }).ciphertext.slice(4);
    events.length = 0;

    await loaded.restore.startRestore({ pointId, mode: "merge", scope: "all" });
    const progress = await settled(loaded);

    expect(progress.phase).toBe("error");
    expect(progress.error?.code).toBe("unreadable");
    expect(events).toEqual([]);
    expect(await titlesOf(loaded)).toEqual(["Home"]);
  });

  it("waits for bookmarks that aren't mapped yet", async () => {
    const loaded = await load();
    const { pointId } = await seed(loaded);
    fake.add("1", "Uncaptured", "https://example.com/u");
    events.length = 0;

    await loaded.restore.startRestore({ pointId, mode: "merge", scope: "all" });
    const progress = await settled(loaded);

    expect(progress.error?.code).toBe("bookmarks_not_ready");
    expect(events.some((e) => e.startsWith("ops:") || e.startsWith("upload:"))).toBe(false);
  });

  it("stops when the pre-restore sync fails", async () => {
    const loaded = await load();
    const { pointId } = await seed(loaded);
    mockSyncFails = true;
    await loaded.restore.startRestore({ pointId, mode: "merge", scope: "all" });
    expect((await settled(loaded)).error?.code).toBe("sync_failed");
  });

  it("refuses a second restore while one runs", async () => {
    const loaded = await load();
    const { pointId } = await seed(loaded);
    await loaded.restore.startRestore({ pointId, mode: "merge", scope: "all" });
    await expect(loaded.restore.startRestore({ pointId, mode: "merge", scope: "all" })).rejects.toMatchObject({
      code: "restore_in_progress",
    });
    await settled(loaded);
  });
});

describe("an interrupted restore", () => {
  it("resumes without a second safety copy and converges", async () => {
    const loaded = await load();
    // Enough nodes for three chunks.
    const big = fake.add("1", "Big");
    for (let i = 0; i < 1100; i++) fake.add(big, `b${i}`, `https://example.com/${i}`);
    await loaded.bookmarks.backfillExisting();
    const point = await loaded.create.createUploadedRestorePoint("manual", { kind: "full" });
    await userRemoves(loaded, big);
    events.length = 0;

    createCalls = 0; // the backfill above used some
    failCreateOnCall = 2; // the worker dies on the second chunk
    await loaded.restore.startRestore({ pointId: point.id as string, mode: "merge", scope: "all" });
    const failed = await settled(loaded);
    expect(failed.phase).toBe("error");
    const job = await loaded.db.getRestoreJob();
    expect(job).toBeDefined();
    expect(job!.applied).toBe(loaded.restore.RESTORE_CHUNK_SIZE);
    expect(job!.total).toBe(1101);
    const partway = (await titlesOf(loaded)).length;
    expect(partway).toBe(loaded.restore.RESTORE_CHUNK_SIZE);

    // A fresh worker finds the job.
    failCreateOnCall = undefined;
    loaded.state.resetRestoreProgress();
    await loaded.restore.resumeInterruptedRestore();
    const done = await settled(loaded);

    expect(done.phase).toBe("done");
    expect(await titlesOf(loaded)).toHaveLength(1101);
    expect(events.filter((e) => e === "upload:pre_restore")).toHaveLength(1);
    expect(await loaded.db.getRestoreJob()).toBeUndefined();
  }, 60_000);

  it("does nothing when there is no job", async () => {
    const loaded = await load();
    await loaded.restore.resumeInterruptedRestore();
    expect(loaded.state.getRestoreProgress().phase).toBe("idle");
  });
});

describe("previewRestore", () => {
  it("reports what would change without changing anything", async () => {
    const loaded = await load();
    const { work, pointId } = await seed(loaded);
    await userRemoves(loaded, work);
    events.length = 0;

    const plan = await loaded.restore.previewRestore({ pointId, mode: "merge", scope: "all" });
    expect(plan.counts.restored).toBe(3);
    expect(plan.sample.restored).toContain("Work");
    expect(await titlesOf(loaded)).toEqual(["Home"]);
    expect(events).toEqual([]);
  });
});
