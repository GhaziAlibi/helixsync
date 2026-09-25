/** Subscribes to chrome.storage.session changes made by any extension
 * context (popup or service worker). A no-op where the event surface is
 * missing, e.g. tests without a `chrome` global; callers keep explicit
 * invalidators for that case. */
export function addSessionStorageChangeListener(listener: (changes: Record<string, unknown>) => void): void {
  try {
    (globalThis as { chrome?: typeof chrome }).chrome?.storage?.session?.onChanged?.addListener(listener);
  } catch {
    // No session event surface.
  }
}
