import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalOperation, UploadResponse } from "./types";
import type { PendingOperationRecord } from "../storage/db";

// This project's vitest setup has no IndexedDB/chrome API mock harness (see
// tabs/groupSync.test.ts's comment on the same limitation), so `uploadPending`
// is exercised here against a plain in-memory Map standing in for
// storage/db.ts's real `pending_operations` IndexedDB store, and a mocked
// `uploadOperations` standing in for the real HTTP call. This is deliberately
// a fuller integration test of `uploadPending`'s control flow — rather than
// just `classifyRejections` in isolation — because the actual EXT-2 bug
// (review.md) was in how `uploadPending` wired `markUploadInFlight` and
// `requeueInFlight` together, not in any single pure function.
let store: Map<string, PendingOperationRecord>;

function defaultGetPendingOperations(
  limit = 200,
  excludeIds?: ReadonlySet<string>,
): PendingOperationRecord[] {
  return [...store.values()]
    .filter((r) => r.state === "LOCAL_QUEUED" && (!excludeIds || !excludeIds.has(r.operation.operationId)))
    .slice(0, limit);
}

const uploadOperationsMock = vi.fn<(ops: LocalOperation[]) => Promise<UploadResponse>>();

vi.mock("../storage/db", () => ({
  getPendingOperations: vi.fn(async (limit = 200, excludeIds?: ReadonlySet<string>) =>
    defaultGetPendingOperations(limit, excludeIds),
  ),
  markUploadInFlight: vi.fn(async (ids: string[]) => {
    for (const id of ids) {
      const record = store.get(id);
      if (record) record.state = "UPLOAD_IN_FLIGHT";
    }
  }),
  requeueInFlight: vi.fn(async (ids: string[], incrementAttempts = false) => {
    for (const id of ids) {
      const record = store.get(id);
      if (record) {
        record.state = "LOCAL_QUEUED";
        if (incrementAttempts) record.attempts += 1;
      }
    }
  }),
  removeFromQueue: vi.fn(async (ids: string[]) => {
    for (const id of ids) store.delete(id);
  }),
  // Unused by uploadPending but imported by engine.ts at module scope —
  // stubbed so the module loads cleanly under vi.mock.
  clearFieldState: vi.fn(),
  countPendingOperations: vi.fn(),
  enqueueOperation: vi.fn(),
  enqueueOperationsBatch: vi.fn(),
  getAppliedOperationIds: vi.fn(),
  getDevice: vi.fn(),
  getSyncState: vi.fn(),
  markAppliedBatch: vi.fn(),
  nextDeviceSequence: vi.fn(),
  putSyncState: vi.fn(),
  reserveSequenceBatch: vi.fn(),
  tickLamportClock: vi.fn(),
}));

class FakeApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

vi.mock("../api/client", () => ({
  ApiError: FakeApiError,
  uploadOperations: (ops: LocalOperation[]) => uploadOperationsMock(ops),
  downloadChanges: vi.fn(),
  fetchSnapshot: vi.fn(),
}));

const { uploadPending, runSyncCycle, clearSyncBlockedState, MAX_UPLOAD_ATTEMPTS, applySnapshot } = await import("./engine");
const { getPendingOperations, markAppliedBatch } = await import("../storage/db");

