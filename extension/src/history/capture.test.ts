import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceRecord } from "../storage/db";
import type { PendingLocalOperation } from "../sync/engine";
import type { OperationOut } from "../sync/types";
import { hourKey } from "../util/hour";

// Covers what's left of history/index.ts's live-capture and remote-apply
// paths after Change 1 (chrome.history.addUrl replay removed entirely,
// along with the suppression-guard/echo-map machinery that existed only to
// protect it) and Change 2 (the exact live/import partition on
// `historyBulkEndMs`). This file replaces the old echo.test.ts, which
// tested only the now-deleted echo-suppression behavior.

let device: DeviceRecord;
const createLocalOperationsBatchMock = vi.fn<(items: PendingLocalOperation[]) => Promise<unknown[]>>();
const scheduleLocalSyncMock = vi.fn();
const putRemoteObjectMock = vi.fn(async (_record: unknown) => {});
const putRemoteObjectsBatchMock = vi.fn(async (_records: unknown) => {});

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(async () => ({ historyRetention: "unlimited" })),
}));

vi.mock("../storage/db", () => ({
  getDevice: vi.fn(async () => device),
  putDevice: vi.fn(async (record: DeviceRecord) => {
    device = record;
  }),
  putRemoteObject: (record: unknown) => putRemoteObjectMock(record),
  putRemoteObjectsBatch: (records: unknown) => putRemoteObjectsBatchMock(records),
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

(globalThis as unknown as { chrome: unknown }).chrome = {
  history: {
    onVisited: {
      addListener: vi.fn((cb: VisitedListener) => {
        visitedListener = cb;
      }),
    },
    // Kept as a mock purely so a call would be observable if some future
    // change reintroduces a replay path by accident — Change 1 removed
    // every call site that used to invoke this.
    addUrl: (details: { url: string }) => addUrlMock(details),
    search: vi.fn(async () => []),
    getVisits: vi.fn(async () => []),
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
    encryptionRootKey: "a".repeat(32),
    encryptionRootKeyVersion: 1,
    ...overrides,
  };
}

function remoteVisitOp(objectId: string, deviceId: string, url: string): { op: OperationOut; payload: unknown } {
  return {
    op: {
      operationId: `op-${objectId}`,
      deviceId,
      deviceSequence: 1,
      lamportTimestamp: 1,
      objectType: "historyVisit",
      objectId,
      operationType: "visit",
      encryptionVersion: 0,
      payload: {},
      serverCursor: 1,
      createdAt: new Date().toISOString(),
    },
    payload: { url, visitedAt: new Date().toISOString() },
  };
}

const { registerCapture, setHistoryCaptureEnabled } = await import("./index");

beforeEach(() => {
  vi.useRealTimers();
  device = baseDevice();
  // registerCapture is idempotent by design (module-level guard), so the
  // listener captured on the first call stays valid for every test — do NOT
  // re-invoke expecting a fresh listener.
  createLocalOperationsBatchMock.mockReset();
  createLocalOperationsBatchMock.mockImplementation(async (items) => items.map(() => ({})));
  scheduleLocalSyncMock.mockClear();
  putRemoteObjectMock.mockReset();
  putRemoteObjectsBatchMock.mockReset();
  addUrlMock.mockClear();
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

describe("remote visit apply (Change 1: no addUrl replay)", () => {
  it("applyRemoteBatch (single-item): writes remote_objects, never calls addUrl", async () => {
    const batch = batchAppliers.get("historyVisit");
    expect(batch).toBeDefined();

    await batch!([remoteVisitOp("remote-1", "device-2", "https://echo.test/page")]);

    expect(addUrlMock).not.toHaveBeenCalled();
    expect(putRemoteObjectsBatchMock).toHaveBeenCalledTimes(1);
    const records = putRemoteObjectsBatchMock.mock.calls[0][0] as Array<{ objectId: string; payload: { url: string } }>;
    expect(records).toHaveLength(1);
    expect(records[0].payload.url).toBe("https://echo.test/page");
  });

  it("skips own-device visits entirely: no addUrl, no remote_objects write", async () => {
    const batch = batchAppliers.get("historyVisit");
    await batch!([remoteVisitOp("remote-own", "device-1", "https://own-device.test/page")]);

    expect(addUrlMock).not.toHaveBeenCalled();
    expect(putRemoteObjectsBatchMock).toHaveBeenCalledTimes(1);
    expect(putRemoteObjectsBatchMock.mock.calls[0][0]).toEqual([]);
  });

  it("applies a multi-item batch of remote single visits without any addUrl calls", async () => {
    const batch = batchAppliers.get("historyVisit");
    const items = Array.from({ length: 10 }, (_, i) => remoteVisitOp(`remote-p5-${i}`, "device-2", `https://p5.test/${i}`));
    await batch!(items);

    expect(addUrlMock).not.toHaveBeenCalled();
    expect(putRemoteObjectsBatchMock).toHaveBeenCalledTimes(1);
    expect(putRemoteObjectsBatchMock.mock.calls[0][0]).toHaveLength(10);
  });

  it("does not create a local operation as a side effect of applying a remote visit", async () => {
    const batch = batchAppliers.get("historyVisit");
    await batch!([remoteVisitOp("remote-2", "device-2", "https://echo.test/page")]);
    await new Promise((r) => setTimeout(r, 300));

    expect(createLocalOperationsBatchMock).not.toHaveBeenCalled();
  });
});
