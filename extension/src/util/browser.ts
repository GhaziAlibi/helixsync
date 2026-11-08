// Which browser engine runs the extension. Firefox serves extension pages
// from moz-extension:// (the Chromium ones from chrome-extension://).
export function isFirefox(): boolean {
  return (globalThis as { location?: { protocol?: string } }).location?.protocol === "moz-extension:";
}

type BadgeApi = Pick<typeof chrome.action, "setBadgeText">;

/** The toolbar button API: `chrome.action` (MV3), or `browserAction` in the
 * Firefox MV2 build. */
export function toolbarAction(): BadgeApi {
  const api = chrome as unknown as { action?: BadgeApi; browserAction?: BadgeApi };
  return (api.action ?? api.browserAction)!;
}
