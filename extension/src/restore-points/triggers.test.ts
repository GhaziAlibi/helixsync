import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveBookmarkNode, LiveBookmarkTree, MassDeleteEvent } from "../bookmarks";
import { createFakeStorageArea } from "../test-support/fake-bookmarks";
import { toB64 } from "../crypto";

// Which trigger makes which point, and when it stays quiet.

const AK = toB64(crypto.getRandomValues(new Uint8Array(32)));
const BAR = "00000000-0000-7000-8000-000000000001";

let device: { deviceId: string; accountKey: string; accountKeyVersion: number; initialImportCompletedAt?: string } | undefined;
let settings: { syncBookmarks?: boolean; restorePointsAutomatic?: boolean };
let supported: boolean;
let live: LiveBookmarkTree;
let massDeleteHandler: ((event: MassDeleteEvent) => Promise<void> | void) | undefined;
let preSnapshotHooks: Array<() => Promise<void>>;
let queued: Array<{ id: string; kind: string; bookmarkCount: number }>;
let drains: number;
let local: ReturnType<typeof createFakeStorageArea>;
let alarms: Map<string, unknown>;
let restoreRunning = false;

function liveNode(id: string, title: string): LiveBookmarkNode {
  return {
    chromiumId: `c${id}`,
    objectId: id,
    kind: "b",
    title,
    url: `https://example.com/${id}`,
    parentObjectId: BAR,
    position: `a${id}`,
    unmodifiable: false,
  };
}

