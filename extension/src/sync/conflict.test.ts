import { describe, expect, it } from "vitest";
import { compareOrderingKey } from "./conflict";

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
