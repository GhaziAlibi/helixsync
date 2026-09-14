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
const FLUSH_DELAY_MS = 150;

/** Returns an `enqueue` function that accumulates pushed items and hands
 * the whole batch to `flush` once, `FLUSH_DELAY_MS` after the first item of
 * that batch arrives. The timer is armed only by the first item in an
 * otherwise-empty queue and is NOT reset by later pushes — an unbroken
 * stream of events still flushes every `FLUSH_DELAY_MS`, rather than being
 * postponed indefinitely the way a reset-on-push debounce would.
 *
 * Callers are responsible for any synchronous, time-sensitive checks
 * (e.g. a suppression guard) *before* calling `enqueue` — by the time
 * `flush` runs, that window has closed. */
export function createMicroBatchQueue<T>(flush: (items: T[]) => Promise<void>): (item: T) => void {
  let queue: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  return function enqueue(item: T): void {
    queue.push(item);
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      const batch = queue;
      queue = [];
      flush(batch).catch((e) => console.error("HelixSync: micro-batch flush failed", e));
    }, FLUSH_DELAY_MS);
  };
}
