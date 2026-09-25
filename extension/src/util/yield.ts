/** Yields to the event loop via a MessageChannel round trip, letting pending
 * macrotasks (chrome.* events, popup messages) run. A microtask never yields
 * to macrotasks, and Chromium clamps setTimeout in service workers (4ms, up
 * to ~1s under battery saver), which would stretch long crypto loops enough
 * to risk the worker being killed. MessageChannel is not clamped. One shared
 * channel with a FIFO resolver queue avoids allocating ports per call. */
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
