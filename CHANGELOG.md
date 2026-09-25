# Changelog

All notable changes to HelixSync are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may contain
breaking changes).

## [Unreleased]

## [0.3.2] - 2026-10-02

A security hardening release that also changes the defaults and the on-wire
encryption format. It contains **breaking changes**; read the upgrade notes
first.

### Upgrade notes (breaking)

There is no migration path from earlier versions: start with an empty database
and reconnect every browser.

- **Encryption envelope is now `v: 2`, and older data is unreadable.** Every
  AAD-bound ciphertext (operation payloads, snapshot objects, bulk-history
  segments) is stamped `v: 2`, and clients decrypt exactly that version. There
  is deliberately no fallback to the earlier `v: 1` format: it had no
  associated data, so reading it would permanently allow a server to relabel
  those ciphertexts. A client that meets an envelope version it doesn't
  understand now stops syncing with an "update the HelixSync extension" error
  instead of silently skipping the data (see `docs/encryption.md` §5-6).
- **The database schema is a single baseline migration,**
  `server/migrations/0001_init.sql`. A database created by an earlier build is
  not compatible. From here on, schema changes are new numbered migrations.
- **The extension wipes its local device record on upgrade.** The IndexedDB
  schema moved to v8, which encrypts the account key and refresh token at rest
  and clears any record stored in plaintext. Reconnect (sign in again from the
  popup) once after updating.
- **`REQUIRE_ENCRYPTION` now defaults to on.** An unset variable used to mean
  off. Only an explicit `false` or `0` disables it; any other unrecognised value
  now fails startup instead of being guessed at. Deployments that relied on the
  old default for unencrypted testing must set `REQUIRE_ENCRYPTION=false`.
- **`JWT_SIGNING_KEY` is rejected if it contains `change-me` or `replace-me`**
  (case-insensitive), not only the exact placeholder from `.env.example`.
- **`docker-compose.prod.yml` requires `HELIXSYNC_VERSION`.** It no longer falls
  back to `latest`: the stack refuses to start until the variable is set (for
  example in `.env`) to a released version such as `0.3.2`.

### Added

- Server: `DELETE /api/v1/auth/account` permanently deletes an account and all
  of its data. It needs a CSRF-protected session and the account's current
  `authKey`, is rate limited, and is audited (`account_deleted`,
  `account_delete_failed`).
- Server: `POST /api/v1/devices/self/revoke` lets a device revoke itself with
  its own access token (audited as `device_self_revoked`).
- Server: new environment variable `ALLOW_REGISTRATION` (default `true`). When
  `false`, `POST /api/v1/auth/register` returns `403` with error code
  `registration_disabled`, and `GET /api/v1/version` reports
  `registrationEnabled: false`. Set it to `false` on any internet-reachable
  instance once your accounts exist.
- Server: `MAX_ACCOUNT_STORAGE_BYTES` (default 5 GiB) is now passed through the
  Compose files and documented; `server/.env.example` for local development.
- Extension: Disconnect now revokes the device on the server (best effort, with
  a short timeout; it still disconnects locally if the server is unreachable).
- Web dashboard: "Danger zone" account deletion; a confirm-password field and a
  required "I understand HelixSync can never recover my password or data"
  acknowledgement when registering; the register option is hidden when the
  server has registration disabled; a banner when the dashboard is loaded over
  plain HTTP from a non-loopback host.
- Web dashboard: automated tests (crypto, REST client), run with `npm test`.
- Web image: strict `Content-Security-Policy`, `Permissions-Policy`, and
  `Strict-Transport-Security` when the TLS proxy reports HTTPS.
- Documentation: a rewritten README with several deployment options, a threat
  model and extension-surface section in `docs/security.md`, and
  `docs/releasing.md`.

### Changed

- The prelogin fake-salt HMAC now uses a purpose-specific subkey derived from
  the signing key, so its output can never coincide with a token signature.
- `GET` and `PATCH /api/v1/sync/settings` report the effective
  `requireEncryption` (server flag or per-user column). The dashboard used to
  always claim encryption was not enforced.
