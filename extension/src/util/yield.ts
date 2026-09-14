/** Cooperatively yields to the event loop via `setTimeout(0)` rather than a
 * microtask (e.g. bare `Promise.resolve()`) — a microtask never actually
 * hands control back to pending macrotasks (chrome.* event callbacks,
 * runtime messages from the popup) because the microtask queue always
 * drains completely before the next macrotask runs. `setTimeout` is used
 * elsewhere in this codebase (sync/micro-batch.ts's `FLUSH_DELAY_MS`) as
 * the proven-supported way to schedule work in the MV3 service worker
 * context; `scheduler.yield()` would be a more direct fit but isn't
 * established as supported here, so it's not used. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
