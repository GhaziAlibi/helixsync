// `@types/chrome` describes event payloads inline instead of exporting named
// types for them. These aliases are derived from the event signatures, so they
// track whatever the typings declare.
type ListenerArgs<E> = E extends chrome.events.Event<infer F extends (...args: any) => void>
  ? Parameters<F>
  : never;

export type BookmarkRemoveInfo = ListenerArgs<typeof chrome.bookmarks.onRemoved>[1];
export type BookmarkChangeInfo = ListenerArgs<typeof chrome.bookmarks.onChanged>[1];
export type BookmarkMoveInfo = ListenerArgs<typeof chrome.bookmarks.onMoved>[1];
export type TabChangeInfo = ListenerArgs<typeof chrome.tabs.onUpdated>[1];
export type TabActiveInfo = ListenerArgs<typeof chrome.tabs.onActivated>[0];
