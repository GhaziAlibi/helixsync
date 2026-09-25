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
 * for this reason. One shared channel serves every call (FIFO resolver
 * queue): each yield posts once and takes one turn, so concurrent yields
 * resolve in order without allocating two ports per call — thousands of
 * yields per bulk crypto pass otherwise churn thousands of channels next
 * to the AEAD work. `scheduler.yield()` would be a more direct fit but isn't
 * established as supported here, so it's not used. */
let sharedPorts: { port1: MessagePort; port2: MessagePort } | undefined;
let pendingResolvers: Array<() => void> = [];

function getSharedChannel(): { port1: MessagePort; port2: MessagePort } {
  if (!sharedPorts) {
    const { port1, port2 } = new MessageChannel();
    port2.onmessage = () => {
      const resolve = pendingResolvers.shift();
      resolve?.();
    };
    sharedPorts = { port1, port2 };
  }
  return sharedPorts;
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    pendingResolvers.push(resolve);
    getSharedChannel().port1.postMessage(undefined);
  });
}
