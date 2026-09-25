import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PACE_MAX_SLEEP_MS, paceForWork, setCpuPaceTargetForTesting } from "./pace";

// fix.md §2 fix D: a long measured span (e.g. a whole page's worth of
// nested work) must not produce one unbounded setTimeout sleep — that lets
// MV3 idle-kill the service worker mid-import (~30s with no extension-API
// activity). PACE_MAX_SLEEP_MS caps every individual sleep regardless of
// how large the measured work span was.
describe("paceForWork sleep clamp (fix D)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setCpuPaceTargetForTesting(1);
  });

  it("resolves after at most PACE_MAX_SLEEP_MS even for a very large measured work span", async () => {
    // Default target (10%) would otherwise compute a 9,000,000ms sleep for
    // this much measured work.
    setCpuPaceTargetForTesting(0.1);
    const resolved = vi.fn();
    void paceForWork(1_000_000).then(resolved);

    await vi.advanceTimersByTimeAsync(PACE_MAX_SLEEP_MS - 1);
    expect(resolved).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("still resolves immediately for zero or negative work", async () => {
    await expect(paceForWork(0)).resolves.toBeUndefined();
    await expect(paceForWork(-5)).resolves.toBeUndefined();
  });

  it("a small work span under the clamp is unaffected", async () => {
    setCpuPaceTargetForTesting(0.5); // sleepMs = workMs * (1/0.5 - 1) = workMs
    const resolved = vi.fn();
    void paceForWork(100).then(resolved);

    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toHaveBeenCalledTimes(1);
  });
});
