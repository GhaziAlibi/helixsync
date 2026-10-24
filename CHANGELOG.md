# Changelog

All notable changes to HelixSync are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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
