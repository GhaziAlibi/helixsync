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

const uploadOperationsMock = vi.fn<(ops: LocalOperation[]) => Promise<UploadResponse>>();

vi.mock("../storage/db", () => ({
  getPendingOperations: vi.fn(async (limit: number) =>
    [...store.values()].filter((r) => r.state === "LOCAL_QUEUED").slice(0, limit),
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

const { uploadPending, runSyncCycle, clearSyncBlockedState, MAX_UPLOAD_ATTEMPTS } = await import("./engine");

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
