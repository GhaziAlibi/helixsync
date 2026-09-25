# HelixSync Security Model

This document describes how HelixSync authenticates users and devices, what it
protects against, and where its limits are. The encryption design is in
[`encryption.md`](encryption.md); to report a vulnerability, see
[`SECURITY.md`](../SECURITY.md).

## Overview and threat model

HelixSync assumes the network is hostile and that the **server may be curious
or compromised**. It does not assume the user's own browser profile is
compromised: an attacker who controls a signed-in device can do what that device
can do.

| Party | What they can do | What they cannot do |
|-------|------------------|---------------------|
| Network attacker | Nothing useful over HTTPS | Read or alter traffic, or learn credentials, when the deployment follows [`deployment.md`](deployment.md) |
| Server operator, or anyone with database or process access | See account metadata: email, device names and platform, the IP address and user agent of dashboard sessions, object types and IDs, operation types, timestamps, payload sizes and hourly history-visit counts ([`protocol.md`](protocol.md) §8.3.2). Withhold or delete data. Serve a modified dashboard (§10) | Read bookmark, history or tab content; forge content that was never encrypted under the account key; relabel or splice ciphertexts undetected ([`encryption.md`](encryption.md) §6) |
| Someone holding a database backup | The same metadata as above, plus each account's stored password hash and wrapped account key, which allow offline password guessing at the cost of the Argon2id parameters | Read synced data without the password |
| Someone who knows the account password | Decrypt everything and connect any device ([`encryption.md`](encryption.md) §3) | n/a |
| Someone with a stolen device access token | Act as that device on the sync API until it is revoked (§1.2): upload and download ciphertext, change sync settings | Decrypt anything (the account key is stored apart from the token), or reach account endpoints such as password change and deletion, which need a web session and the `authKey` |

Everything the server is trusted with, and nothing more, is enforced on the
server side (§3). Known limits of this model are listed in §10.

## 1. Authentication Layers

```text
Account (email + Argon2id password, web session)
   -> Device (registered against an account, own identity)
      -> Device credentials (short-lived access token + rotating refresh token)
```

Account authentication (web UI) and device authentication (extension API /
WebSocket) are deliberately separate. The extension never uses the web
session cookie; it always authenticates with a device-bound bearer token.

### 1.1 Account authentication

- The server never receives the account password
  (`docs/encryption.md` §1-2): the client derives `authKey` from it
  client-side and sends that instead of the password in every request that
  would otherwise carry one (register, login, device registration, password
  change). This
  isn't just defense-in-depth — the server structurally cannot derive the
  E2E encryption key, since it never sees the password, the master key it
  derives, or the key-encryption key wrapping the account key.
- Limit: a hacked server can change the dashboard's login page to steal
  the password. See `docs/encryption.md` §8.
- `authKey` hashing: Argon2id. The hash is stored as a PHC string, which
  carries its own parameters (memory/time/parallelism), so the cost can be
  raised for new hashes without invalidating existing ones.
- Web session: HTTP-only, `Secure`, `SameSite=Lax` cookie carrying an opaque
  session identifier; the session row is server-side state (`web_sessions`)
  so it can be revoked (§ "Active sessions" UI).
- Rotating refresh token for the web session, separate from the device
  refresh token model.
- A successful password change revokes every other active web session for
  the account in the same request (a stolen session cookie must not keep
  working after the password changes) — see `docs/encryption.md` §4.

### 1.2 Device registration and credentials

See `docs/protocol.md` §7. Device credentials:

- Access token: short-lived (default 15 minutes), JWT-like signed token
  containing `deviceId`, `userId`, `exp`, validated with a server-held
  signing key (HMAC-SHA256 minimum; server config may use a stronger key).
- Refresh token: opaque random value, stored server-side only as a hash
  (`device_credentials.credential_hash`), rotated on every use (old value
  invalidated the moment a new one is issued), bound to `deviceId`, never
  logged, revocable independently of the account.