async function load() {
  vi.resetModules();
  device = { deviceId: "dev-A", accountKey: AK, accountKeyVersion: 1, initialImportCompletedAt: "2026-01-01T00:00:00Z" };
  settings = { syncBookmarks: true, restorePointsAutomatic: true };
  supported = true;
  live = { nodes: [liveNode("1", "One")], unmapped: 0 };
  massDeleteHandler = undefined;
  preSnapshotHooks = [];
  queued = [];
  drains = 0;
  restoreRunning = false;
  local = createFakeStorageArea();
  alarms = new Map();
  vi.stubGlobal("chrome", {
    storage: { local, session: createFakeStorageArea() },
    alarms: {
      get: async (name: string) => alarms.get(name),
      create: (name: string, info: unknown) => alarms.set(name, info),
    },
  });
  vi.doMock("../storage/db", () => ({
    getDevice: async () => device,
  }));
  vi.doMock("../api/client", () => ({
    fetchSettings: async () => settings,
    serverSupportsRestorePoints: async () => supported,
    uploadRestorePoint: vi.fn(),
  }));
  vi.doMock("../bookmarks", () => ({
    readLiveBookmarks: async () => live,
    setMassDeleteHandler: (handler: typeof massDeleteHandler) => {
      massDeleteHandler = handler;
    },
  }));
  vi.doMock("../sync/engine", () => ({
    registerPreSnapshotHook: (hook: () => Promise<void>) => preSnapshotHooks.push(hook),
  }));
  vi.doMock("./outbox", () => ({
    enqueueRestorePoint: async (r: { id: string; kind: string; bookmarkCount: number }) => {
      queued.push({ id: r.id, kind: r.kind, bookmarkCount: r.bookmarkCount });
    },
    drainOutbox: async () => {
      drains++;
      return new Map();
    },
  }));
  vi.doMock("./state", async (importActual) => ({
    ...(await importActual<typeof import("./state")>()),
    isRestoreRunning: () => restoreRunning,
  }));
  return import("./triggers");
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("scheduled points", () => {
  it("makes one, and skips while the tree is unchanged", async () => {
    const t = await load();
    await t.runScheduledRestorePoint();
    expect(queued.map((q) => q.kind)).toEqual(["scheduled"]);
    expect(queued[0].bookmarkCount).toBe(1);
    expect(drains).toBe(1);

    await t.runScheduledRestorePoint();
    expect(queued).toHaveLength(1);

    live = { nodes: [liveNode("1", "One"), liveNode("2", "Two")], unmapped: 0 };
    await t.runScheduledRestorePoint();
    expect(queued).toHaveLength(2);
  });

  it("stays quiet when bookmarks aren't all mapped yet", async () => {
    const t = await load();
    live = { nodes: [liveNode("1", "One")], unmapped: 3 };
    await t.runScheduledRestorePoint();
    expect(queued).toEqual([]);
  });

  it("respects the account's automatic setting", async () => {
    const t = await load();
    settings.restorePointsAutomatic = false;
    await t.runScheduledRestorePoint();
    expect(queued).toEqual([]);
  });

  it("is off without a device, before the first import ends, without server support, or with bookmark sync off", async () => {
    const t = await load();
    device = undefined;
    await t.runScheduledRestorePoint();
    device = { deviceId: "d", accountKey: AK, accountKeyVersion: 1 };
    await t.runScheduledRestorePoint();
    device.initialImportCompletedAt = "2026-01-01T00:00:00Z";
    supported = false;
    await t.runScheduledRestorePoint();
    supported = true;
    settings.syncBookmarks = false;
    await t.runScheduledRestorePoint();
    expect(queued).toEqual([]);

    settings.syncBookmarks = true;
    await t.runScheduledRestorePoint();
    expect(queued).toHaveLength(1);
  });

  it("registers a daily alarm once", async () => {
    const t = await load();
    t.ensureRestorePointAlarm();
    await Promise.resolve();
    await Promise.resolve();
    expect(alarms.get(t.RESTORE_POINT_ALARM)).toMatchObject({ periodInMinutes: 1440 });
  });
});

describe("pre_import", () => {
  it("is made only when the account has bookmarks and this browser has unlinked ones", async () => {
    const t = await load();
    device!.initialImportCompletedAt = undefined; // during the first import

    live = { nodes: [], unmapped: 4 }; // the account has nothing
    await t.createPreImportPoint();
    live = { nodes: [liveNode("1", "One")], unmapped: 0 }; // everything linked
    await t.createPreImportPoint();
    expect(queued).toEqual([]);

    live = { nodes: [liveNode("1", "One")], unmapped: 4 };
    await t.createPreImportPoint();
    expect(queued.map((q) => q.kind)).toEqual(["pre_import"]);
    expect(queued[0].bookmarkCount).toBe(1); // mapped nodes only
  });
});

describe("pre_resync", () => {
  it("is made by the snapshot hook", async () => {
    const t = await load();
    t.installRestorePointTriggers();
    expect(preSnapshotHooks).toHaveLength(1);
    await preSnapshotHooks[0]();
    expect(queued.map((q) => q.kind)).toEqual(["pre_resync"]);
  });

  it("never throws into the resync, even when bookmarks aren't ready", async () => {
    const t = await load();
    t.installRestorePointTriggers();
    live = { nodes: [], unmapped: 5 };
    await expect(preSnapshotHooks[0]()).resolves.toBeUndefined();
    expect(queued).toEqual([]);
  });
});

describe("mass_delete", () => {
  it("makes a point for a local removal, including what was removed", async () => {
    const t = await load();
    t.installRestorePointTriggers();
    await massDeleteHandler!({ origin: "local", count: 60, removed: [liveNode("9", "Gone")] });
    expect(queued.map((q) => q.kind)).toEqual(["mass_delete"]);
    // The live tree (1) plus the removed bookmark.
    expect(queued[0].bookmarkCount).toBe(2);
  });

  it("makes a point for a remote batch from the current tree", async () => {
    const t = await load();
    t.installRestorePointTriggers();
    await massDeleteHandler!({ origin: "remote", count: 80 });
    expect(queued.map((q) => q.kind)).toEqual(["mass_delete"]);
    expect(queued[0].bookmarkCount).toBe(1);
  });

  it("is made at most once in ten minutes", async () => {
    const t = await load();
    t.installRestorePointTriggers();
    await massDeleteHandler!({ origin: "remote", count: 80 });
    await massDeleteHandler!({ origin: "remote", count: 80 });
    expect(queued).toHaveLength(1);

    await local.set({ restorePointLastMassDeleteAt: Date.now() - t.MASS_DELETE_MIN_INTERVAL_MS - 1000 });
    await massDeleteHandler!({ origin: "remote", count: 80 });
    expect(queued).toHaveLength(2);
  });

  it("is not made for the deletions of a restore", async () => {
    const t = await load();
    t.installRestorePointTriggers();
    restoreRunning = true;
    await massDeleteHandler!({ origin: "remote", count: 80 });
    expect(queued).toEqual([]);
  });

  it("respects the automatic setting", async () => {
    const t = await load();
    t.installRestorePointTriggers();
    settings.restorePointsAutomatic = false;
    await massDeleteHandler!({ origin: "remote", count: 80 });
    expect(queued).toEqual([]);
  });
});

describe("clearRestorePointTriggerState", () => {
  it("forgets the hash and throttle, so another account starts clean", async () => {
    const t = await load();
    await t.runScheduledRestorePoint();
    t.installRestorePointTriggers();
    await massDeleteHandler!({ origin: "remote", count: 80 });
    expect(Object.keys((await local.get()) as object).length).toBe(2);
    await t.clearRestorePointTriggerState();
    expect(await local.get()).toEqual({});
  });
});
