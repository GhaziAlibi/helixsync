import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the history sync-nudge storm: a sustained stream of
// capture flushes (e.g. an auto-refreshing dashboard producing a history
// visit burst every second) must collapse into far fewer sync cycles than
// nudges — one prompt cycle plus one trailing cycle per throttle interval —
// instead of one full cycle per burst.

vi.stubGlobal("chrome", {
  storage: {
    session: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
  },
});

const downloadChangesMock = vi.fn(
  async (..._args: unknown[]): Promise<{ operations: Array<Record<string, unknown>>; nextCursor: number; hasMore: boolean }> => ({
    operations: [],
    nextCursor: 0,
    hasMore: false,
  }),
);

vi.mock("../storage/db", () => ({
  getPendingOperations: vi.fn(async () => []),
  getAppliedOperationIds: vi.fn(async () => new Set()),
  getDevice: vi.fn(async () => ({
    id: "self",
    serverUrl: "https://example.test",
    deviceId: "device-1",
    userId: "user-1",
    email: "u@e.test",
    accessToken: "t",
    accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    refreshToken: "r",
    encryptionRootKey: "a".repeat(44),
    encryptionRootKeyVersion: 1,
  })),
  getSyncState: vi.fn(async () => ({ id: "self", cursor: 0, lamportClock: 0, deviceSequence: 0 })),
  putSyncState: vi.fn(async () => {}),
  markUploadInFlightRecords: vi.fn(async () => {}),
  requeueInFlightRecords: vi.fn(async () => {}),
  removeFromQueue: vi.fn(async () => {}),
  markAppliedBatch: vi.fn(async () => {}),
  clearFieldState: vi.fn(async () => {}),
  countPendingOperations: vi.fn(async () => 0),
  enqueueOperation: vi.fn(async () => {}),
  enqueueOperationsBatch: vi.fn(async () => {}),
  nextDeviceSequence: vi.fn(async () => 1),
  reserveSequenceBatch: vi.fn(async () => ({ startDeviceSequence: 0, startLamport: 0 })),
  tickLamportClock: vi.fn(async () => 1),
}));

vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public code?: string,
      public retryAfterSeconds?: number,
    ) {
      super(message);
    }
  },
  uploadOperations: vi.fn(async () => ({ accepted: [], duplicate: [], rejected: [], serverCursor: 0 })),
  downloadChanges: (...a: unknown[]) => downloadChangesMock(...a),
  fetchSnapshot: vi.fn(),
}));

vi.mock("../crypto", () => ({
  decryptPayload: vi.fn(),
  decryptWithSdek: vi.fn(),
  encryptPayload: vi.fn(async (p: unknown) => p),
  encryptWithSdek: vi.fn((p: unknown) => p),
  getSdek: vi.fn(async () => new Uint8Array(32)),
}));

// Controllable push-channel state for the idle-download-skip tests below.
// Defaults to disconnected so every pre-existing test in this file keeps
// exercising the always-poll path.
let wsConnected = false;
vi.mock("../api/websocket", () => ({
  isConnected: () => wsConnected,
}));

