// Guards against synced URLs materializing as anything other than a normal
// web page (docs/protocol.md §8.2/§8.4). A remote peer, or a server that
// relabels ciphertext (see F-02), could otherwise supply a `javascript:`
// bookmarklet or another scheme that runs code or reads local state when
// opened via chrome.tabs.create/update or chrome.bookmarks.create/update.
const ALLOWED_SYNCED_URL_SCHEMES = new Set(["http:", "https:"]);

export function isSyncableUrl(url: string): boolean {
  try {
    return ALLOWED_SYNCED_URL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
