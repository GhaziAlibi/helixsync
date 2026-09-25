import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceRecord } from "../storage/db";
import type { PendingLocalOperation } from "../sync/engine";
import type { OperationOut } from "../sync/types";
import { hourKey } from "../util/hour";
import { setCpuPaceTargetForTesting } from "../util/pace";

// Covers history/index.ts's live-capture path and how remote visits are
// applied: stored, replayed into the browser's own history (replay.ts), and
// kept from echoing back into capture as new local visits. replay.test.ts
// covers the replay module on its own.

let device: DeviceRecord;
const createLocalOperationsBatchMock = vi.fn<(items: PendingLocalOperation[]) => Promise<unknown[]>>();
const scheduleLocalSyncMock = vi.fn();

let syncHistory: boolean | undefined;

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(async () => ({ historyRetention: "unlimited", syncHistory })),
}));

vi.mock("../storage/db", () => ({
  getDevice: vi.fn(async () => device),
  putDevice: vi.fn(async (record: DeviceRecord) => {
    device = record;
  }),
}));

vi.mock("../sync/engine", () => ({
  createLocalOperationsBatch: (items: PendingLocalOperation[]) => createLocalOperationsBatchMock(items),
  registerApplier: vi.fn((type: string, fn: unknown) => {
    singleAppliers.set(type, fn as SingleApplier);
  }),
  registerBatchApplier: vi.fn((type: string, fn: unknown) => {
    batchAppliers.set(type, fn as BatchApplier);
  }),
  scheduleLocalSync: (...args: unknown[]) => scheduleLocalSyncMock(...args),
}));

type BatchApplier = (items: Array<{ op: OperationOut; payload: unknown }>) => Promise<void>;
type SingleApplier = (op: OperationOut, payload: unknown) => Promise<void>;
const batchAppliers = new Map<string, BatchApplier>();
const singleAppliers = new Map<string, SingleApplier>();

type VisitedListener = (item: { url?: string; title?: string; lastVisitTime?: number }) => void;
let visitedListener: VisitedListener | undefined;
const addUrlMock = vi.fn(async (_details: { url: string }) => {});
const getVisitsMock = vi.fn(async (_details: { url: string }) => [] as unknown[]);

(globalThis as unknown as { chrome: unknown }).chrome = {
  history: {
    onVisited: {
      addListener: vi.fn((cb: VisitedListener) => {
        visitedListener = cb;
      }),
    },
    addUrl: (details: { url: string }) => addUrlMock(details),
    search: vi.fn(async () => []),
    getVisits: (details: { url: string }) => getVisitsMock(details),
  },
};

function baseDevice(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "self",
    serverUrl: "https://example.test",
    deviceId: "device-1",
    userId: "user-1",
    email: "user@example.test",
    accessToken: "token",
    accessTokenExpiresAt: new Date().toISOString(),
    refreshToken: "refresh",
    accountKey: "a".repeat(32),
    accountKeyVersion: 1,
    ...overrides,
  };
}

function remoteVisitOp(
  objectId: string,
  deviceId: string,
  url: string,
  visitedAt: string = new Date().toISOString(),
): { op: OperationOut; payload: unknown } {
  return {
    op: {
      operationId: `op-${objectId}`,
      deviceId,
      deviceSequence: 1,
      lamportTimestamp: 1,
      objectType: "historyVisit",
      objectId,
      operationType: "visit",
      // Real remote ops are always encryptionVersion 1 (sync/engine.ts's
      // decrypt step already ran by the time a batch applier sees them,
      // which this fixture skips by calling the applier directly) — see
      // SEC-13.
      encryptionVersion: 1,
      payload: {},
      serverCursor: 1,
      createdAt: new Date().toISOString(),
    },
    payload: { url, visitedAt },
  };
}

setCpuPaceTargetForTesting(1);

const { registerCapture, setHistoryCaptureEnabled } = await import("./index");
const { resetReplayStateForTesting } = await import("./replay");

