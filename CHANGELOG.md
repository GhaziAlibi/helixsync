# Changelog

All notable changes to HelixSync are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Send tab to device. Right-click a page or a link (or use the popup) and pick
  another of your devices: the page opens there at once, in the focused window.
  The address is encrypted on your device and the server only relays it to the
  target's open connection; nothing is stored, so an offline device is reported
  as offline and misses it. Needs the new server (`/version` advertises
  `sendTab`; the feature stays hidden otherwise) and adds the `contextMenus`
  permission, plus an optional `notifications` one behind a popup toggle. The
  receiving extension opens only `http:`/`https:` addresses, ignores replays
  and stale tabs, and opens at most 10 a minute. See `docs/protocol.md` §12.5.
  `GET /api/v1/devices` also reports which devices are `online`.

- Firefox support (desktop, 159 or newer). `npm run build:firefox` builds a
  Manifest V2 package with a persistent background page into
  `extension/dist-firefox/`, and releases attach it as
  `helixsync-extension-firefox-<version>.zip`. Firefox's built-in bookmark
  folders map to the same synced roots as Chromium's; its Bookmarks Menu
  shows on Chromium as a "Bookmarks menu" folder, made only once something
  in it syncs; separators sync as `https://separator.floccus.org/` bookmarks
  (floccus's convention). See `docs/firefox.md`. It is published on
  addons.mozilla.org as `helixsync@ghazialibi.github.io`; releases submit
  each changed version there automatically.

- Per-browser releases. Browser-specific extension code moved to
  `extension/chrome/` and `extension/firefox/`; releases attach, and publish
  to the Chrome Web Store, only the packages that changed since the last
  release.

- Interface languages. The web dashboard and the extension popup now follow
  the browser's language and can be switched by hand (dashboard sidebar, popup
  settings): English, Hungarian, German, Spanish, French, Simplified Chinese
  and Arabic (shown right to left). The recovery kit is written in the chosen
  language. The server is unchanged; it still sends English messages, which
  the clients replace with translated ones.

### Fixed

- A tab closed on this browser while a change to it from another device was
  being applied could stay open on the other devices.
- Tabs already open were not uploaded after disconnecting and reconnecting in
  Firefox until they changed.
- Bookmarks received for the Bookmarks menu folder before it could be made
  were not applied until another bookmark arrived for it; they now are when
  the extension starts.
- Releases attach a browser's package only after its store publish did not
  fail, so a failed or rejected publish is retried by the next release.
- The extension could treat a connected browser as disconnected when it
  started: reading the saved login fired a session-storage event that cleared
  it before it was returned. Firefox always hit this, so its first sync never
  finished after a restart and its own bookmarks were never uploaded.
- A tab opened on one browser could open twice on the others under
  "Restore automatically": a new tab's create and first update arrived
  together and were each opened. Overlapping captures of one new tab could
  also send it twice.
- Changing the language in the extension's settings and leaving without
  saving kept a copy of the whole form, so a later Save could undo settings
  changed meanwhile on another browser or the dashboard. Only the fields you
  changed are kept now. The language selector there also works before the
  settings finish loading.
- A browser whose device was revoked, or whose account was deleted, showed a
  generic sync error; it now shows "Needs re-authorization".
- Before connecting, and after Disconnect, the extension no longer logs
  errors about having no device.
- After a restore finished, the popup's Restore points view kept showing it,
  and Done led back to it; Done now returns to the list.
- A tab closed while another browser updated it stopped the whole sync; it
  now stays closed and sync carries on.

## [1.0.10] - 2026-11-05

### Added

- Safer account recovery. The dashboard now makes you type your recovery code
  back before it continues, offers a printable recovery kit (or a `.txt`),
  and shows a banner until the current code is confirmed. A forgotten
  password can also be reset when two different connected extensions approve
  (the extension marks it PASSWORD RESET and shows "1 of 2 approvals"), and a
  passkey (fingerprint, OS PIN, phone or security key) can seal the recovery
  code, with a rescue file kept outside the browser. Nothing new secret is
  stored on the server. The server adds migration `0003_recovery_safeguards.sql`
  (a nullable column, a wider CHECK and a new table); it is additive and runs
  automatically.

## [1.0.8] - 2026-11-05

### Added