const {
  scheduleLocalSync,
  resetLocalSyncStateForTesting,
  runSyncCycle,
  getLocalSyncIntervalForTesting,
  notifyPeerChanges,
  resetDownloadSkipStateForTesting,
} = await import("./engine");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("scheduleLocalSync throttle", () => {
  beforeEach(() => {
    resetLocalSyncStateForTesting();
    resetDownloadSkipStateForTesting();
    wsConnected = false;
    downloadChangesMock.mockClear();
  });

  it("fires promptly for an isolated nudge", async () => {
    scheduleLocalSync();
    await sleep(600);
    expect(downloadChangesMock).toHaveBeenCalledTimes(1);
  }, 30000);

  it("collapses a sustained stream of nudges: 3 nudges within one interval produce 2 cycles, not 3", async () => {
    // Pre-fix measurement for this exact script: 3 cycles. The throttle must
    // do strictly fewer while still firing promptly for the first nudge and
    // covering the later ones with exactly one trailing cycle.
    for (let i = 0; i < 3; i++) {
      scheduleLocalSync();
      await sleep(700);
    }
    // First cycle fired ~250ms after nudge 1; trailing cycle is armed for
    // the 10s mark after it — wait it out.
    await sleep(10_500);
    const cycles = downloadChangesMock.mock.calls.length;
    console.log(`THROTTLE-RESULT nudges=3 syncCycles=${cycles}`);
    expect(cycles).toBe(2);
  }, 30000);

  it("backs off the nudge interval after sustained empty cycles, recovers on activity", async () => {
    // M2a measured 30 nudges at 1/sec collapsing to 4 cycles (~6/min) — each
    // an upload probe + download GET + cursor walk. Empty cycles must stretch
    // the interval (10s -> 20s -> 40s -> 60s cap); any moved op resets it.
    expect(getLocalSyncIntervalForTesting()).toBe(10_000);
    await runSyncCycle(); // empty #1
    expect(getLocalSyncIntervalForTesting()).toBe(10_000);
    await runSyncCycle(); // empty #2
    expect(getLocalSyncIntervalForTesting()).toBe(20_000);
    await runSyncCycle(); // empty #3
    await runSyncCycle(); // empty #4
    expect(getLocalSyncIntervalForTesting()).toBe(40_000);
    for (let i = 0; i < 4; i++) await runSyncCycle(); // empty #5-8
    expect(getLocalSyncIntervalForTesting()).toBe(60_000);

    // One cycle delivering a single peer op resets the streak immediately.
    downloadChangesMock.mockResolvedValueOnce({
      operations: [
        {
          operationId: "op-peer-1",
          deviceId: "device-2",
          deviceSequence: 1,
          lamportTimestamp: 1,
          objectType: "bookmark",
          objectId: "obj-1",
          operationType: "create",
          encryptionVersion: 1,
          payload: {},
          serverCursor: 1,
          createdAt: new Date().toISOString(),
        },
      ],
      nextCursor: 1,
      hasMore: false,
    });
    await runSyncCycle();
    expect(getLocalSyncIntervalForTesting()).toBe(10_000);
  }, 30000);

  it("treats historyVisit-only movement as empty: sustained visit churn backs off", async () => {
    // Perf audit P0-2: an auto-refreshing dashboard produces a non-empty
    // visit burst every few seconds. Those cycles moved data, so the old
    // `cycleMovedOps === 0` check reset the streak every time and pinned the
    // throttle at its 10s floor (~6 cycles/min indefinitely). Visit-only
    // movement must back off like empty cycles; a bookmark op still resets.
    const visitOp = (id: string) => ({
      operationId: id,
      deviceId: "device-2",
      deviceSequence: 1,
      lamportTimestamp: 1,
      objectType: "historyVisit",
      objectId: `visit-${id}`,
      operationType: "visit",
      encryptionVersion: 0,
      payload: {},
      serverCursor: 1,
      createdAt: new Date().toISOString(),
    });
    for (let i = 0; i < 8; i++) {
      downloadChangesMock.mockResolvedValueOnce({ operations: [visitOp(`v${i}`)], nextCursor: 1, hasMore: false });
      // eslint-disable-next-line no-await-in-loop
      await runSyncCycle();
    }
    expect(getLocalSyncIntervalForTesting()).toBe(60_000);

    downloadChangesMock.mockResolvedValueOnce({
      operations: [
        {
          operationId: "op-bookmark-1",
          deviceId: "device-2",
          deviceSequence: 1,
          lamportTimestamp: 1,
          objectType: "bookmark",
          objectId: "obj-1",
          operationType: "create",
          encryptionVersion: 0,
          payload: {},
          serverCursor: 1,
          createdAt: new Date().toISOString(),
        },
      ],
      nextCursor: 1,
      hasMore: false,
    });
    await runSyncCycle();
    expect(getLocalSyncIntervalForTesting()).toBe(10_000);
  }, 30000);

  it("does not arm a >30s trailing timer in deep backoff (never pins the worker ~a minute)", async () => {
    // Perf audit P1-2: once backed off to 60s, the trailing scheduleLocalSync
    // armed a ~60s setTimeout, holding the worker awake for the whole wait.
    // Long trailing waits are now dropped (the durable queue is picked up by
    // the 5-minute alarm) — only short waits arm a timer.
    for (let i = 0; i < 8; i++) {
      // eslint-disable-next-line no-await-in-loop
      await runSyncCycle();
    }
    expect(getLocalSyncIntervalForTesting()).toBe(60_000);
    scheduleLocalSync();
    await sleep(700);
    const cyclesAfterPrompt = downloadChangesMock.mock.calls.length;

    vi.useFakeTimers();
    try {
      scheduleLocalSync();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(downloadChangesMock.mock.calls.length).toBe(cyclesAfterPrompt);
    } finally {
      vi.useRealTimers();
      resetLocalSyncStateForTesting();
    }
  }, 30000);
});

describe("idle download skip (perf: empty poll with healthy push channel)", () => {
  beforeEach(() => {
    resetLocalSyncStateForTesting();
    resetDownloadSkipStateForTesting();
    wsConnected = false;
    downloadChangesMock.mockClear();
  });

  it("polls the first cycle, then skips the download while WS is healthy and idle", async () => {
    wsConnected = true;
    await runSyncCycle();
    expect(downloadChangesMock).toHaveBeenCalledTimes(1);

    await runSyncCycle();
    await runSyncCycle();
    expect(downloadChangesMock).toHaveBeenCalledTimes(1); // both skipped: zero HTTPS
  });

  it("a push notification forces the next cycle to poll", async () => {
    wsConnected = true;
    await runSyncCycle();
    expect(downloadChangesMock).toHaveBeenCalledTimes(1);
    await runSyncCycle();
    expect(downloadChangesMock).toHaveBeenCalledTimes(1);

    notifyPeerChanges();
    await runSyncCycle();
    expect(downloadChangesMock).toHaveBeenCalledTimes(2);
    // Flag consumed by that poll: the following idle cycle skips again.
    await runSyncCycle();
    expect(downloadChangesMock).toHaveBeenCalledTimes(2);
  });

  it("a dropped WebSocket disables the skip immediately", async () => {
    wsConnected = true;
    await runSyncCycle();
    await runSyncCycle();
    expect(downloadChangesMock).toHaveBeenCalledTimes(1);

    wsConnected = false;
    await runSyncCycle();
    expect(downloadChangesMock).toHaveBeenCalledTimes(2);
  });

  it("never skips while the upload queue is non-empty", async () => {
    const db = await import("../storage/db");
    wsConnected = true;
    await runSyncCycle();
    expect(downloadChangesMock).toHaveBeenCalledTimes(1);

    vi.mocked(db.countPendingOperations).mockResolvedValueOnce(4);
    await runSyncCycle();
    expect(downloadChangesMock).toHaveBeenCalledTimes(2);
  });
});