function pendingRecord(operationId: string): PendingOperationRecord {
  return {
    operation: {
      operationId,
      deviceSequence: 1,
      lamportTimestamp: 1,
      objectType: "bookmark",
      objectId: "obj-1",
      operationType: "create",
      encryptionVersion: 1,
      payload: {},
    },
    state: "LOCAL_QUEUED",
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
}

describe("uploadPending attempts tracking (EXT-2 fix, review.md)", () => {
  beforeEach(() => {
    store = new Map();
    uploadOperationsMock.mockReset();
  });

  it("never deletes an operation after unlimited transient (network/429/5xx) failures", async () => {
    const record = pendingRecord("op-transient");
    store.set(record.operation.operationId, record);
    uploadOperationsMock.mockRejectedValue(new FakeApiError("rate limited", 429));

    // Far more cycles than MAX_UPLOAD_ATTEMPTS — each one simulates a
    // periodic-alarm-triggered sync cycle hitting the same transient error.
    for (let i = 0; i < MAX_UPLOAD_ATTEMPTS * 3; i++) {
      await expect(uploadPending()).rejects.toThrow();
    }

    expect(store.has("op-transient")).toBe(true);
    expect(store.get("op-transient")?.attempts).toBe(0);
    expect(store.get("op-transient")?.state).toBe("LOCAL_QUEUED");
  });

  it("drops an operation once the server explicitly rejects it as object_not_found MAX_UPLOAD_ATTEMPTS times", async () => {
    const record = pendingRecord("op-rejected");
    store.set(record.operation.operationId, record);
    uploadOperationsMock.mockResolvedValue({
      accepted: [],
      duplicate: [],
      rejected: [{ operationId: "op-rejected", reason: "object_not_found" }],
      serverCursor: 0,
    });

    for (let i = 0; i < MAX_UPLOAD_ATTEMPTS; i++) {
      await uploadPending();
      expect(store.get("op-rejected")?.attempts).toBe(i + 1);
      expect(store.has("op-rejected")).toBe(true);
    }

    // One more cycle: attempts has now reached MAX_UPLOAD_ATTEMPTS, so this
    // call sees it as "stuck" and drops it for good.
    await uploadPending();
    expect(store.has("op-rejected")).toBe(false);
  });

  it("drops a non-object_not_found rejection immediately, without waiting on attempts", async () => {
    const record = pendingRecord("op-invalid");
    store.set(record.operation.operationId, record);
    uploadOperationsMock.mockResolvedValue({
      accepted: [],
      duplicate: [],
      rejected: [{ operationId: "op-invalid", reason: "payload_too_large" }],
      serverCursor: 0,
    });

    await uploadPending();

    expect(store.has("op-invalid")).toBe(false);
  });

  it("removes accepted operations from the queue", async () => {
    const record = pendingRecord("op-ok");
    store.set(record.operation.operationId, record);
    uploadOperationsMock.mockResolvedValue({
      accepted: ["op-ok"],
      duplicate: [],
      rejected: [],
      serverCursor: 0,
    });

    await uploadPending();

    expect(store.has("op-ok")).toBe(false);
  });

  it("only counts one attempt per call against a blocked op, even when a large backlog spans many batches", async () => {
    // Mirrors engine.ts's MAX_UPLOAD_BATCH — not exported since nothing else
    // needs it, so it's duplicated here to size the backlog against it.
    const BATCH_SIZE = 500;

    // "op-blocked" is inserted first, so — like the real `by-sequence`
    // cursor picking the lowest device sequence — the fake store's
    // insertion-order iteration always hands it back at the head of every
    // batch, for as long as it stays LOCAL_QUEUED (which a requeue does).
    const blocked = pendingRecord("op-blocked");
    store.set(blocked.operation.operationId, blocked);

    // Enough healthy ops to force at least 21 full batches of BATCH_SIZE —
    // one more than MAX_UPLOAD_ATTEMPTS — so that, pre-fix, "op-blocked"
    // would have been requeued (and its `attempts` incremented) on every one
    // of those batches within this single `uploadPending()` call, blowing
    // past MAX_UPLOAD_ATTEMPTS and getting dropped before a download ever
    // had a chance to land its missing dependency.
    const healthyCount = (MAX_UPLOAD_ATTEMPTS + 1) * (BATCH_SIZE - 1);
    for (let i = 0; i < healthyCount; i++) {
      const record = pendingRecord(`op-healthy-${i}`);
      store.set(record.operation.operationId, record);
    }

    uploadOperationsMock.mockImplementation(async (ops) => ({
      accepted: ops.filter((op) => op.operationId !== "op-blocked").map((op) => op.operationId),
      duplicate: [],
      rejected: ops
        .filter((op) => op.operationId === "op-blocked")
        .map((op) => ({ operationId: op.operationId, reason: "object_not_found" as const })),
      serverCursor: 0,
    }));

    await uploadPending();

    // "op-blocked" must still be queued, with at most one attempt counted
    // for this entire call — not one per batch it was re-fetched in.
    expect(store.has("op-blocked")).toBe(true);
    expect(store.get("op-blocked")?.attempts).toBe(1);
    expect(store.get("op-blocked")?.state).toBe("LOCAL_QUEUED");

    // Every healthy op across every batch still got uploaded and removed
    // within this one call — draining a large backlog in one cycle still
    // works when nothing is genuinely blocked.
    expect(store.size).toBe(1);
  });
});

// engine.ts's runSyncCycle skip-while-blocked check reads
// `chrome.storage.session` (via ensureSyncBlockedUntilHydrated), which has no
// real implementation in this vitest environment — stub it with a plain
// object standing in for the storage area, same spirit as `store` standing
// in for IndexedDB above.
let sessionStore: Record<string, unknown>;

function stubChromeStorageSession(): void {
  sessionStore = {};
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async (keys: string | string[]) => {
          const requested = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const key of requested) {
            if (key in sessionStore) result[key] = sessionStore[key];
          }
          return result;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionStore, items);
        }),
      },
    },
  });
}

