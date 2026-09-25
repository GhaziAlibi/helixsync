import { describe, expect, it } from "vitest";
import { createKeyedLock } from "./keyed-lock";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createKeyedLock", () => {
  it("runs a single call for a key normally and returns its value", async () => {
    const lock = createKeyedLock();
    const result = await lock.run("a", async () => 42);
    expect(result).toBe(42);
  });

  it("serializes concurrent calls for the same key in call order", async () => {
    const lock = createKeyedLock();
    const order: string[] = [];
    const first = deferred<void>();

    const call1 = lock.run("group-1", async () => {
      order.push("start-1");
      await first.promise;
      order.push("end-1");
    });
    const call2 = lock.run("group-1", async () => {
      order.push("start-2");
      order.push("end-2");
    });

    // call2's body must not have started yet: call1 is still awaiting.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start-1"]);

    first.resolve();
    await Promise.all([call1, call2]);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("does not serialize calls for different keys", async () => {
    const lock = createKeyedLock();
    const order: string[] = [];
    const first = deferred<void>();

    const call1 = lock.run("group-1", async () => {
      order.push("start-1");
      await first.promise;
      order.push("end-1");
    });
    const call2 = lock.run("group-2", async () => {
      order.push("start-2");
      order.push("end-2");
    });

    await call2;
    // group-2's run completed fully without waiting on group-1's in-flight
    // call (group-1's body has started too, since call() invokes its async
    // function body synchronously up to the first await, but group-1's
    // "end-1" must not appear yet since it's still blocked on `first`).
    expect(order).toEqual(["start-1", "start-2", "end-2"]);

    first.resolve();
    await call1;
    expect(order).toContain("end-1");
  });

  it("still runs a later call for the same key after an earlier one throws", async () => {
    const lock = createKeyedLock();
    const order: string[] = [];

    const call1 = lock.run("a", async () => {
      order.push("run-1");
      throw new Error("boom");
    });
    const call2 = lock.run("a", async () => {
      order.push("run-2");
      return "ok";
    });

    await expect(call1).rejects.toThrow("boom");
    await expect(call2).resolves.toBe("ok");
    expect(order).toEqual(["run-1", "run-2"]);
  });

  it("cleans up its internal queue entry once a key's chain settles", async () => {
    const lock = createKeyedLock();
    await lock.run("a", async () => undefined);
    // No direct way to inspect the internal map from outside, so this is a
    // behavioral proxy: a fresh call for the same key after full settlement
    // starts immediately rather than waiting on stale state.
    const start = Date.now();
    await lock.run("a", async () => undefined);
    expect(Date.now() - start).toBeLessThan(50);
  });
});