- The release workflow is gated on CI, pins every third-party action by commit
  SHA, runs no third-party action in a job that can write to the repository,
  and publishes to the Chrome Web Store from its own job in a protected
  environment. See `docs/releasing.md` for the one-time repository setup.
- The Chrome Web Store publish uses `STAGED_PUBLISH`: once the store approves an
  upload it is staged, and releasing it to users is a manual click in the Web
  Store developer dashboard. Release jobs are also serialised per job rather
  than per workflow run, so a publish waiting for approval does not block the
  rest of the run.
- Base images (Rust, Debian, Node, nginx, Postgres) are pinned by digest in the
  Dockerfiles and compose files, with the tag kept for readability.
- Extension: the background message handler ignores any message that does not
  come from the extension itself.
- nginx: security headers live in one snippet included in every location (they
  were lost on `/assets/`), and `index.html` is served with `Cache-Control:
  no-cache`.
- `react-router-dom` upgraded to 7.x (GHSA-wrjc-x8rr-h8h6); `rustls` to 0.23.45
  (RUSTSEC-2026-0285).
- Documentation brought in line with the implementation: password changes only
  re-wrap the account key, CSRF protection is `SameSite=Lax` plus a double-submit
  token (there is no Origin/Referer check), and the deployment guide now states
  the HTTPS requirement.
- Extension: a newly connected device now pulls what the account already holds as
  soon as its initial import has finished. Before, nothing prompted that first
  pull (the server's push announces only later changes), so it waited for the
  next periodic sync, up to five minutes away.
- Extension: history synced from other devices is now added to the browser's own
  history, so it appears in `chrome://history` and address-bar suggestions.
  Chrome can only record such a visit as "now" with no title, so synced entries
  are dated when they were synced and untitled until the page is opened. Each
  distinct `http`/`https` URL is added once, oldest first, and a URL the browser
  already has is skipped. The visit event this write causes is recognised and
  never uploaded. See `docs/protocol.md` §8.3.1.
- Server: upgraded to axum 0.8 (with axum-extra 0.12), `jsonwebtoken` 11, `hmac`
  0.13 and `sha2` 0.11. The API, the stored session and credential hashes, and
  already-issued access tokens are unaffected. `jsonwebtoken` 11 needs an
  explicit crypto backend, so the server enables its pure-Rust `rust_crypto`
  backend (HS256 only is used).
- Web dashboard: React 19 and vite 8.
- Development tooling: vitest 5 and `@types/chrome` 0.3 (and vite 6.4 for the
  extension). **Contributors now need Node.js 22.12 or newer**; CI runs on Node
  22.

### Fixed

- The extension silently dropped bulk history imports from other devices: the
  sync engine tried to decrypt the plaintext bulk container as if it were a
  single envelope.
- Version-skewed clients no longer lose data silently: an undecryptable-because-
  unsupported envelope now halts sync and is retried after an update.
- Extension: a download that took a while to apply could roll back the device's
  operation sequence counter. Anything captured meanwhile (for example pages you
  visited during a first sync, now that history is replayed into the browser) had
  its sequence number reused, and the server rejected those operations as
  `sequence_out_of_order`, so they were dropped and never synced. The cursor and
  timestamps are now merged into the stored sync state atomically instead of
  writing back a copy read earlier.

### Removed

- The unused `@noble/curves` dependency.

### Security

- Encrypted payloads are bound to their object type, object ID and operation
  type through the AEAD's associated data, so a server can no longer relabel or
  splice ciphertexts without detection.
- Registration can be closed (`ALLOW_REGISTRATION=false`) and each account has a
  storage quota.
- Users can delete their account, and a disconnected device revokes itself.
- The dashboard is served with a strict Content-Security-Policy and related
  headers; the extension encrypts its account key and refresh token at rest and
  accepts only `http(s)` URLs from other devices.
- The signing-key placeholder check, logout CSRF check and an overflow in the
  history-count sum were fixed.
- The release pipeline and container images are hardened as described under
  Changed.

[Unreleased]: https://github.com/GhaziAlibi/helixsync/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/GhaziAlibi/helixsync/releases/tag/v0.3.2