describe("clearSyncBlockedState unblocking runSyncCycle after a 429 cooldown", () => {
  beforeEach(() => {
    store = new Map();
    uploadOperationsMock.mockReset();
    stubChromeStorageSession();
  });

  it("lets runSyncCycle proceed again once the cooldown from a prior 429 is cleared", async () => {
    const record = pendingRecord("op-during-cooldown");
    store.set(record.operation.operationId, record);

    // A 429 during this cycle sets the cooldown (runSyncCycle catches the
    // rejection internally rather than propagating it, unlike the direct
    // uploadPending() calls in the tests above).
    uploadOperationsMock.mockRejectedValueOnce(new FakeApiError("rate limited", 429, undefined, 30));
    await runSyncCycle();
    expect(store.get("op-during-cooldown")?.state).toBe("LOCAL_QUEUED");

    // Immediately afterward, still within the cooldown window, runSyncCycle
    // must skip entirely rather than retry the server — no attempt to
    // upload is made at all.
    uploadOperationsMock.mockClear();
    await runSyncCycle();
    expect(uploadOperationsMock).not.toHaveBeenCalled();

    // Clearing the cooldown must actually unblock the next cycle.
    await clearSyncBlockedState();
    uploadOperationsMock.mockResolvedValueOnce({
      accepted: ["op-during-cooldown"],
      duplicate: [],
      rejected: [],
      serverCursor: 0,
    });
    await runSyncCycle();
    expect(uploadOperationsMock).toHaveBeenCalledTimes(1);
    expect(store.has("op-during-cooldown")).toBe(false);
  });
});

