# HelixSync Security Model

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

- Password hashing: Argon2id, tuned parameters stored alongside the hash
  (memory/time/parallelism) so they can be strengthened later without
  invalidating existing hashes (verify-then-optionally-rehash on login).
- Web session: HTTP-only, `Secure`, `SameSite=Lax` cookie carrying an opaque
  session identifier; the session row is server-side state (`web_sessions`)
  so it can be revoked (§ "Active sessions" UI).
- Rotating refresh token for the web session, separate from the device
  refresh token model.

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
  request, not just at token issuance).

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
- an explicit CSRF token (double-submit cookie or synchronizer token)
  required on all mutating (`POST`/`PATCH`/`DELETE`) web-session-authenticated
  requests, plus
- `Origin`/`Referer` validation on mutating requests as a defense-in-depth
  layer.

Device-credential-authenticated API calls (the extension's sync traffic) are
bearer-token authenticated, not cookie-authenticated, and are therefore not
subject to CSRF in the browser-cookie sense — but still validate `Origin`
for browser-initiated requests where applicable (extension requests are not
subject to normal CORS/cookie rules the same way a webpage is).

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
  but documents this clearly in `docs/deployment.md`).
- Secure headers: `Strict-Transport-Security` (set at the proxy),
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Content-Security-Policy` on the web app, `Referrer-Policy: same-origin`.
- CORS: explicit allowlist of the configured web-app origin(s); no wildcard
  `*` when credentials are involved.

## 5. Rate Limiting

Configurable limits (see `docs/deployment.md` for env vars) cover:

```text
login, registration, token refresh, device registration,
sync upload, sync download, WebSocket connection attempts
```

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
  change, device registration, device revocation, credential rotation,
  encryption key rotation/authorization events.
- No secrets (passwords, tokens, key material, decrypted payloads) are ever
  written to logs. Structured logging (`tracing`) uses explicit field
  allowlists for anything derived from user input.

## 8. Non-Goals

The following are explicitly out of scope and must never be handled by
HelixSync:

```text
passwords, passkeys, cookies, auth/session tokens (of *other* sites),
payment credentials, browser cache, downloads, temporary browser files
```

Password management should be handled by a dedicated password manager
(such as Vaultwarden or Bitwarden); HelixSync does not manage browser passwords.
