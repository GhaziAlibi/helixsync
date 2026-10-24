# HelixSync Architecture

```text
                         Internet
                            |
                            | HTTPS
                            v
                  +--------------------+
                  | Reverse Proxy      |
                  | Caddy/Nginx/etc.   |
                  +---------+----------+
                            |
              +-------------v-------------+
              |  web (nginx)              |
              |  dashboard static files   |
              |  /api/* -> server         |
              +-------------+-------------+
                            |
              +-------------v-------------+
              |      HelixSync Server     |
              |                           |
              | REST API (/api/v1)        |
              | WebSocket (/api/v1/ws)    |
              | Authentication            |
              | Sync Protocol             |
              | Device Management         |
              | Conflict Processing       |
              +-------------+-------------+
                            |
                     +------v------+
                     | PostgreSQL  |
                     +-------------+


              +-----------------------------+
              |                             |
              v                             v
       +---------------+             +---------------+
       | Browser #1    |             | Browser #2    |
       |               |             |               |
       | MV3 Extension |             | MV3 Extension |
       +---------------+             +---------------+
```

Browsers and the dashboard reach the server only through `web`'s nginx, which
serves the dashboard and proxies `/api/*` to `server`. `server` and `postgres`
publish no ports to the host in the Compose stacks. See
[`deployment.md`](deployment.md) for the topologies this supports.

## Components

### Server (`server/`)

Rust + Axum + Tokio + SQLx + PostgreSQL. Modules:

- `auth/` — account authentication (Argon2id, sessions, CSRF), and the
  signing and verification of device access tokens.
- `devices/` — device registration, credential issuance, refresh and
  revocation, listing and rename.
- `sync/` — operation upload/download, cursors, conflict resolution,
  snapshots, tombstone/compaction policy, statistics and per-account settings.
- `websocket/` — notification-only change-available broadcast.
- `crypto/` — server-side primitives only (Argon2id hashing, HMAC/token
  signing); never handles E2E payload plaintext.
- `middleware/` — client IP resolution and rate limiting.
- `database/` — connection pool and the migrations runner.
- `audit.rs` — security-event audit log.
- `housekeeping.rs` — periodic cleanup of expired credentials and web sessions,
  old audit rows, ephemeral tombstones and stale history buckets.
- `config.rs` — environment-driven configuration (validated at startup).

Background tasks run inside the server process: operation/tombstone
compaction (hourly by default) and housekeeping (daily by default). CORS,
request timeouts and response compression are layered in `lib.rs`.

### Extension (`extension/`)

TypeScript + Manifest V3 + Vite. Modules mirror the protocol's domains:
`background/` (service worker orchestration, alarms-based sync scheduling),
`sync/` (queue, cursor, conflict application), `bookmarks/`, `history/`,
`tabs/` (tabs, windows and tab groups), `storage/` (IndexedDB access layer),
`crypto/` (key derivation and XChaCha20-Poly1305 E2E encryption), `api/` (typed
REST and WebSocket client), `popup/` (the extension's whole UI, including
settings) and `util/`.

### Web (`web/`)

React + TypeScript + Vite + Tailwind. Pages: login, dashboard, devices,
sync settings, security. Talks to the same `/api/v1` REST surface as the
extension, using cookie-based web sessions instead of device credentials. Key
derivation happens in the browser (`web/src/crypto/`), so the password never
reaches the server.

## Data model

One PostgreSQL database; the schema is `server/migrations/`.

| Table | Holds |
|-------|-------|
| `users`, `user_settings` | Accounts (email, `authKey` hash, KDF salt/parameters, wrapped account key) and per-account sync settings |
| `devices`, `device_credentials` | Registered browsers and their hashed, rotating refresh credentials |
| `web_sessions` | Dashboard sessions: a hash of the session identifier, expiry, and the client's IP address and user agent |
| `sync_operations` | The append-only operation log; payloads are opaque ciphertext |
| `sync_cursors` | The per-account cursor allocator and each device's last-acknowledged cursor |
| `sync_snapshots` | Compressed merged state used to bring a device up to date |
| `sync_objects` | A permanent ledger of which account originated which object |
| `tombstones` | Records of deleted objects |
| `sync_stats`, `history_visit_hours` | Per-account counts and hourly visit-count buckets for the dashboard |
| `audit_logs` | Security-relevant events |

Deleting a `users` row cascades to everything except `audit_logs`, whose rows
keep their events with the account columns nulled.

## Data Flow

See [`protocol.md`](protocol.md) for the authoritative operation-log flow. In
short: browser event -> local operation -> local persistence + immediate local
apply -> upload queue -> server durable append -> WebSocket notify other
devices -> those devices pull via cursor -> apply -> advance cursor.

Everything the server stores for synced data is encrypted on the device first;
the key hierarchy is in [`encryption.md`](encryption.md).

## Deployment Topology

A single Docker Compose stack: `server` + `web` + `postgres`, with TLS handled
by a reverse proxy you run in front of `web`. The server and the dashboard can
also be run without Docker. No third-party SaaS dependency of any kind.
