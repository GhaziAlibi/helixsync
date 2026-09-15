import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceRecord } from "../storage/db";
import type { PendingLocalOperation } from "../sync/engine";

// EXT-3 (review.md): backfillExisting's resumability, exercised the same
// way engine.test.ts exercises uploadPending — this project's vitest setup
// has no real IndexedDB/chrome API harness, so storage/db.ts and
// sync/engine.ts are mocked, and chrome.history.search/getVisits are
// stubbed with a small in-memory fake that mimics the one real-API detail
// this fix depends on: `endTime` excludes items whose lastVisitTime is not
// strictly less than it (see backfillExisting's doc comment in
// history/index.ts and the `historyBackfillLastVisitTime` doc comment in
// storage/db.ts).

let device: DeviceRecord;
const createLocalOperationsBatchMock = vi.fn<(items: PendingLocalOperation[]) => Promise<unknown[]>>();

vi.mock("../storage/db", () => ({
  getDevice: vi.fn(async () => device),
  putDevice: vi.fn(async (record: DeviceRecord) => {
    device = record;
  }),
  putRemoteObject: vi.fn(),
  putRemoteObjectsBatch: vi.fn(),
}));

vi.mock("../sync/engine", () => ({
  createLocalOperationsBatch: (items: PendingLocalOperation[]) => createLocalOperationsBatchMock(items),
  registerApplier: vi.fn(),
  registerBatchApplier: vi.fn(),
  scheduleLocalSync: vi.fn(),
}));

const { backfillExisting } = await import("./index");

interface FakeHistoryItem {
  url: string;
  lastVisitTime: number;
  visitTimes: number[];
}

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

/** Wires chrome.history.search/getVisits against an in-memory item list,
 * sorted newest-first like the real API — search filters to items with
 * `lastVisitTime < endTime` when `endTime` is passed, exactly like real
 * Chrome does, since that's the one behavior backfillExisting's resume
 * path depends on. */
function installFakeChromeHistory(items: FakeHistoryItem[]): void {
  const sorted = [...items].sort((a, b) => b.lastVisitTime - a.lastVisitTime);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    history: {
      search: vi.fn(async (query: { endTime?: number }) => {
        const filtered =
          query.endTime === undefined ? sorted : sorted.filter((i) => i.lastVisitTime < query.endTime!);
        return filtered.map((i) => ({ id: i.url, url: i.url, title: "", lastVisitTime: i.lastVisitTime }));
      }),
      getVisits: vi.fn(async ({ url }: { url: string }) => {
        const item = items.find((i) => i.url === url);
        return (item?.visitTimes ?? []).map((visitTime) => ({
          id: url,
          visitId: String(visitTime),
          referringVisitId: "0",
          visitTime,
          transition: "link",
        }));
      }),
    },
  };
}

function totalOps(calls: PendingLocalOperation[][]): number {
  return calls.reduce((sum, batch) => sum + batch.length, 0);
}

beforeEach(() => {
  device = baseDevice();
  createLocalOperationsBatchMock.mockReset();
  createLocalOperationsBatchMock.mockImplementation(async (items) => items.map(() => ({})));
});

describe("backfillExisting (EXT-3 resumability, review.md)", () => {
  it("imports all visits and records the final high-water mark on a clean, uninterrupted run", async () => {
    installFakeChromeHistory([
      { url: "https://a.test", lastVisitTime: 3000, visitTimes: [3000] },
      { url: "https://b.test", lastVisitTime: 2000, visitTimes: [2000] },
      { url: "https://c.test", lastVisitTime: 1000, visitTimes: [1000] },
    ]);

    await backfillExisting();

    expect(totalOps(createLocalOperationsBatchMock.mock.calls.map((c) => c[0]))).toBe(3);
    // No endTime on the very first call — a fresh device must still get its
    // full history, unchanged from pre-fix behavior.
    const searchMock = (globalThis as unknown as { chrome: { history: { search: ReturnType<typeof vi.fn> } } })
      .chrome.history.search;
    expect(searchMock.mock.calls[0][0].endTime).toBeUndefined();
    expect(device.historyBackfillLastVisitTime).toBe(1000);
  });

  it("resumes after a mid-backfill interruption without re-creating operations for already-flushed visits", async () => {
    // One URL with 501 visits so pushing its ops alone crosses the 500-op
    // flush chunk boundary, forcing a flush (and a high-water-mark persist)
    // partway through the item list — then two more URLs whose ops land in
    // a second, later flush.
    const manyVisits = Array.from({ length: 501 }, (_, i) => 10_000 - i);
    installFakeChromeHistory([
      { url: "https://busy.test", lastVisitTime: 10_000, visitTimes: manyVisits },
      { url: "https://b.test", lastVisitTime: 4000, visitTimes: [4000] },
      { url: "https://c.test", lastVisitTime: 3000, visitTimes: [3000] },
    ]);

    // First call: the batch covering busy.test's 501 visits succeeds
    // (durably committed + high-water mark persisted), but the batch
    // covering b.test/c.test fails — simulating a service worker kill or
    // thrown error partway through backfill, before initialImportCompletedAt
    // would ever get set.
    createLocalOperationsBatchMock.mockImplementationOnce(async (items) => items.map(() => ({})));
    createLocalOperationsBatchMock.mockImplementationOnce(async () => {
      throw new Error("simulated service worker kill");
    });

    await expect(backfillExisting()).rejects.toThrow("simulated service worker kill");

    // Only the first (successful) batch happened; the high-water mark
    // reflects exactly that, not the failed second batch.
    expect(createLocalOperationsBatchMock).toHaveBeenCalledTimes(2);
    expect(createLocalOperationsBatchMock.mock.calls[0][0]).toHaveLength(501);
    expect(device.historyBackfillLastVisitTime).toBe(10_000);

    createLocalOperationsBatchMock.mockReset();
    createLocalOperationsBatchMock.mockImplementation(async (items) => items.map(() => ({})));

    // Second call ("resume", e.g. next startup): must not re-derive ops for
    // busy.test's 501 already-flushed visits — chrome.history.search is
    // now called with endTime = the persisted high-water mark, which a real
    // Chrome would use to exclude everything at or after it.
    await backfillExisting();

    const searchMock = (globalThis as unknown as { chrome: { history: { search: ReturnType<typeof vi.fn> } } })
      .chrome.history.search;
    const secondCallQuery = searchMock.mock.calls[searchMock.mock.calls.length - 1][0];
    expect(secondCallQuery.endTime).toBe(10_000);

    const resumedOps = createLocalOperationsBatchMock.mock.calls.map((c) => c[0]);
    expect(totalOps(resumedOps)).toBe(2); // only b.test + c.test, never busy.test again
    expect(device.historyBackfillLastVisitTime).toBe(3000);
  });

  it("is a cheap no-op once the high-water mark already covers all local history", async () => {
    device = baseDevice({ historyBackfillLastVisitTime: 500 });
    installFakeChromeHistory([{ url: "https://old.test", lastVisitTime: 500, visitTimes: [500] }]);

    await backfillExisting();

    expect(createLocalOperationsBatchMock).not.toHaveBeenCalled();
  });
});
