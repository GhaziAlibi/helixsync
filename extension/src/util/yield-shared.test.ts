import { describe, expect, it } from "vitest";
import { yieldToEventLoop } from "./yield";

describe("yieldToEventLoop shared channel (perf fix P1)", () => {
  it("resolves many concurrent yields, in FIFO order", async () => {
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        yieldToEventLoop().then(() => {
          order.push(i);
        }),
      ),
    );
    expect(order).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("resolves sequential yields one macrotask at a time without hanging", async () => {
    for (let i = 0; i < 100; i++) {
      await expect(yieldToEventLoop()).resolves.toBeUndefined();
    }
  });

  it("still yields past pending microtasks on a shared channel under load", async () => {
    const order: string[] = [];
    const pending = Array.from({ length: 10 }, (_, i) =>
      yieldToEventLoop().then(() => {
        order.push(`yield-${i}`);
      }),
    );
    await Promise.resolve().then(() => {
      order.push("microtask");
    });
    expect(order).toEqual(["microtask"]);
    await Promise.all(pending);
    expect(order).toHaveLength(11);
  });
});
