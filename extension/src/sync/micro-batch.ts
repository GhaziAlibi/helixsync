// Shared by bookmarks/index.ts and tabs/index.ts (EXT-4): both register
// live chrome.* event listeners that turn each event into a local
// operation — WebCrypto signing, a Lamport clock tick, and several
// IndexedDB transactions (mapping/field-state) per event, paid one event
// at a time. A burst of structurally distinct events (moving a bookmark
// folder with 100 children, a bulk tab/window restore) pays that overhead
// once per event instead of once per burst. This is NOT debounce/coalesce
// — nothing is dropped or merged, every pushed item is still delivered to
// `flush`, just together and in original order — only the per-item
// IndexedDB/crypto overhead is amortized by the caller's `flush` batching
// its own writes.
//
// 150ms: comfortably longer than the few ms Chrome takes to fire a whole
// burst of related bookmark/tab events back to back, short enough that a
// single isolated event's added capture latency is imperceptible, and well
// under MV3's ~30s service-worker idle-kill window (the pending timer plus
// the listener callback that armed it both keep the worker alive).
//
// That idle-kill window is itself the reason for `flushAllMicroBatchQueues`
// below: an idle-triggered teardown can land while items are still sitting
// in `queue` waiting out their 150ms timer, and an in-memory setTimeout
// does not survive the teardown, so those items would otherwise be lost
// for good. See that function's doc comment for how this is (partially)
// addressed and its honest limits.
const FLUSH_DELAY_MS = 150;

// Every createMicroBatchQueue instance below registers its own flushNow
// here so a single chrome.runtime.onSuspend listener (background/index.ts)
// can trigger all of them at once right before the service worker is
// killed, rather than each module needing its own onSuspend wiring. Only
// ever grows by one entry per createMicroBatchQueue call — bookmarks/
// history/tabs each call it exactly once, at module load, never repeated —
// so this is a small, fixed-size list, not a per-event leak.
const pendingFlushes: Array<() => Promise<void>> = [];

/** Best-effort last-chance flush of every registered micro-batch queue,
 * called from chrome.runtime.onSuspend right before Chrome tears down the
 * service worker. This narrows, but does not close, the event-loss window:
 * per chrome.runtime.onSuspend's own docs, an extension "should not expect
 * to be able to perform much processing" in that handler, and there is no
 * guarantee the async work each queue's `flush` kicks off here (IndexedDB
 * writes, WebCrypto encryption) completes before the process is actually
 * killed. After this fix, loss is limited to: onSuspend not firing at all,
 * or firing but the browser killing the process before the triggered
 * flush's async work finishes — not a full guarantee. Deliberately
 * fire-and-forget (onSuspend can't await); see `flushAllMicroBatchQueuesAndWait`
 * for callers that need the write to actually land before proceeding. */
export function flushAllMicroBatchQueues(): void {
  for (const flushNow of pendingFlushes) void flushNow();
}

/** Same drain as `flushAllMicroBatchQueues`, but awaited — for callers that
 * are about to read state a pending queued event would otherwise race
 * (e.g. bookmarks/index.ts's `backfillExisting` snapshotting "already
 * mapped" chromium ids right as live capture may still be sitting on an
 * event for one of them). */
export async function flushAllMicroBatchQueuesAndWait(): Promise<void> {
  await Promise.all(pendingFlushes.map((flushNow) => flushNow()));
}

/** Returns an `enqueue` function that accumulates pushed items and hands
 * the whole batch to `flush` once, `FLUSH_DELAY_MS` after the first item of
 * that batch arrives. The timer is armed only by the first item in an
 * otherwise-empty queue and is NOT reset by later pushes — an unbroken
 * stream of events still flushes every `FLUSH_DELAY_MS`, rather than being
 * postponed indefinitely the way a reset-on-push debounce would.
 *
 * Callers are responsible for any synchronous, time-sensitive checks
 * (e.g. a suppression guard) *before* calling `enqueue` — by the time
 * `flush` runs, that window has closed.
 *
 * The instance's `flushNow` is registered into the shared `pendingFlushes`
 * list above so `flushAllMicroBatchQueues`/`flushAllMicroBatchQueuesAndWait`
 * can trigger it externally (e.g. on onSuspend, or before a snapshot read
 * that would otherwise race a still-queued event) in addition to its own
 * timer. `flushNow` is the exact same function for both paths — not
 * duplicated — and is idempotent (clears any pending timer and no-ops on an
 * empty queue), so an external trigger that races the timer's own natural
 * firing can't double-flush or leave stale `queue`/`timer` state. */
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
