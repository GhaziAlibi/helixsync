# Changelog

All notable changes to HelixSync are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Selective sync: rulesets.** In the web dashboard (new **Rulesets** page, needs
  the Vault unlocked) you create rulesets, named lists of rules, and assign devices
  to them; each device enforces the combined rules of all its rulesets. Rules: don't
  sync a bookmark folder, only sync chosen folders, block a domain (and its
  subdomains), block addresses matching a regular expression, block local and
  development addresses. Folders are picked from your decrypted bookmarks. The page
  also shows, per device, its rulesets and which rule blocks an address you type.
  Every account has a **Default** ruleset (empty, can't be deleted) that every new
  device joins; existing accounts and devices get it from the migration, so nothing
  changes until you add rules. Rulesets are end to end encrypted with the account key
  (new AAD, `docs/encryption.md` §6.5); the server stores ciphertext and which devices
  are assigned. This is the first time the dashboard encrypts anything. History
  filtering covers live capture, the first import (with a resume guard that restarts
  the scope when the rules changed) and replay of other devices' visits; bookmark
  filtering covers capture, the first import, remote apply, moves in and out of an
  excluded folder, bookmark restore points and mass-delete detection. Excluding a
  folder that already syncs freezes it on that device; nothing is deleted, and rules
  are forward-only. Lifting a rule catches the device up without creating duplicates.
  The popup shows the device's rulesets, read-only. Extensions older than this
  release ignore rulesets; the dashboard flags assigned devices that are too old. New
  migration `0004_rulesets.sql` (additive: two tables and a backfill), new endpoints
  under `/api/v1/rulesets`, a `ruleset_changed` WebSocket frame and `"rulesets": true`
  in `GET /api/v1/version`. See `docs/protocol.md` §17, `docs/encryption.md` §6.5 and
  `PRIVACY.md`.

## [1.1.0] - 2026-11-17

### Added

- Read-only **Vault** page in the web dashboard (and installable as a PWA): shows
  and searches your bookmarks (folder tree), history (newest first) and open
  tabs (by device, window and tab group), decrypted in the browser, for phones
  and locked-down computers where the extension can't be installed. Nothing can
  be changed from it. The web is not a device: it uses the dashboard session,
  and `GET /api/v1/sync/snapshot` now accepts the session cookie (read-only;
  `/sync/changes` and `/sync/operations` still need a device, and no device row
  or `last_seen_at` is touched). The account key is kept from login in memory
  only (a reload asks for the password again), and the key and all plaintext
  are dropped after 5 minutes idle and on logout. Nothing is written to
  `localStorage`, `sessionStorage`, IndexedDB or a cache, and there is no
  service worker. See `docs/security.md` §10 and `docs/encryption.md` §8.

- `GET /api/v1/sync/snapshot` now gives an encrypted bookmark, folder, tab,
  window or tab group its earlier operations as `layers` (since its latest
  `create` or `restore`, at most 8 per operation type), because the server
  can't merge ciphertext and the object's own payload may be a partial
  `update`, `move` or `activate`. Additive: the object's fields are unchanged,
  clients that don't know `layers` ignore it, there is no migration, and stored
  snapshots stay readable. Objects already folded into a stored snapshot by an
  older server have lost those operations, and the Vault says how many items it
  leaves out for that reason. The extension does not use `layers` yet. See
  `docs/protocol.md` §10.3.

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

- Automated database backups (server). On by default once
  `BACKUP_ENCRYPTION_KEY` is set (`BACKUP_ENABLED=false` turns it off; without a
  key, or with one too short or still a placeholder, the server starts as
  before, with backups off and a warning). The server
  then writes an encrypted dump of the whole database into the new `helix-backup`
  volume (`/backups`) on a cron schedule (`BACKUP_CRON`, daily at 03:00 UTC by
  default) and keeps the newest `BACKUP_KEEP_LAST` scheduled files (manual and
  pre-restore files are never deleted automatically). Files are
  `psql`-loadable scripts compressed with zstd and encrypted with age under
  `BACKUP_ENCRYPTION_KEY` (required, 32 characters or more). Operator commands:
  `helixsync-server backup-now`, `list-backups` and `restore-backup [<file>]`;
  a restore needs the server stopped, checks the whole file first, writes a
  safety backup of the current data and loads in one transaction. The dashboard gets a read-only **Backups** page (`GET
  /api/v1/backups`, advertised as `backups` in `/version`) with the schedule,
  the files and the history of recent runs; with no admin role, every account
  on the server sees it. Starting and restoring stay commands on the host.
  Upgrade note: both Compose files now
  mount the `helix-backup` volume on `server`; set `BACKUP_ENCRYPTION_KEY` to
  start taking backups. See `docs/deployment.md`, "Backups".

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
