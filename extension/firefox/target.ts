// How vite.config.ts builds the Firefox package. Manifest V2 with a
// persistent background page, which Firefox never suspends, so the sync
// WebSocket and long imports stay alive without keep-alive tricks. Desktop
// only: Firefox for Android has no bookmarks or history API.
export const firefoxTarget = {
  outDir: "dist-firefox",
  manifest: "firefox/manifest.json",
  platform: "firefox/platform.ts",
  // Firefox's `chrome.*` is callback-only under Manifest V2 (calls return
  // undefined); its `browser.*` is the same API returning promises. Pointing
  // `chrome` at `browser` at the top of every chunk, before any module body
  // runs, lets the shared code's promise-style `chrome.*` calls work.
  banner: 'if (typeof browser !== "undefined" && globalThis.chrome !== browser) globalThis.chrome = browser;',
};