beforeEach(() => {
  vi.useRealTimers();
  device = baseDevice();
  // registerCapture is idempotent by design (module-level guard), so the
  // listener captured on the first call stays valid for every test — do NOT
  // re-invoke expecting a fresh listener.
  createLocalOperationsBatchMock.mockReset();
  createLocalOperationsBatchMock.mockImplementation(async (items) => items.map(() => ({})));
  scheduleLocalSyncMock.mockClear();
  addUrlMock.mockReset();
  addUrlMock.mockImplementation(async () => {});
  getVisitsMock.mockReset();
  getVisitsMock.mockImplementation(async () => []);
  syncHistory = undefined;
  resetReplayStateForTesting();
  registerCapture();
});

describe("live visit capture (Change 3: visitHours)", () => {
  it("a genuine visit creates a local operation carrying exactly one visitHours entry", async () => {
    const visitTime = Date.UTC(2026, 8, 23, 9, 47, 0, 0);
    visitedListener?.({ url: "https://real-visit.test/page", title: "Page", lastVisitTime: visitTime });
    await new Promise((r) => setTimeout(r, 300));

    expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
    const items = createLocalOperationsBatchMock.mock.calls[0][0];
    expect(items).toHaveLength(1);
    expect((items[0].payload as { url: string }).url).toBe("https://real-visit.test/page");
    expect(items[0].visitHours).toEqual({ [hourKey(visitTime)]: 1 });
  });

  it("does not nudge an immediate sync for a visit-only burst (perf audit P2)", async () => {
    visitedListener?.({ url: "https://no-nudge.test/page", lastVisitTime: Date.now() });
    await new Promise((r) => setTimeout(r, 300));

    expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
    expect(scheduleLocalSyncMock).not.toHaveBeenCalled();
  });

  it("drops local visits at the listener while History sync is disabled", async () => {
    setHistoryCaptureEnabled(false);
    try {
      visitedListener?.({ url: "https://disabled.test/page", lastVisitTime: Date.now() });
      await new Promise((r) => setTimeout(r, 300));
      expect(createLocalOperationsBatchMock).not.toHaveBeenCalled();
    } finally {
      setHistoryCaptureEnabled(true);
    }
  });
});

describe("live visit capture (Change 2: exact live/import partition)", () => {
  it("drops queued visits before historyBulkEndMs and keeps ones at or after it", async () => {
    const endMs = Date.UTC(2026, 8, 23, 12, 0, 0, 0);
    device = baseDevice({ historyBulkEndMs: endMs });

    visitedListener?.({ url: "https://before-cutoff.test", lastVisitTime: endMs - 1 });
    visitedListener?.({ url: "https://at-cutoff.test", lastVisitTime: endMs });
    visitedListener?.({ url: "https://after-cutoff.test", lastVisitTime: endMs + 60_000 });
    await new Promise((r) => setTimeout(r, 300));

    expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
    const items = createLocalOperationsBatchMock.mock.calls[0][0];
    const urls = items.map((i) => (i.payload as { url: string }).url).sort();
    expect(urls).toEqual(["https://after-cutoff.test", "https://at-cutoff.test"]);
  });

  it("captures everything when historyBulkEndMs is not set (no device record predates it, or import never ran)", async () => {
    device = baseDevice({ historyBulkEndMs: undefined });
    visitedListener?.({ url: "https://anytime.test", lastVisitTime: 12345 });
    await new Promise((r) => setTimeout(r, 300));

    expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
    expect(createLocalOperationsBatchMock.mock.calls[0][0]).toHaveLength(1);
  });
});

/** What Chromium does after addUrl: the visit is stamped at the call, and the
 * event for the canonical URL is delivered asynchronously, after the call has
 * already returned. `lagMs` delays delivery, as a loaded browser does. */
function echoAddUrlAsChromiumDoes(lagMs = 0): void {
  addUrlMock.mockImplementation(async ({ url }) => {
    const canonical = new URL(url).href;
    const visitTime = Date.now();
    setTimeout(() => visitedListener?.({ url: canonical, lastVisitTime: visitTime }), lagMs);
  });
}

