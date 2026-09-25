import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the P2-6b idle-tick optimization: every runSyncCycle
// feeds lastLocalSyncFire, so a local burst right after an alarm/WS/manual
// cycle respects the min-interval instead of firing a duplicate cycle
// ~250ms later.
//
// (A companion P1-5 proposal — skipping the authoritative
// countPendingOperations() when uploadPending proves a clean drain — was
// measured at 1 IDB read saved per idle tick but REVERTED: it broke the
// existing "never skips while the upload queue is non-empty" invariant,
// since count() observes rows upload's filtered fetch cannot. See the
// before/after report.)

vi.stubGlobal("chrome", {
  storage: {
    session: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
  },
});

const getPendingOperationsMock = vi.fn(async () => [] as never[]);
const countPendingOperationsMock = vi.fn(async () => 0);
const downloadChangesMock = vi.fn(
  async (..._args: unknown[]): Promise<{ operations: never[]; nextCursor: number; hasMore: boolean }> => ({
    operations: [],
    nextCursor: 1,
    hasMore: false,
  }),
);

vi.mock("../storage/db", () => ({
  getPendingOperations: (...a: unknown[]) => getPendingOperationsMock(...(a as [])),
  countPendingOperations: (...a: unknown[]) => countPendingOperationsMock(...(a as [])),
  getAppliedOperationIds: vi.fn(async () => new Set()),
  getDevice: vi.fn(async () => ({
    deviceId: "d1",
    encryptionRootKey: "cmVr",
    encryptionRootKeyVersion: 1,
    serverUrl: "https://x",
  })),
  getSyncState: vi.fn(async () => ({ id: "self", cursor: 1, lamportClock: 0, deviceSequence: 0 })),
  putSyncState: vi.fn(async () => {}),
  markUploadInFlightRecords: vi.fn(async () => {}),
  requeueInFlightRecords: vi.fn(async () => {}),
  removeFromQueue: vi.fn(async () => {}),
  markAppliedBatch: vi.fn(async () => {}),
  clearFieldState: vi.fn(async () => {}),
  tickLamportClock: vi.fn(async () => 1),
  reserveSequenceBatch: vi.fn(async () => ({ startDeviceSequence: 0, startLamport: 0 })),
  enqueueOperation: vi.fn(async () => {}),
  enqueueOperationsBatch: vi.fn(async () => {}),
  nextDeviceSequence: vi.fn(async () => 1),
}));

vi.mock("../api/client", () => ({
  ApiError: class extends Error {},
  uploadOperations: vi.fn(async () => ({ accepted: [], duplicate: [], rejected: [] })),
  downloadChanges: (...a: unknown[]) => downloadChangesMock(...(a as [])),
  fetchSnapshot: vi.fn(),
}));

vi.mock("../api/websocket", () => ({
  isConnected: () => true,
}));

const engine = await import("./engine");

describe("idle tick skip optimizations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    engine.resetDownloadSkipStateForTesting();
    engine.resetLocalSyncStateForTesting();
  });

  it("P2-6b: a local nudge right after an alarm cycle is throttled, not prompt", async () => {
    vi.useFakeTimers();
    try {
      await engine.runSyncCycle();
      downloadChangesMock.mockClear();
      engine.scheduleLocalSync();
      await vi.advanceTimersByTimeAsync(300);
      expect(downloadChangesMock.mock.calls.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
