/** Cooperatively yields to the event loop via a `MessageChannel` round-trip
 * rather than a microtask (e.g. bare `Promise.resolve()`) or `setTimeout`.
 * A microtask never actually hands control back to pending macrotasks
 * (chrome.* event callbacks, runtime messages from the popup) because the
 * microtask queue always drains completely before the next macrotask runs.
 * `setTimeout(0)` does reach the macrotask queue, but Chromium clamps timer
 * delays in background/service-worker contexts — normally to a 4ms floor,
 * but far higher (up to ~1s) under battery saver or heavy system load. A
 * crypto loop yielding every `CRYPTO_YIELD_CHUNK` items (sync/engine.ts)
 * over a multi-thousand-item batch would then take many times longer than
 * the actual crypto work, risking the service worker being killed mid-pass.
 * `port.postMessage`/`onmessage` schedules a macrotask the same way, but
 * Chromium does not clamp it — the same technique React's scheduler uses
 * for this reason. A fresh channel is created per call rather than reused:
 * this stays correct if two yields are ever in flight concurrently (a
 * shared channel would need a pending-resolver queue to handle that), and
 * the per-call allocation cost is negligible next to the AEAD work it sits
 * between. `scheduler.yield()` would be a more direct fit but isn't
 * established as supported here, so it's not used. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port2.onmessage = () => {
      port1.close();
      port2.close();
      resolve();
    };
    port1.postMessage(undefined);
  });
}