- Device revocation immediately invalidates all outstanding access/refresh
  tokens for that device (checked via `devices.revoked_at` on every
  request, not just at token issuance). It can be done from the dashboard
  (`POST /devices/:id/revoke`, session plus CSRF token) or by the device
  itself (`POST /devices/self/revoke`, authenticated with its own bearer
  token), which is what the extension's Disconnect does, so a disconnected
  device doesn't linger on the account. Both revoke the device row and every
  credential, update the in-memory revocation cache at once, and close the
  device's WebSocket.

### 1.3 WebSocket authentication

The WebSocket endpoint requires the device access token, sent as the first
frame after connect (not in the URL query string, to avoid it landing in
proxy/access logs). Unauthenticated connections are closed immediately.
Reconnection re-authenticates from scratch; WebSocket state is never used to
authenticate a subsequent HTTP call.

## 2. CSRF and Web UI

The web UI's state-changing requests are protected by:

- `SameSite=Lax` on the session cookie (blocks cross-site form/script
  submission from third-party origins in the common case), plus
- a double-submit CSRF token: a `helixsync_csrf` cookie (readable by the
  dashboard's JavaScript, `Secure`, `SameSite=Lax`) whose value must be
  echoed in an `X-CSRF-Token` header on every mutating web-session-
  authenticated request (logout, password change, session and device
  revocation, device rename, account deletion). The server compares the cookie
  and the header; a missing or mismatched header is `403`.

There is **no** `Origin`/`Referer` validation on mutating requests. CSRF
protection is exactly the two layers above. Cross-origin browser requests are
additionally constrained by the CORS allowlist (§4), which governs what a
foreign origin can read, not what the server will accept.

Device-credential-authenticated API calls (the extension's sync traffic) are
bearer-token authenticated, not cookie-authenticated, and are therefore not
subject to CSRF in the browser-cookie sense: a malicious page cannot make a
browser attach an `Authorization` header it doesn't have.

## 3. Trust Boundary — Never Trust the Client

The server never trusts, from client input:

- `user_id` (always derived from the authenticated session/token)
- `deviceId` inside an operation body (always derived from the authenticated
  device credential; any client-sent value is ignored/overwritten)
- claims of authorization/ownership over an object (`objectId` ownership is
  checked against prior operations recorded for that user)
- `serverCursor` (always server-assigned, never accepted from the client)

All authorization checks happen server-side, on every request, not only at
token issuance.

## 4. Transport and Headers

- HTTPS is mandatory in production (enforced by the reverse proxy; the
  server itself may run plain HTTP behind a trusted proxy in Docker Compose
  but documents this clearly in `docs/deployment.md`). Session cookies are
  `Secure`, so the dashboard cannot hold a session over plain HTTP (loopback
  excepted), and the extension refuses a non-`https://` Server URL other than
  loopback. The dashboard shows a warning banner when it is loaded over HTTP
  from a non-loopback host.
- The `web` image (nginx) sets these headers on every response it serves,
  from a single snippet (`web/security-headers.conf`) that is included in the
  server block and in every location that sets its own `add_header` (nginx
  does not inherit `add_header` into a location that sets its own, so each
  such location has to include the snippet):
  - `Content-Security-Policy: default-src 'self'; script-src 'self';
    style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src
    'self'; object-src 'none'; base-uri 'self'; form-action 'self';
    frame-ancestors 'none'`. The built dashboard has no inline script or
    style, no `eval`, and calls only same-origin `/api`, so nothing needs
    loosening. If you build the web image with `VITE_API_BASE_URL` pointing at
    another origin, add that origin to `connect-src`.
  - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
    `Referrer-Policy: same-origin`, and a `Permissions-Policy` that denies
    camera, microphone, geolocation and the other powerful features the
    dashboard never uses.
  - `Strict-Transport-Security: max-age=31536000`, **only when the request
    carries `X-Forwarded-Proto: https`**. The container itself only ever sees
    plain HTTP behind your TLS terminator, so it cannot know the client's scheme
    on its own; your proxy must pass the header (Caddy does by default; with
    nginx, set `proxy_set_header X-Forwarded-Proto $scheme;`). Without it, set HSTS at the proxy instead. No
    `includeSubDomains` or `preload` is sent: those are the domain owner's
    call.
  - `index.html` is served with `Cache-Control: no-cache` so a deploy is
    picked up on the next load; hashed `/assets/*` are cached immutably.
- CORS: explicit allowlist of the configured web-app origin(s); no wildcard
  `*` when credentials are involved.

## 5. Rate Limiting

Configurable limits (see `docs/deployment.md` for env vars) cover:

```text
login, registration, token refresh, device registration,
account deletion, sync upload, sync download, WebSocket connection attempts
```

Per-client limits key on the client IP as nginx reports it
(`X-Forwarded-For` from a trusted proxy, `docs/deployment.md`); per-account
limits (login, prelogin, device registration by email) additionally throttle
guessing spread across many IPs. Account deletion is limited to 5 attempts a
minute per account and is keyed by account, not by the login buckets, so
failed deletes can't lock the owner out of signing in.

Sync upload/download limits are set high enough to accommodate normal
bursty browser activity (e.g. importing many bookmarks) without making
ordinary use unreliable — burst allowance plus a sustained rate, not a hard
per-minute cap tuned for login-sized traffic.

## 6. Input Validation and Limits

- All request bodies are schema-validated (`serde` deny-unknown-fields is
  intentionally *not* used for forward-compatible optional fields per the
  protocol compatibility rules, but required fields and types are strictly
  checked).
- Explicit size limits: max request body size, max operations per upload
  batch, max payload size per operation.
- All SQL is parameterized via `sqlx` compile-time-checked queries — no
  string-built SQL.

## 7. Logging and Auditing

- `audit_logs` records security-relevant events: login, logout, password
  change, device registration, device revocation (`device_revoked`,
  `device_self_revoked`, `refresh_token_reuse_detected`), credential rotation,
  account deletion (`account_deleted`, `account_delete_failed`), settings
  changes. Rows reference the account and device with `ON DELETE SET NULL`,
  so the trail survives an account's deletion with the identifiers removed.
- No secrets (passwords, tokens, key material, decrypted payloads) are ever
  written to logs. Structured logging (`tracing`) uses explicit field
  allowlists for anything derived from user input.

## 8. Release Pipeline

`.github/workflows/release.yml` builds the server and web images, and builds
and publishes the browser extension (the procedure and one-time setup are in
[`releasing.md`](releasing.md)). Because a Web Store update reaches every
installed copy, the pipeline is set up so that no single compromised step can
ship one:

- Every action is pinned to a full commit SHA, and no third-party action runs
  in a job that holds a write-scoped token or store credentials (path
  detection and GitHub Release upload use plain `git` and `gh`).
- The extension is built and tested in the `extension` job, which has a
  read-only token and holds no secrets. The `release-extension` job attaches
  the built zip to the GitHub Release; it can write to the repository, so it
  only downloads the artifact and runs `gh`. The `publish-chrome-web-store`
  job downloads the same zip and is the only place the `CHROME_*` secrets are
  used; it runs no npm and no third-party code.
- `publish-chrome-web-store` targets the `chrome-web-store` GitHub
  environment. Store the
  `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`,
  `CHROME_PUBLISHER_ID` and `CHROME_EXTENSION_ID` secrets there rather than at
  repo level, add yourself as a required reviewer, and restrict deployment
  branches to `main` (Settings → Environments). Until the secrets are moved,
  repo-level secrets of the same names are still read by the job.
- The publish call uses `STAGED_PUBLISH`: after the store approves an upload,
  it is staged and must be released with the Publish button in the Web Store
  developer dashboard.
- Jobs are serialised per job, not per workflow run. A publish that waits for
  approval would otherwise keep the whole run, and every run queued behind it,
  occupied.

## 9. Non-Goals

The following are explicitly out of scope and must never be handled by
HelixSync:

```text
passwords, passkeys, cookies, auth/session tokens (of *other* sites),
payment credentials, browser cache, downloads, temporary browser files
```

Password management should be handled by a dedicated password manager
(such as Vaultwarden or Bitwarden); HelixSync does not manage browser passwords.

## 10. Known Limitations

Deliberate, documented trade-offs. They are listed here so nobody has to
discover them:

- **The dashboard's password prompt trusts the server's JavaScript.** The
  password is typed into code served by the same server the encryption design
  otherwise treats as untrusted. A malicious operator can serve modified
  JavaScript and capture it. This is inherent to browser-based end-to-end
  encryption; the strict CSP (§4) limits what injected third-party content can
  do but cannot help against the origin itself. If you don't operate the
  server yourself, you are trusting its operator with this prompt. The
  extension, which is installed from the Web Store and not served by the
  server, is not exposed to this.
- **A hostile server can withhold or delete data.** It controls the operation
  log, so it can drop operations or serve incomplete history. What it cannot do
  is read the data, forge content that was never encrypted under the account
  key, or relabel or splice ciphertexts: those are authenticated
  (`docs/encryption.md` §6).
- **Secrets on the device are only as safe as the browser profile.** The account
  key and refresh token are encrypted at rest in the extension's IndexedDB with a
  non-extractable key (§13), so reading the profile's files directly does not
  reveal them. Code running inside the extension, or someone using the unlocked
  browser, can still use them; there is no OS keychain to do better.
- **There is no password recovery.** The account key exists only wrapped under
  a key derived from the password, which the server never sees
  (`docs/encryption.md` §5).
- **Per-account rate limits can be used to lock out a specific account.**
  More than ten login attempts a minute against one email, from anyone, get
  that email's logins throttled for a while. The alternative (no per-account limit) lets
  password guessing spread across many IPs go unthrottled.
- **Per-IP rate limits depend on a correctly configured proxy chain.** With the
  default trusted-proxy CIDRs (all private ranges), a client that reaches `web`
  from a private address, such as through Docker's userland proxy, rootless
  Docker or IPv6 NAT, can set `X-Forwarded-For` and pick its own rate-limit key.
  Narrow `WEB_TRUSTED_PROXY_CIDRS` as described in `docs/deployment.md`.

## 11. Account and Device Lifecycle

### Registration switch

`ALLOW_REGISTRATION` (default `true`) controls `POST /auth/register`. When it is
`false` the endpoint returns `403` with error code `registration_disabled`
after rate limiting and before any validation or Argon2 work, and
`GET /version` reports `registrationEnabled: false`. Existing accounts, logins
and devices are untouched. Every account is also capped at
`MAX_ACCOUNT_STORAGE_BYTES` of stored payloads (default 5 GiB). On an
internet-reachable instance, close registration once your accounts exist.

### Account deletion

`DELETE /auth/account` (dashboard: Security, Danger zone) requires a valid
session with the CSRF token **and** the account's current `authKey` in the
body, so a stolen session cookie alone is not enough. A wrong key is `401`,
audited as `account_delete_failed`, and nothing is deleted. On success, in one
transaction the server locks the user row, records `account_deleted`, and
deletes it; every other table (devices and their credentials, sync operations,
objects, snapshots, tombstones, settings, statistics, sessions) is removed by
`ON DELETE CASCADE`, while audit rows are kept with their user and device
columns nulled. Locking the row first means a login or device registration
racing the delete either completes before it (and is deleted) or fails.

The server then purges what the database cascade can't reach: tombstones in
the web-session cache for every session of the account, revocation tombstones
for its devices, their WebSocket connections, and their per-device upload and
last-seen state. Both cookies are cleared in the response. The old session
cookie and every device token stop working immediately, not after the
30-second cache window. Backups taken earlier still contain the data until they
are rotated out; see `docs/deployment.md`.

### Device self-revocation

`POST /devices/self/revoke`, authenticated with the device's bearer token,
revokes that device and all its credentials in one transaction, then updates
the revocation cache, closes the device's WebSocket and writes
`device_self_revoked`. It returns `204`; any later request with that device's
tokens is `401`.

## 12. Software Supply Chain and Releases

- Dependencies are locked (`Cargo.lock`, `package-lock.json`; CI builds with
  `--locked` and `npm ci`) and scanned on every pull request (`cargo audit`,
  `npm audit --omit=dev`). The one ignored advisory (`rsa`, RUSTSEC-2023-0071)
  concerns code that is compiled in with `jsonwebtoken`'s crypto backend but
  unreachable, because the server only uses HMAC (HS256) tokens; the reasoning
  is in `server/.cargo/audit.toml`. Updates, including base-image digests, are
  applied by hand.
- The release workflow runs the same checks first, and nothing is tagged,
  pushed or published until they pass. Every third-party GitHub Action is
  pinned to a full commit SHA, none runs in a job that can write to the
  repository, and no workflow expression is interpolated into a shell script.
- The Chrome Web Store publish is a separate job in a protected
  `chrome-web-store` environment (required reviewers recommended). It receives
  the already-built zip and installs and builds nothing, so no package install
  script runs next to the publishing secrets. Setup steps are in
  `docs/releasing.md`.
- `react-router-dom` is on 7.x, which carries the fix for the open-redirect
  advisory GHSA-wrjc-x8rr-h8h6.

## 13. Browser Extension Surface

The extension holds the account key and can read bookmarks, history and tabs, so
its attack surface is kept small.

| Permission | Used for |
|------------|----------|
| `bookmarks`, `history`, `tabs` | Reading and applying the data that is synced |
| `storage`, `unlimitedStorage` | Settings, the sync queue and the local cache (IndexedDB, `chrome.storage`) |
| `alarms` | Periodic background sync |
| `tabGroups` (optional) | Tab group sync, requested only if you enable it |
| Host access (optional) | Requested at connect time for the exact server origin and its `wss://` counterpart, never for all sites |

Not requested: `cookies`, `webRequest`, `scripting`, `debugger`, `downloads`,
`management`, `nativeMessaging` or clipboard access. The manifest declares no
content scripts, no `externally_connectable` and no `web_accessible_resources`,
so web pages and other extensions have no channel to it. It cannot be enabled in
incognito windows (`"incognito": "not_allowed"`), and its extension-page CSP is
`script-src 'self'; object-src 'self'`.

Controls in the code:

- **Server URL.** `https://` is required; plain `http://` is accepted only for
  `localhost`, `127.0.0.1` and `[::1]`, since anything else would expose the
  `authKey` and device tokens to the network.
- **Message handling.** The background worker answers `untrusted_sender` and does
  nothing for any message whose sender is not the extension itself.
- **Secrets at rest.** The account key and refresh token are wrapped with a
  non-extractable AES-GCM `CryptoKey` before they are written to IndexedDB. The
  password typed during setup is kept only in `chrome.storage.session`, which is
  memory-only and cleared when the browser exits, never on disk. The residual
  risk is in §10.
- **Synced URLs.** Tab and bookmark URLs received from other devices are applied
  only if they use `http:` or `https:`, so a peer or a hostile server cannot
  plant a `javascript:` bookmarklet or another script-running scheme.
- **Server-supplied parameters.** The client rejects out-of-range key-derivation
  parameters and salts before deriving anything (`docs/encryption.md` §2), and
  halts rather than skips data in an envelope version it does not understand
  (`docs/encryption.md` §5).
- **Disconnect.** Disconnecting revokes the device on the server (§11) before
  wiping the local record.
