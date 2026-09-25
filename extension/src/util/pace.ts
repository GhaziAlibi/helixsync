/** Real wall-clock throttle for CPU-heavy background work (history/bulk.ts),
 * sized from a *measured* stretch of synchronous work so that stretch never
 * exceeds `targetCpuFraction` of wall-clock time. Unlike yieldToEventLoop
 * (util/yield.ts), which only reorders *when* work runs relative to other
 * pending callbacks without changing how much of the clock it occupies,
 * this actually lowers the duty cycle Chrome's Task Manager reports for the
 * extension process — at the cost of the paced work taking proportionally
 * longer in wall-clock time (the same trade this file's callers already
 * make elsewhere, e.g. bulk.ts's flat between-chunk delay).
 *
 * Callers pass the wall-clock duration of the work they just did (measured
 * via `Date.now()` before/after), not an estimate — `paceForWork` is a pure
 * function of that measurement. Measuring a span that includes an awaited
 * chrome extension API or fetch IPC round trip (rather than isolating only
 * synchronous CPU time) is deliberately conservative: it can only make this
 * sleep longer than the minimum needed to hit the target, never shorter, so
 * the target stays a real ceiling even though JS has no direct API for
 * actual CPU time. */
// Not a precision target — just "keep this background pass from being a
// visible chunk of the extension's CPU," without stretching a large
// one-time import (see history/bulk.ts) out to many times its unthrottled
// duration. 10% means work is paced with a 9x real-time sleep after it;
// tighten (or loosen) by changing only this constant.
const DEFAULT_TARGET_CPU_FRACTION = 0.1;

let targetCpuFraction = DEFAULT_TARGET_CPU_FRACTION;

/** Real between-work throttle has no place burning real wall-clock time in
 * a unit test — same pattern as history/bulk.ts's
 * setBulkChunkUploadDelayMsForTesting. `1` disables throttling entirely
 * (any measured work is 100% of the allowed duty cycle). */
export function setCpuPaceTargetForTesting(fraction: number): void {
  targetCpuFraction = fraction;
}

// Ceiling on any single paced sleep. A `setTimeout` does not itself count as
// worker activity for MV3's service-worker idle timer (~30s with no
// extension-API call or event), so pacing a long measured span (e.g. an
// entire page's worth of nested work — see history/bulk.ts's per-page
// pacing) with one proportionally long sleep can starve the worker of any
// activity for minutes at a stretch and let Chrome kill it mid-import.
// Capping each individual sleep, rather than the total paced time across a
// pass, keeps every gap short enough that the keep-alive interval
// (history/bulk.ts's collectHistoryBulk) always gets a chance to run before
// the idle timer could fire.
export const PACE_MAX_SLEEP_MS = 5_000;

export function paceForWork(workMs: number): Promise<void> {
  if (workMs <= 0) return Promise.resolve();
  const sleepMs = Math.min(workMs * (1 / targetCpuFraction - 1), PACE_MAX_SLEEP_MS);
  if (sleepMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, sleepMs));
}
