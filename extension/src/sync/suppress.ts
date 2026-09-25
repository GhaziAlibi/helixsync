// Stops a remote-apply's own chrome.* mutation from echoing back into local
// capture as a new operation. Chrome's events don't say who caused them, so
// our mutating calls run inside `run` and capture listeners check
// `isSuppressed()` synchronously at event-fire time.
//
// This only covers events fired synchronously around the mutating call.
// Later async follow-ups (e.g. a tab's "loading" -> "complete" onUpdated
// sequence after chrome.tabs.update) must also be caught by a value-equality
// check against the recorded field state (see tabs/index.ts).
//
// Each object-type module creates its own guard so one type's mutation
// can't suppress another type's unrelated event.
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
