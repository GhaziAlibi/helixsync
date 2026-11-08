import { beforeEach, describe, expect, it, vi } from "vitest";

let supported: boolean;
let outbox: Array<{ id: string; kind: string; bookmarkCount: number; createdAt: string }>;
let drainResult: Map<string, { outcome: string; code?: string }>;
let points: unknown[];
let available: boolean;

async function load() {
  vi.resetModules();
  supported = true;
  available = true;
  outbox = [];
  drainResult = new Map();
  points = [];
  vi.doMock("../storage/db", () => ({ getDevice: async () => ({ deviceId: "d" }) }));
  vi.doMock("../api/client", async (importActual) => ({
    ...(await importActual<typeof import("../api/client")>()),
    serverSupportsRestorePoints: async () => supported,
    listRestorePoints: async () => points,
    fetchSettings: async () => ({ restorePointsAutomatic: false }),
    setRestorePointPinned: async (id: string, pinned: boolean) => ({ id, pinned }),
    deleteRestorePoint: async () => {},
    updateSettings: async (patch: { restorePointsAutomatic: boolean }) => patch,
  }));
  vi.doMock("./create", () => ({
    createQueuedRestorePoint: async () => ({ id: "new-point" }),
  }));
  vi.doMock("./outbox", () => ({
    drainOutbox: async () => drainResult,
    listOutbox: async () => outbox,
  }));
  vi.doMock("./restore", () => ({
    loadRestorePoint: vi.fn(),
    previewRestore: vi.fn(),
    startRestore: vi.fn(),
    clearLoadedRestorePoint: vi.fn(),
  }));
  vi.doMock("./triggers", () => ({ restorePointsAvailable: async () => available }));
  const service = await import("./service");
  const api = await import("../api/client");
  const state = await import("./state");
  const snapshot = await import("./snapshot");
  return { service, api, state, snapshot };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("toServiceError", () => {
  it("turns each failure into a code the popup knows", async () => {
    const { service, api, state, snapshot } = await load();
    expect(service.toServiceError(new state.RestoreError("unreadable", "bad"))).toEqual({ code: "unreadable", message: "bad" });
    expect(service.toServiceError(new snapshot.BookmarksNotReadyError(3)).code).toBe("bookmarks_not_ready");
    expect(service.toServiceError(new api.ApiError("x", 409, "restore_point_pin_limit")).code).toBe("restore_point_pin_limit");
    expect(service.toServiceError(new api.ApiError("x", 426)).code).toBe("update_needed");
    expect(service.toServiceError(new api.ReauthRequiredError("x")).code).toBe("reauth");
    expect(service.toServiceError(new TypeError("Failed to fetch")).code).toBe("offline");
    expect(service.toServiceError(new Error("odd")).code).toBe("failed");
  });
});

describe("listForPopup", () => {
  it("reports 'not available' without calling the server", async () => {
    const { service } = await load();
    available = false;
    expect(await service.listForPopup()).toMatchObject({ ok: true, available: false, points: [] });
  });

  it("returns the server's points, the waiting uploads and the automatic setting", async () => {
    const { service } = await load();
    points = [{ id: "p1" }];
    outbox = [{ id: "o1", kind: "manual", bookmarkCount: 2, createdAt: "2026-11-04T00:00:00Z" }];
    expect(await service.listForPopup()).toMatchObject({
      ok: true,
      available: true,
      automatic: false,
      points: [{ id: "p1" }],
      pending: [{ id: "o1" }],
    });
  });
});

describe("createManual", () => {
  it("reports an upload that went through", async () => {
    const { service } = await load();
    drainResult = new Map([["new-point", { outcome: "uploaded" }]]);
    expect(await service.createManual()).toEqual({ ok: true, id: "new-point", uploaded: true });
  });

  it("reports a point still waiting to upload as saved", async () => {
    const { service } = await load();
    drainResult = new Map([["new-point", { outcome: "retry-later", code: "network" }]]);
    expect(await service.createManual()).toEqual({ ok: true, id: "new-point", uploaded: false });
  });

  it("reports the server's refusal", async () => {
    const { service } = await load();
    drainResult = new Map([["new-point", { outcome: "discarded", code: "restore_point_limit" }]]);
    const result = await service.createManual();
    expect(result).toMatchObject({ ok: false, error: { code: "restore_point_limit" } });
  });

  it("says so when the server has no restore points", async () => {
    const { service } = await load();
    supported = false;
    expect(await service.createManual()).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});

describe("the small calls", () => {
  it("pins, deletes and switches the automatic setting", async () => {
    const { service } = await load();
    expect(await service.pin("p", true)).toEqual({ ok: true, point: { id: "p", pinned: true } });
    expect(await service.remove("p")).toEqual({ ok: true, deleted: true });
    expect(await service.setAutomatic(true)).toEqual({ ok: true, automatic: true });
    expect(service.progress()).toMatchObject({ ok: true, progress: { phase: "idle" } });
  });
});

// A finished restore stayed reported forever: the popup's Restore points view
// showed it on every open and its Done button led straight back to it (found
// end to end). Done now dismisses it.
describe("dismissProgress", () => {
  it("forgets a finished or failed restore, so the list shows again", async () => {
    const { service, state } = await load();
    state.setRestoreProgress({ phase: "done", applied: 3, total: 3 });
    expect(service.dismissProgress().progress.phase).toBe("idle");
    state.setRestoreProgress({ phase: "error", applied: 0, total: 3 });
    expect(service.dismissProgress().progress.phase).toBe("idle");
    expect(service.progress().progress.phase).toBe("idle");
  });

  it("keeps a restore that is still running", async () => {
    const { service, state } = await load();
    state.setRestoreProgress({ phase: "applying", applied: 1, total: 3 });
    expect(service.dismissProgress().progress.phase).toBe("applying");
  });
});
