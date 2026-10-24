/** Wall-clock throttle for CPU-heavy background work: after a measured
 * stretch of `workMs`, sleeps long enough that the work stays within
 * `targetCpuFraction` of wall-clock time. Unlike `yieldToEventLoop`, this
 * actually lowers the duty cycle Chrome reports for the extension process.
 * Measuring spans that include awaited IPC only makes the sleep longer,
 * never shorter, so the target remains a ceiling. */
const DEFAULT_TARGET_CPU_FRACTION = 0.1;

let targetCpuFraction = DEFAULT_TARGET_CPU_FRACTION;

/** `1` disables throttling entirely. */
export function setCpuPaceTargetForTesting(fraction: number): void {
  targetCpuFraction = fraction;
}

// A setTimeout does not count as activity for MV3's ~30s service-worker idle
// timer, so one long sleep could let Chrome kill the worker mid-import.
// Capping each sleep keeps every gap short enough for the bulk import's
// keep-alive interval to run.
export const PACE_MAX_SLEEP_MS = 5_000;

export function paceForWork(workMs: number): Promise<void> {
  if (workMs <= 0) return Promise.resolve();
  const sleepMs = Math.min(workMs * (1 / targetCpuFraction - 1), PACE_MAX_SLEEP_MS);
  if (sleepMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, sleepMs));
}