- Bookmark restore points: timestamped, encrypted snapshots of your bookmarks
  that you can roll back to, in full or for one folder, either by merging
  (bring back what is missing, undo edits, delete nothing) or exactly (also
  remove bookmarks the point doesn't have). Points are made on demand, daily,
  and before a restore, a first import, a full resync, or a large deletion;
  unpinned ones are removed oldest first when space runs out, and after 90
  days; only pinned ones are kept for good. They are managed from the extension
  popup and the dashboard's new Restore points page; the server only ever
  holds ciphertext. New server settings: `RESTORE_POINT_MAX_BYTES` (capped at 2 GiB − 1),
  `RESTORE_POINT_MAX_ACCOUNT_BYTES`, `RESTORE_POINT_MAX_PER_ACCOUNT`,
  `RESTORE_POINT_MAX_PINNED`, `RESTORE_POINT_RETENTION_DAYS` and
  `RESTORE_POINT_SCHEDULED_MIN_INTERVAL_SECS`. The server adds migration
  `0002_restore_points.sql`; it is additive and runs automatically.
- Bookmark sync on Chromium-based browsers for Android, such as Bare. Android
  hides an empty Bookmarks bar and Other bookmarks from extensions, and
  desktop hides an empty Mobile bookmarks, so the extension keeps a folder
  of that name inside a shown one (Mobile bookmarks on Android, Other
  bookmarks on desktop) until the real one is shown again. Removing that
  folder brings it back with its contents.

### Fixed

- Deleting a bookmark folder left the bookmarks inside it linked to nodes that
  no longer existed, so restoring one of them from another device created
  nothing. A deleted folder now releases everything inside it, and a restored
  bookmark is created even when an older link to a deleted node is left. A
  device that predates this fix still has the old problem until it is updated:
  it won't re-create the children of a restored folder.
- Connecting a browser that already has some of the account's bookmarks,
  including disconnecting and reconnecting the same browser, no longer
  duplicates them on every device: the extension downloads the account
  first and links matching bookmarks (same folder, title and URL) instead of
  uploading them again. Duplicates made before this fix stay until removed
  in one browser.
- A bookmark moved further down within its own folder by another device no
  longer lands one place too early.

## [1.0.0] - 2026-10-24

Initial release. HelixSync is a self-hosted, end-to-end encrypted sync server
for Helium and other Chromium-based browsers.

### Added

- Sync of bookmarks (including folders and moves), history (added to each
  browser's own history), and optionally open tabs, windows and tab groups,
  across your own devices through a server you run. Conflicts are resolved
  from an operation log instead of last-write-wins (`docs/protocol.md`).
- End-to-end encryption: the password never leaves your devices, and the
  server stores only ciphertext, bound to its object by the AEAD's associated
  data (`docs/encryption.md`). `REQUIRE_ENCRYPTION` (on by default) makes the
  server refuse unencrypted data.
- Account recovery, modeled on Bitwarden (`docs/encryption.md` §9):
  - a recovery code, shown once at registration, resets a forgotten password
    without losing data. Each code works once, and the Security page
    generates a new one;
  - login with device: the dashboard or a new browser signs in once a
    connected extension approves it, after both show the same phrase;
  - `helixsync-server delete-account <email>` lets the operator delete an
    account whose owner lost both the password and the recovery code.
- Browser extension (Manifest V3, Chromium 116 or newer): connect with the
  password or by approval from another browser; sync status and settings, tab
  restore (disabled, ask, or automatic) and history retention; Disconnect
  revokes the device on the server. The account key and refresh token are
  encrypted at rest. After widening history retention, the popup offers "Sync
  older history" once, which imports this browser's history older than what
  was already imported.
- Web dashboard: sync health and storage use, devices (rename, revoke), sync
  settings, web sessions, password change, recovery code, and account
  deletion.
- Server (Rust, PostgreSQL): `ALLOW_REGISTRATION` to close sign-ups, a
  per-account storage quota (`MAX_ACCOUNT_STORAGE_BYTES`) and device cap
  (`MAX_DEVICES_PER_ACCOUNT`), rate limiting, an audit log, and WebSocket
  change notifications. With `BIND_ADDR` unset it listens on
  `127.0.0.1:8080` (the Docker image sets `0.0.0.0:8080`), and
  `LOG_FORMAT=json` writes logs as one JSON object per line.
- Deployment with Docker Compose (prebuilt or source-built images), Portainer,
  a reverse proxy with HTTPS, or without Docker (`README.md`,
  `docs/deployment.md`, which lists every server setting). The dashboard is
  served with a strict Content-Security-Policy and related security headers.
- `THIRD_PARTY_LICENSES.txt` in the server image, the dashboard and the
  extension zip, generated at build time. The server image build fails on a
  dependency license outside `server/about.toml`'s allowlist.

[1.0.0]: https://github.com/GhaziAlibi/helixsync/releases/tag/v1.0.0
