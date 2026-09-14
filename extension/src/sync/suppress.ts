// Reentrancy guard against a remote-apply's own chrome.* mutation echoing
// straight back into local capture as a brand-new operation. Chrome's
// extension APIs give no way to tell "this event was caused by our own
// call" from "this event was caused by the user/another extension" — the
// standard mitigation (used by e.g. Floccus-style sync extensions) is to
// mark a short synchronous window around our own mutating call and have
// the paired capture listener check it before turning the event into an
// operation.
//
// This only covers the discrete, single-event mutations (create/update/
// move/remove) that fire their corresponding event synchronously around
// the mutating call resolving. It does NOT cover multi-stage async
// follow-on events a mutation can indirectly cause later (e.g. a tab
// navigation's own "loading" -> "complete" onUpdated sequence after
// chrome.tabs.update sets a new url) — callers that face that
// (tabs/index.ts) pair this guard with a value-equality check against the
// already-recorded field state as a second, timing-independent backstop.
//
// One instance per object-type module (bookmarks/history/tabs each create
// their own) rather than a single global guard: a remote apply for one
// object type only ever calls that type's own chrome.* surface, so scoping
// per module avoids one type's mutation accidentally suppressing another
// type's unrelated concurrent event.
export function createSuppressionGuard() {
  let depth = 0;
  return {
    isSuppressed(): boolean {
      return depth > 0;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      depth++;
      try {
        return await fn();
      } finally {
        depth--;
      }
    },
  };
}
