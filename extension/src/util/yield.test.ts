import { describe, expect, it } from "vitest";
import { yieldToEventLoop } from "./yield";

describe("yieldToEventLoop", () => {
  it("resolves", async () => {
    await expect(yieldToEventLoop()).resolves.toBeUndefined();
  });

  it("does not resolve as a microtask (yields to a macrotask instead)", async () => {
    const order: string[] = [];

    const yielded = yieldToEventLoop().then(() => {
      order.push("yield");
    });
    // Queue a bare microtask right after starting the yield. If
    // yieldToEventLoop resolved via the microtask queue, this would race it
    // and outcome would be non-deterministic; since it resolves via a
    // macrotask, every microtask (including chained ones) drains first.
    await Promise.resolve().then(() => {
      order.push("microtask");
    });

    expect(order).toEqual(["microtask"]);

    await yielded;
    expect(order).toEqual(["microtask", "yield"]);
  });

  it("resolves after a setTimeout(0) macrotask scheduled first", async () => {
    // Sanity check that this is genuinely a macrotask-queue yield: a timer
    // queued before it should still get a chance to fire, i.e. the yield
    // doesn't resolve "ahead of" other pending macrotask work.
    const order: string[] = [];

    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        order.push("timeout");
        resolve();
      }, 0),
    );
    const yielded = yieldToEventLoop().then(() => {
      order.push("yield");
    });

    await Promise.all([timer, yielded]);
    expect(order).toContain("timeout");
    expect(order).toContain("yield");
  });
});
