// Limits of send-tab (docs/protocol.md §12.5). The server enforces the rate
// and the envelope size; the rest are this extension's own.

/** Largest envelope the server accepts, in bytes of its JSON. */
export const MAX_ENVELOPE_BYTES = 8 * 1024;
/** A received tab older than this (by its `sentAt`) is dropped, which is also
 * how long an id stays in the replay list. */
export const REPLAY_WINDOW_MS = 10 * 60_000;
/** Tabs this device opens per minute at most, so a compromised peer can't
 * flood the browser with tabs. */
export const RECEIVE_LIMIT_PER_MINUTE = 10;
/** Longest title sent; it is only shown in a notification. */
export const MAX_TITLE_CHARS = 200;