function addedUrls(): string[] {
  return addUrlMock.mock.calls.map(([details]) => details.url);
}

describe("remote visit apply: replay into the browser's history", () => {
  it("writes a remote visit's URL into the browser's history", async () => {
    const batch = batchAppliers.get("historyVisit");
    expect(batch).toBeDefined();

    await batch!([remoteVisitOp("remote-1", "device-2", "https://echo.test/page")]);

    expect(addedUrls()).toEqual(["https://echo.test/page"]);
  });

  it("replays a single visit applied on its own", async () => {
    const single = singleAppliers.get("historyVisit");
    expect(single).toBeDefined();
    const { op, payload } = remoteVisitOp("remote-single", "device-2", "https://single.test/page");

    await single!(op, payload);

    expect(addedUrls()).toEqual(["https://single.test/page"]);
  });

  it("does not add a URL the browser already has in its history", async () => {
    getVisitsMock.mockImplementation(async () => [{ visitId: "1" }]);
    const batch = batchAppliers.get("historyVisit");

    await batch!([remoteVisitOp("remote-known", "device-2", "https://known.test/page")]);

    expect(addUrlMock).not.toHaveBeenCalled();
  });

  it("skips own-device visits entirely: nothing is checked or replayed", async () => {
    const batch = batchAppliers.get("historyVisit");
    await batch!([remoteVisitOp("remote-own", "device-1", "https://own-device.test/page")]);

    expect(getVisitsMock).not.toHaveBeenCalled();
    expect(addUrlMock).not.toHaveBeenCalled();
  });

  it("replays a multi-item batch oldest first, one entry per URL", async () => {
    const batch = batchAppliers.get("historyVisit");
    const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 10, minute)).toISOString();
    await batch!([
      remoteVisitOp("p-3", "device-2", "https://p.test/new", at(30)),
      remoteVisitOp("p-1", "device-2", "https://p.test/old", at(10)),
      remoteVisitOp("p-2", "device-2", "https://p.test/mid", at(20)),
      remoteVisitOp("p-4", "device-2", "https://p.test/old", at(5)),
    ]);

    expect(addedUrls()).toEqual(["https://p.test/old", "https://p.test/mid", "https://p.test/new"]);
  });

  it("does not replay while History sync is disabled", async () => {
    syncHistory = false;
    const batch = batchAppliers.get("historyVisit");

    await batch!([remoteVisitOp("remote-off", "device-2", "https://off.test/page")]);

    expect(addUrlMock).not.toHaveBeenCalled();
  });

  it("does not let a failing addUrl stall the sync", async () => {
    addUrlMock.mockImplementation(async () => {
      throw new Error("Url is invalid");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const batch = batchAppliers.get("historyVisit");
      await expect(
        batch!([remoteVisitOp("remote-bad", "device-2", "https://bad.test/page")]),
      ).resolves.toBeUndefined();
      expect(addUrlMock).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("remote visit replay: live/import boundary", () => {
  it("fixes historyBulkEndMs before replaying when this device's import hasn't started", async () => {
    device = baseDevice({ historyBulkEndMs: undefined, initialImportCompletedAt: undefined });
    const before = Date.now();
    const batch = batchAppliers.get("historyVisit");

    await batch!([remoteVisitOp("b-1", "device-2", "https://boundary.test/page")]);

    expect(device.historyBulkEndMs).toBeGreaterThanOrEqual(before);
    expect(device.historyBulkEndMs).toBeLessThanOrEqual(Date.now());
    expect(addUrlMock).toHaveBeenCalledTimes(1);
  });

  it("leaves an existing boundary alone", async () => {
    const endMs = Date.UTC(2026, 8, 23, 12, 0, 0, 0);
    device = baseDevice({ historyBulkEndMs: endMs, initialImportCompletedAt: undefined });
    const batch = batchAppliers.get("historyVisit");

    await batch!([remoteVisitOp("b-2", "device-2", "https://boundary.test/page")]);

    expect(device.historyBulkEndMs).toBe(endMs);
  });

  it("sets no boundary once the initial import has completed", async () => {
    device = baseDevice({ historyBulkEndMs: undefined, initialImportCompletedAt: new Date().toISOString() });
    const batch = batchAppliers.get("historyVisit");

    await batch!([remoteVisitOp("b-3", "device-2", "https://boundary.test/page")]);

    expect(device.historyBulkEndMs).toBeUndefined();
  });
});

describe("replay echo: the visit event addUrl causes is not a visit by the user", () => {
  it("never uploads the events its own replay causes", async () => {
    echoAddUrlAsChromiumDoes();
    const batch = batchAppliers.get("historyVisit");
    const items = [
      // The root URL comes back from Chromium with its trailing slash.
      remoteVisitOp("e-1", "device-2", "https://echo.test"),
      ...Array.from({ length: 9 }, (_, i) => remoteVisitOp(`e-${i + 2}`, "device-2", `https://echo.test/${i}`)),
    ];

    await batch!(items);
    await new Promise((r) => setTimeout(r, 300));

    expect(addUrlMock).toHaveBeenCalledTimes(10);
    expect(createLocalOperationsBatchMock).not.toHaveBeenCalled();
  });

  it("still recognises every echo when the browser delivers them long after the calls", async () => {
    // A large replay floods the browser; its events trail the addUrl calls by
    // far more than any fixed timeout (seen at tens of seconds for 50,000 URLs).
    const delivered: Array<() => void> = [];
    addUrlMock.mockImplementation(async ({ url }) => {
      const canonical = new URL(url).href;
      const visitTime = Date.now();
      delivered.push(() => visitedListener?.({ url: canonical, lastVisitTime: visitTime }));
    });
    const batch = batchAppliers.get("historyVisit");
    await batch!(Array.from({ length: 50 }, (_, i) => remoteVisitOp(`lag-${i}`, "device-2", `https://lag.test/${i}`)));
    expect(delivered).toHaveLength(50);

    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 10 * 60_000);
    try {
      for (const deliver of delivered) deliver();
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      clock.mockRestore();
    }

    expect(createLocalOperationsBatchMock).not.toHaveBeenCalled();
  });

  it("still captures a real visit to a replayed URL once the echo has been absorbed", async () => {
    echoAddUrlAsChromiumDoes();
    const batch = batchAppliers.get("historyVisit");
    await batch!([remoteVisitOp("e-real", "device-2", "https://real.test/page")]);
    await new Promise((r) => setTimeout(r, 50));
    expect(createLocalOperationsBatchMock).not.toHaveBeenCalled();

    // The user opens it a little later: a different visit time from the replay's.
    visitedListener?.({ url: "https://real.test/page", lastVisitTime: Date.now() + 2_000 });
    await new Promise((r) => setTimeout(r, 300));

    expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
    const items = createLocalOperationsBatchMock.mock.calls[0][0];
    expect((items[0].payload as { url: string }).url).toBe("https://real.test/page");
  });

  it("still captures a visit to a URL that was not replayed", async () => {
    echoAddUrlAsChromiumDoes();
    const batch = batchAppliers.get("historyVisit");
    await batch!([remoteVisitOp("e-other", "device-2", "https://replayed.test/page")]);

    visitedListener?.({ url: "https://unrelated.test/page", lastVisitTime: Date.now() });
    await new Promise((r) => setTimeout(r, 300));

    expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
    const items = createLocalOperationsBatchMock.mock.calls[0][0];
    expect((items[0].payload as { url: string }).url).toBe("https://unrelated.test/page");
  });

  it("does not suppress a visit event when addUrl failed", async () => {
    addUrlMock.mockImplementation(async () => {
      throw new Error("Url is invalid");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const batch = batchAppliers.get("historyVisit");
      await batch!([remoteVisitOp("e-fail", "device-2", "https://failed.test/page")]);

      visitedListener?.({ url: "https://failed.test/page", lastVisitTime: Date.now() });
      await new Promise((r) => setTimeout(r, 300));

      expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
