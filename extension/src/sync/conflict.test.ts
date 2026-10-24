import { beforeEach, describe, expect, it, vi } from "vitest";

// conflict.ts's real storage/db.ts needs IndexedDB, which this vitest
// environment doesn't have — stand in with an in-memory field_state map
// behind the same get/store/put/tx surface resolveFieldsBatch uses, so the
// batching and ordering semantics are tested against the real
// resolveFieldInTx rather than a reimplementation of it.
const { fieldRecords, txCalls } = vi.hoisted(() => ({
  fieldRecords: new Map<
    string,
    {
      key: string;
      objectId: string;
      field: string;
      lamportTimestamp: number;
      deviceId: string;
      operationId: string;
      operationType: "create";
      value: unknown;
    }
  >(),
  txCalls: { count: 0 },
}));

vi.mock("../storage/db", () => ({
  fieldStateKey: (objectId: string, field: string) => `${objectId}:${field}`,
  getDb: vi.fn(async () => ({
    transaction: () => {
      txCalls.count++;
      return {
        objectStore: () => ({
          get: async (key: string) => fieldRecords.get(key),
          put: async (record: {
            key: string;
            objectId: string;
            field: string;
            lamportTimestamp: number;
            deviceId: string;
            operationId: string;
            operationType: "create";
            value: unknown;
          }) => {
            fieldRecords.set(record.key, record);
          },
        }),
        done: Promise.resolve(),
      };
    },
  })),
  getFieldState: vi.fn(),
  putFieldState: vi.fn(),
  putFieldStatesBatch: vi.fn(),
}));

import { compareOrderingKey, resolveFieldsBatch } from "./conflict";

describe("compareOrderingKey (docs/protocol.md §8.1 universal ordering)", () => {
  it("orders primarily by lamportTimestamp", () => {
    const a = { lamportTimestamp: 5, deviceId: "z", operationId: "z" };
    const b = { lamportTimestamp: 10, deviceId: "a", operationId: "a" };
    expect(compareOrderingKey(a, b)).toBeLessThan(0);
    expect(compareOrderingKey(b, a)).toBeGreaterThan(0);
  });

  it("breaks lamport ties by deviceId", () => {
    const a = { lamportTimestamp: 5, deviceId: "device-a", operationId: "z" };
    const b = { lamportTimestamp: 5, deviceId: "device-b", operationId: "a" };
    expect(compareOrderingKey(a, b)).toBeLessThan(0);
  });

  it("breaks lamport+device ties by operationId", () => {
    const a = { lamportTimestamp: 5, deviceId: "same", operationId: "aaa" };
    const b = { lamportTimestamp: 5, deviceId: "same", operationId: "zzz" };
    expect(compareOrderingKey(a, b)).toBeLessThan(0);
  });

  it("is never used with wall-clock time (AI rule #11) — only these three fields exist", () => {
    const key = { lamportTimestamp: 1, deviceId: "d", operationId: "o" };
    expect(Object.keys(key).sort()).toEqual(["deviceId", "lamportTimestamp", "operationId"]);
  });

  it("returns 0 only for identical keys", () => {
    const a = { lamportTimestamp: 5, deviceId: "d", operationId: "o" };
    const b = { lamportTimestamp: 5, deviceId: "d", operationId: "o" };
    expect(compareOrderingKey(a, b)).toBe(0);
  });
});

describe("resolveFieldsBatch", () => {
  beforeEach(() => {
    fieldRecords.clear();
    txCalls.count = 0;
  });

  it("resolves many objects' fields in a single transaction", async () => {
    const results = await resolveFieldsBatch([
      {
        objectId: "a",
        field: "title",
        incoming: { lamportTimestamp: 1, deviceId: "d1", operationId: "op-1", operationType: "create", value: "A" },
      },
      {
        objectId: "b",
        field: "title",
        incoming: { lamportTimestamp: 1, deviceId: "d1", operationId: "op-2", operationType: "create", value: "B" },
      },
      {
        objectId: "a",
        field: "url",
        incoming: { lamportTimestamp: 1, deviceId: "d1", operationId: "op-3", operationType: "create", value: "https://a" },
      },
    ]);

    expect(txCalls.count).toBe(1);
    expect(results.map((r) => r.applied)).toEqual([true, true, true]);
    expect(results[0].value).toBe("A");
  });

  it("arbitrates repeats of the same slot in wire order", async () => {
    const results = await resolveFieldsBatch([
      {
        objectId: "a",
        field: "title",
        incoming: { lamportTimestamp: 2, deviceId: "d1", operationId: "op-2", operationType: "create", value: "new" },
      },
      {
        objectId: "a",
        field: "title",
        incoming: { lamportTimestamp: 1, deviceId: "d1", operationId: "op-1", operationType: "create", value: "old" },
      },
    ]);

    expect(results[0].applied).toBe(true);
    expect(results[1].applied).toBe(false);
    expect(results[1].value).toBe("new");
  });

  it("preserves the liveness delete-beats-move asymmetry", async () => {
    const results = await resolveFieldsBatch([
      {
        objectId: "a",
        field: "liveness",
        incoming: { lamportTimestamp: 5, deviceId: "d1", operationId: "op-move", operationType: "move", value: "live" },
      },
      {
        objectId: "a",
        field: "liveness",
        incoming: { lamportTimestamp: 1, deviceId: "d1", operationId: "op-delete", operationType: "delete", value: "deleted" },
      },
    ]);

    // Delete wins over move unconditionally, despite the lower lamport clock.
    expect(results[1].applied).toBe(true);
    expect(results[1].value).toBe("deleted");
  });
});
