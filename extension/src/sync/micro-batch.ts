// Capture listeners push events here so each burst (moving a 100-child
// folder, restoring a window) pays per-flush IndexedDB/crypto overhead once
// instead of per event. Nothing is dropped or merged: every item reaches
// `flush`, in order.
//
// 150ms is longer than Chrome takes to fire a related burst, short enough to
// be imperceptible, and well under MV3's ~30s idle-kill window.
const FLUSH_DELAY_MS = 150;

// One entry per createMicroBatchQueue call; each module calls it once at load.
const pendingFlushes: Array<() => Promise<void>> = [];

/** Best-effort, fire-and-forget flush of every queue from
 * chrome.runtime.onSuspend. The in-memory timers don't survive teardown, so
 * this narrows the loss window, but Chrome may still kill the process before
 * the async writes finish. */
export function flushAllMicroBatchQueues(): void {
  for (const flushNow of pendingFlushes) void flushNow();
}

/** Awaited variant for callers about to read state a still-queued event
 * would otherwise race (e.g. the bookmark backfill's "already mapped" set). */
export async function flushAllMicroBatchQueuesAndWait(): Promise<void> {
  await Promise.all(pendingFlushes.map((flushNow) => flushNow()));
}

/** Returns an `enqueue` that hands the accumulated batch to `flush`
 * FLUSH_DELAY_MS after the first item arrives. The timer is not reset by
 * later pushes, so a steady stream still flushes every FLUSH_DELAY_MS.
 *
 * Time-sensitive checks (e.g. a suppression guard) must happen before
 * `enqueue`; by flush time that window has closed. `flushNow` is idempotent,
 * so an external flush racing the timer can't double-flush. */
export function createMicroBatchQueue<T>(flush: (items: T[]) => Promise<void>): (item: T) => void {
  let queue: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function flushNow(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    try {
      await flush(batch);
    } catch (e) {
      console.error("HelixSync: micro-batch flush failed", e);
    }
  }

  pendingFlushes.push(flushNow);

  return function enqueue(item: T): void {
    queue.push(item);
    if (timer !== undefined) return;
    timer = setTimeout(() => void flushNow(), FLUSH_DELAY_MS);
  };
}
