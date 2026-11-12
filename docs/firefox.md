# HelixSync on Firefox

HelixSync runs on Firefox desktop, version 159 or newer, and syncs with
Chromium-based browsers on the same account.

## What's different from Chromium

- **Desktop only.** Firefox for Android has no bookmarks or history API for
  extensions, so the extension can't run there.
- **Bookmarks Menu.** Firefox's Bookmarks Menu syncs like the other built-in
  folders. Chromium has no such folder, so a Chromium browser shows it as a
  **Bookmarks menu** folder in Other bookmarks. That folder appears only once
  something in the menu syncs, and putting a bookmark in it on Chromium puts
  it in the menu on Firefox.
- **Separators.** A Firefox separator syncs as a bookmark pointing to
  `https://separator.floccus.org/`, the same convention as the floccus
  extension. Other Firefox devices turn it back into a separator; Chromium
  shows it as a plain bookmark.
- **History.** Firefox reports redirects and downloads to extensions as
  ordinary visits, so they sync as normal visits.
- **Private windows** are never visible to the extension, as on Chromium.
- **Server permission.** Firefox ignores a site permission that names a
  port, so for a server such as `http://nas.local:8080` the extension asks
  for the whole host (`http://nas.local/*`, every port) instead of that one
  port.

## Build it yourself

```bash
cd extension
npm ci
npm run build:firefox
```

The extension is written to `extension/dist-firefox/`. To try it, open
`about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**
and pick `dist-firefox/manifest.json`. A temporary add-on is removed when
Firefox closes.

The Firefox build is Manifest V2 with a persistent background page
(`extension/firefox/manifest.json`). Firefox doesn't suspend a persistent
page, so the sync connection stays open, as the service worker's does on
Chromium. Everything Firefox-specific is in `extension/firefox/`; the rest is
shared with Chrome (see "Extension" in `CONTRIBUTING.md`).
