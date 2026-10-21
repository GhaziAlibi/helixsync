# Changelog

All notable changes to HelixSync are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may contain
breaking changes).

## [Unreleased]

### Added

- `LOG_FORMAT=json` writes server logs as one JSON object per line.
- The Compose files pass `MAX_DEVICES_PER_ACCOUNT` and
  `AUDIT_LOG_RETENTION_SECS` through, and give the server 40 seconds to stop
  so its graceful shutdown can finish. Every server setting is listed in
  `docs/deployment.md`.
- `THIRD_PARTY_LICENSES.txt` in the server image, the dashboard and the
  extension zip, generated at build time. The server image build fails on a
  dependency license outside `server/about.toml`'s allowlist.

### Changed

- With `BIND_ADDR` unset the server listens on `127.0.0.1:8080` (the Docker
  image sets `0.0.0.0:8080`). An invalid `BIND_ADDR`, or a `BEHIND_PROXY` other
  than `true`/`false`/`1`/`0`, stops it at startup.
- Password change, password recovery and recovery-code regeneration check the
  new salt, KDF parameters and wrapped keys the way registration does.
- Emails over 320 bytes are refused on every route that takes one.

### Fixed

- The extension now moves its Lamport clock past every operation it receives
  (`docs/protocol.md` §4.2). Before, an edit made soon after a change from
  another device arrived could carry an older timestamp than that change; the
  other devices then ignored the edit and stayed out of sync with this one.
  A snapshot resync also keeps each object's real ordering key now.
- Open tabs never synced in Chromium-based browsers. Tab capture registered
  `tabs.onUpdated` with a filter only Firefox supports, so Chromium threw and
  capture stopped there. A new tab was also skipped because Chromium reports it
  before it has a URL, and later changes to it were dropped. Tabs now sync
  once they have a URL, including tabs already open when tab sync is turned on.
- Tab groups never synced: the optional `tabGroups` permission was never
  requested, and a group's first change was sent as an update, which the
  server refuses for an object it never saw created. Saving the popup's
  settings with Tab Groups on now asks for the permission, and a new group is
  sent as a create.
- The popup's settings form could undo a change made on another device or the
  dashboard: it showed settings cached for up to a minute and saved every
  field back. It now loads them fresh, saves only the fields changed in it,
  and keeps Save disabled until they have loaded (a Save before then sent
  every switch as off).

### Security

- Updated `rustls-webpki` to 0.103.16 (RUSTSEC-2026-0382) and `webpki-roots`
  to 1.0.10 (RUSTSEC-2026-0381).

## [0.4.0] - 2026-10-03

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
  encrypted at rest.
- Web dashboard: sync health and storage use, devices (rename, revoke), sync
  settings, web sessions, password change, recovery code, and account
  deletion.
- Server (Rust, PostgreSQL): `ALLOW_REGISTRATION` to close sign-ups, a
  per-account storage quota (`MAX_ACCOUNT_STORAGE_BYTES`) and device cap
  (`MAX_DEVICES_PER_ACCOUNT`), rate limiting, an audit log, and WebSocket
  change notifications.
- Deployment with Docker Compose (prebuilt or source-built images), Portainer,
  a reverse proxy with HTTPS, or without Docker (`README.md`,
  `docs/deployment.md`). The dashboard is served with a strict
  Content-Security-Policy and related security headers.

[Unreleased]: https://github.com/GhaziAlibi/helixsync/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/GhaziAlibi/helixsync/releases/tag/v0.4.0