describe("uploadPending head-of-line blocking and busy-spin prevention (EXT-01 fix, review.md)", () => {
  beforeEach(() => {
    store = new Map();
    uploadOperationsMock.mockReset();
    vi.mocked(getPendingOperations).mockReset();
    vi.mocked(getPendingOperations).mockImplementation(async (limit = 200, excludeIds?: ReadonlySet<string>) =>
      defaultGetPendingOperations(limit, excludeIds),
    );
  });

  it("cleanly returns when all items are requeued without spinning 50 iterations", async () => {
    const BATCH_SIZE = 500;
    for (let i = 0; i < BATCH_SIZE; i++) {
      const record = pendingRecord(`op-requeued-${i}`);
      store.set(record.operation.operationId, record);
    }

    uploadOperationsMock.mockImplementation(async (ops) => ({
      accepted: [],
      duplicate: [],
      rejected: ops.map((op) => ({
        operationId: op.operationId,
        reason: "object_not_found" as const,
      })),
      serverCursor: 0,
    }));

    await uploadPending();

    // The first batch uploads all 500 ops and they get requeued.
    // The second batch calls getPendingOperations with all 500 ops excluded,
    // which returns 0 pending items and terminates uploadPending immediately.
    // It must NOT spin for the remaining 48 iterations.
    expect(uploadOperationsMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getPendingOperations)).toHaveBeenCalledTimes(2);

    // All items remain in the store with attempts incremented once
    expect(store.size).toBe(BATCH_SIZE);
    for (let i = 0; i < BATCH_SIZE; i++) {
      const rec = store.get(`op-requeued-${i}`);
      expect(rec?.attempts).toBe(1);
      expect(rec?.state).toBe("LOCAL_QUEUED");
    }
  });

  it("terminates cleanly when retryable is empty and no stuck items were removed", async () => {
    // If pending operations returned from the store are somehow non-retryable
    // (e.g. all in requeuedThisCycle or otherwise not retryable) and no stuck ops were removed,
    // uploadPending must exit cleanly rather than continuing through remaining iterations.
    const BATCH_SIZE = 500;
    for (let i = 0; i < BATCH_SIZE; i++) {
      const record = pendingRecord(`op-${i}`);
      store.set(record.operation.operationId, record);
    }

    // Force getPendingOperations to simulate returning items that are already considered non-retryable
    let callCount = 0;
    vi.mocked(getPendingOperations).mockImplementation(async () => {
      callCount++;
      // Return 500 items that are not stuck
      return [...store.values()].slice(0, BATCH_SIZE);
    });

    uploadOperationsMock.mockImplementation(async (ops) => ({
      accepted: [],
      duplicate: [],
      rejected: ops.map((op) => ({
        operationId: op.operationId,
        reason: "object_not_found" as const,
      })),
      serverCursor: 0,
    }));

    await uploadPending();

    // Call 1: 500 ops returned, all requeued and added to requeuedThisCycle.
    // Call 2: mock returns same 500 ops. All are in requeuedThisCycle, so retryable.length === 0.
    // stuck.length === 0, so it immediately returns without spinning through iterations 2..49!
    expect(callCount).toBe(2);
    expect(uploadOperationsMock).toHaveBeenCalledTimes(1);
  });

  it("fetches and uploads operations beyond the requeued batch (items 501+) in subsequent batches", async () => {
    const BATCH_SIZE = 500;
    // 500 blocked ops followed by 100 healthy ops (total 600)
    for (let i = 0; i < BATCH_SIZE; i++) {
      const record = pendingRecord(`op-blocked-${i}`);
      store.set(record.operation.operationId, record);
    }
    for (let i = 0; i < 100; i++) {
      const record = pendingRecord(`op-healthy-${i}`);
      store.set(record.operation.operationId, record);
    }

    uploadOperationsMock.mockImplementation(async (ops) => ({
      accepted: ops
        .filter((op) => op.operationId.startsWith("op-healthy-"))
        .map((op) => op.operationId),
      duplicate: [],
      rejected: ops
        .filter((op) => op.operationId.startsWith("op-blocked-"))
        .map((op) => ({ operationId: op.operationId, reason: "object_not_found" as const })),
      serverCursor: 0,
    }));

    await uploadPending();

    // Batch 0 uploaded the 500 blocked ops; Batch 1 uploaded the 100 healthy ops.
    expect(uploadOperationsMock).toHaveBeenCalledTimes(2);
    expect(uploadOperationsMock.mock.calls[0][0]).toHaveLength(500);
    expect(uploadOperationsMock.mock.calls[1][0]).toHaveLength(100);

    // Verify excludeIds passed to getPendingOperations in the second batch contains the 500 blocked ops
    const secondCallArgs = vi.mocked(getPendingOperations).mock.calls[1];
    expect(secondCallArgs[0]).toBe(BATCH_SIZE);
    expect(secondCallArgs[1]?.size).toBe(500);
    expect(secondCallArgs[1]?.has("op-blocked-0")).toBe(true);

    // All 100 healthy operations were successfully accepted and removed from the queue
    expect(store.size).toBe(500);
    for (let i = 0; i < 100; i++) {
      expect(store.has(`op-healthy-${i}`)).toBe(false);
    }
    // Blocked operations remain in the queue with 1 attempt
    for (let i = 0; i < BATCH_SIZE; i++) {
      expect(store.has(`op-blocked-${i}`)).toBe(true);
      expect(store.get(`op-blocked-${i}`)?.attempts).toBe(1);
    }
  });

  it("handles multiple consecutive requeued batches and uploads subsequent ready ops", async () => {
    const BATCH_SIZE = 500;
    // 1000 blocked ops (2 full batches) followed by 50 healthy ops
    for (let i = 0; i < BATCH_SIZE * 2; i++) {
      const record = pendingRecord(`op-blocked-${i}`);
      store.set(record.operation.operationId, record);
    }
    for (let i = 0; i < 50; i++) {
      const record = pendingRecord(`op-healthy-${i}`);
      store.set(record.operation.operationId, record);
    }

    uploadOperationsMock.mockImplementation(async (ops) => ({
      accepted: ops
        .filter((op) => op.operationId.startsWith("op-healthy-"))
        .map((op) => op.operationId),
      duplicate: [],
      rejected: ops
        .filter((op) => op.operationId.startsWith("op-blocked-"))
        .map((op) => ({ operationId: op.operationId, reason: "object_not_found" as const })),
      serverCursor: 0,
    }));

    await uploadPending();

    // Batch 0: ops 0..499 (blocked)
    // Batch 1: ops 500..999 (blocked)
    // Batch 2: ops 1000..1049 (healthy)
    expect(uploadOperationsMock).toHaveBeenCalledTimes(3);
    expect(uploadOperationsMock.mock.calls[0][0]).toHaveLength(500);
    expect(uploadOperationsMock.mock.calls[1][0]).toHaveLength(500);
    expect(uploadOperationsMock.mock.calls[2][0]).toHaveLength(50);

    // The healthy ops got removed, leaving only the 1000 blocked ops
    expect(store.size).toBe(1000);
    for (let i = 0; i < 50; i++) {
      expect(store.has(`op-healthy-${i}`)).toBe(false);
    }
  });

  it("advances to subsequent batch when all items in a full batch are dropped as stuck", async () => {
    const BATCH_SIZE = 500;
    // 500 stuck ops (attempts >= MAX_UPLOAD_ATTEMPTS) followed by 50 healthy ops
    for (let i = 0; i < BATCH_SIZE; i++) {
      const record = pendingRecord(`op-stuck-${i}`);
      record.attempts = MAX_UPLOAD_ATTEMPTS;
      store.set(record.operation.operationId, record);
    }
    for (let i = 0; i < 50; i++) {
      const record = pendingRecord(`op-healthy-${i}`);
      store.set(record.operation.operationId, record);
    }

    uploadOperationsMock.mockImplementation(async (ops) => ({
      accepted: ops.map((op) => op.operationId),
      duplicate: [],
      rejected: [],
      serverCursor: 0,
    }));

    await uploadPending();

    // Stuck ops dropped without calling uploadOperations, then healthy ops uploaded in next batch
    expect(uploadOperationsMock).toHaveBeenCalledTimes(1);
    expect(uploadOperationsMock.mock.calls[0][0]).toHaveLength(50);
    expect(store.size).toBe(0);
  });
});

describe("applySnapshot synthetic ID write prevention (EXT-02 fix, review.md)", () => {
  it("applies snapshot objects and tombstones without recording synthetic IDs to applied_operations", async () => {
    const markAppliedBatchMock = vi.mocked(markAppliedBatch);
    markAppliedBatchMock.mockClear();

    const snapshot = {
      snapshotCursor: 42,
      objects: [
        {
          objectType: "bookmark" as const,
          objectId: "b-1",
          operationType: "create" as const,
          encryptionVersion: 0,
          payload: { title: "Test", url: "https://example.com" },
        },
      ],
      tombstones: [
        {
          objectType: "bookmark" as const,
          objectId: "b-2",
        },
      ],
    };

    const device = {
      id: "self" as const,
      deviceId: "dev-1",
      userId: "user-1",
      email: "test@example.com",
      serverUrl: "http://localhost:8080",
      accessToken: "token",
      refreshToken: "refresh",
      accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      encryptionRootKey: "rek",
      encryptionRootKeyVersion: 1,
    };

    await applySnapshot(snapshot, device);

    // Verified: markAppliedBatch must NOT be called for synthetic IDs
    expect(markAppliedBatchMock).not.toHaveBeenCalled();
  });
});
