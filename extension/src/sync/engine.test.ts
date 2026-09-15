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

const { uploadPending, MAX_UPLOAD_ATTEMPTS } = await import("./engine");

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
});
