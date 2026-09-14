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

## Components

### Server (`server/`)

Rust + Axum + Tokio + SQLx + PostgreSQL. Modules:

- `auth/` — account authentication (Argon2id, sessions, CSRF), device
  credential issuance/refresh/revocation, JWT-like access token
  signing/verification.
- `devices/` — device registration, listing, rename, revoke.
- `sync/` — operation upload/download, cursors, conflict resolution,
  snapshots, tombstone/compaction policy.
- `websocket/` — notification-only change-available broadcast.
- `crypto/` — server-side primitives only (Argon2id hashing, HMAC/token
  signing); never handles E2E payload plaintext.
- `middleware/` — auth extraction, rate limiting, CORS, request size
  limits, tracing spans.
- `database/` — connection pool, migrations runner glue.

### Extension (`extension/`)

TypeScript + Manifest V3 + Vite. Modules mirror the protocol's domains:
`background/` (service worker orchestration, alarms-based sync scheduling),
`sync/` (queue, cursor, conflict application), `bookmarks/`, `history/`,
`tabs/` (tabs + windows + tab groups), `storage/` (IndexedDB access layer +
extension-storage sync), `crypto/` (XChaCha20-Poly1305 E2E encryption),
`api/` (typed REST + WebSocket client), `popup/`, `options/`.

### Web (`web/`)

React + TypeScript + Vite + Tailwind. Pages: login, dashboard, devices,
sync settings, security. Talks to the same `/api/v1` REST surface as the
extension, using cookie-based web sessions instead of device credentials.

## Data Flow

See `docs/protocol.md` for the authoritative operation-log flow. In short:
browser event -> local operation -> local persistence + immediate local
apply -> upload queue -> server durable append -> WebSocket notify other
devices -> those devices pull via cursor -> apply -> advance cursor.

## Deployment Topology

Single Docker Compose stack: `server` + `web` + `postgres`, reverse proxy handled
externally (or via an optional Caddy service, see `docs/deployment.md`).
No third-party SaaS dependency of any kind.
