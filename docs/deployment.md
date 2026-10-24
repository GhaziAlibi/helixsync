# HelixSync Deployment

This guide covers running and operating a HelixSync server: deployment
topologies, the reverse proxy, configuration, backups and day-to-day
operations. The step-by-step install, including the choice between prebuilt
images, building from source, Portainer and a non-Docker install, is in the
[README](../README.md#getting-started).

## Quick start (Docker Compose)

```bash
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD, JWT_SIGNING_KEY, CORS_ALLOWED_ORIGINS
docker compose up -d --build
```

This starts three services: `postgres`, `server` (Rust API, internal-only —
see below), and `web` (the React dashboard, port 5173 by default). Database
migrations run automatically on server startup (`sqlx::migrate!`, versioned
under `server/migrations/`).

> **HTTPS is required for anything but localhost.** The dashboard's session
> cookies are `Secure`, so a browser will not keep you signed in over plain
> HTTP; the extension refuses any Server URL that isn't `https://` (only
> `localhost`, `127.0.0.1` and `[::1]` may use `http://`); and over HTTP your
> sign-in would cross the network unprotected. The dashboard shows a warning
> banner when it is loaded over HTTP from another host. Terminate TLS at a
> reverse proxy in front of `web` (below).

`server` has no host port mapping and is only reachable from other
containers on the internal `helixsync` docker network. `web`'s nginx
(`web/nginx.conf`) proxies `/api/*` to `server:8080` and serves the
dashboard's static assets for everything else, so `web` is the single
ingress point for both browsers and the extension.

Run one `server` process per database. Rate limits, the 30-second caches of
session and device validity, and WebSocket change notifications live in that
process's memory. With a second replica, each would apply its own rate limits,
a revocation made through one could keep working on the other for up to 30
seconds, and a device connected to one would only see changes uploaded through
the other at its next poll. Several replicas are neither supported nor tested.

## Deploying prebuilt images (Portainer, etc.)

`docker-compose.yml` builds `server`/`web` from source, which needs a repo
checkout and a Docker build step on the host. If you'd rather deploy the
images already published by CI — e.g. pasting a stack directly into
Portainer, with no repo access on the host at all — use
[`docker-compose.prod.yml`](../docker-compose.prod.yml) instead:

```bash
cp .env.example .env
# edit .env as above
docker compose -f docker-compose.prod.yml up -d
```

It pulls `ghcr.io/ghazialibi/helixsync-server:<tag>` and
`ghcr.io/ghazialibi/helixsync-web:<tag>` (public images, no registry login
needed — see the
[server](https://github.com/GhaziAlibi/helixsync/pkgs/container/helixsync-server)
and
[web](https://github.com/GhaziAlibi/helixsync/pkgs/container/helixsync-web)
package pages for available tags). `HELIXSYNC_VERSION` in `.env` (e.g.
`1.0.0`) is required and selects the released version to run; the compose
file refuses to start without it rather than floating on `latest`.

The web image's API base URL is compiled in at build time (see
`web/Dockerfile`), so this file can't override it via environment
variables — the published image already defaults to same-origin relative
paths, which is what nginx's `/api/*` proxy expects. If you need a
different API origin, you'll need to build your own `web` image with that
Vite build arg set, rather than using the published one.

Put a reverse proxy (Caddy, Nginx, Traefik, etc.) in front of `web` to
terminate HTTPS. HelixSync does not bundle TLS termination by default since
most self-hosters already run one; a minimal example Caddyfile:

```caddyfile
sync.example.com {
    reverse_proxy web:80
}
```

If your proxy is nginx, pass the client's scheme and address on, and raise
its request-size and timeout limits:

```nginx
location / {
    proxy_pass http://web:80;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    # the extension's WebSocket
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # nginx's default request limit is 1 MB, far below the server's upload
    # limit (about 126 MiB), so large history uploads would fail with 413.
    client_max_body_size 150m;
    # keep long-lived WebSockets and slow snapshot downloads open
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

`web` adds `Strict-Transport-Security` to its responses only when it sees
`X-Forwarded-Proto: https`, so make sure your proxy sets it (Caddy does by
default). Otherwise set HSTS at the proxy.

### Real client IPs behind that reverse proxy

`web`'s nginx sits behind the TLS-terminating proxy above, so its TCP peer
is always that proxy, not the actual client. Left unhandled, `$remote_addr`
would be the proxy's own address for every request, and the backend's
per-client rate limiter (`server/src/middleware/client_ip.rs`) would put
every client behind it into one shared bucket — a few bad logins from any
one user would 429 everyone else too.

nginx's `ngx_http_realip_module` fixes this: it rewrites `$remote_addr`
from `X-Forwarded-For`, but only when the *connecting* peer's address is in
a trusted list, so a client that skips your reverse proxy and hits `web`
directly can't spoof its way into another client's bucket. The trusted
CIDRs are generated into `/etc/nginx/conf.d/00-real-ip.conf` at container
start (`web/docker-entrypoint.d/10-real-ip.sh`) from the `WEB_TRUSTED_PROXY_CIDRS`
env var (see `.env.example`), and default to the private ranges docker
networks and loopback reverse proxies use:
`10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.1/32 ::1/128`.

The default is enough for the Caddyfile above, where Caddy joins the same
`helixsync` docker network as `web` (or reaches it over `localhost`). Only
set `WEB_TRUSTED_PROXY_CIDRS` yourself if your reverse proxy connects to
`web` from outside those ranges, e.g. over a public address or a
differently-addressed private network.

**Caveat: the default list is broad, and can let clients spoof their IP.**
The default CIDRs cover every private range. nginx trusts
`X-Forwarded-For` from any peer inside them, so if some clients can reach
`web` *directly* and appear to it as a private address, they can send their own
`X-Forwarded-For` and pick the per-IP rate-limit key they are counted under.
That happens when:

- `web`'s port is published to the network (`WEB_PORT`) and Docker's userland
  proxy is in use, or you run rootless Docker, or you use IPv6 NAT: in these
  setups the connection reaches `web` from the Docker bridge's gateway
  address, a private address, instead of the client's own;
- other, less trusted containers or LAN hosts can open connections to `web`.

Per-account limits still apply, so this weakens per-IP throttling rather than
bypassing authentication. To close it, list only the addresses your proxy really
connects from, for example when the proxy is a container with a fixed address
or on a dedicated network:

```bash
WEB_TRUSTED_PROXY_CIDRS="172.20.0.5/32"      # your proxy's address only
```

and prefer not publishing `WEB_PORT` to the network at all: bind it to loopback
(`ports: ["127.0.0.1:${WEB_PORT:-5173}:80"]` in your compose file) or reach
`web` only over the Docker network, so every request has to come through the
proxy.

## Required environment variables

See `.env.example` for the full list. The two that must never use the
sample defaults in any real deployment:

- `POSTGRES_PASSWORD` — database credential. Generate it with
  `openssl rand -hex 32`: the Compose files embed it in a connection URL, where
  characters such as `/` or `@` (which base64 output can contain) would break
  the URL.
- `JWT_SIGNING_KEY` — signs device access tokens; generate with
  `openssl rand -base64 48`. Rotating this invalidates all outstanding
  access tokens (refresh tokens are unaffected, since they're validated
  against `device_credentials.credential_hash` in the database, not signed).

`REQUIRE_ENCRYPTION` defaults to on (an unset variable means `true`) and must
stay on for any deployment holding real user data — see `docs/encryption.md`
§7. Only local testing or development should ever set it to `false` (or `0`);
any other non-empty value that is not `true`/`1` fails startup instead of
being guessed at, and the server logs a warning at startup when it is off.

### Closing registration

`ALLOW_REGISTRATION` (default `true`) controls whether
`POST /api/v1/auth/register` accepts new accounts. **On any
internet-reachable instance, create your own account(s) first, then set
`ALLOW_REGISTRATION=false` and restart `server`.** Otherwise anyone who finds
the URL can sign up and store data on your server. A closed server answers
registration attempts with `403` and error code `registration_disabled`
(before doing any password hashing, but after rate limiting), reports
`"registrationEnabled": false` from `GET /api/v1/version` — the dashboard uses
that to hide its sign-up form — and keeps serving existing accounts, logins
and devices as normal.

Each account is also capped at `MAX_ACCOUNT_STORAGE_BYTES` of stored operation
payloads (default 5 GiB, `5368709120`); uploads past the cap are rejected. Lower
it if you share an instance and want a tighter bound per account.

Other variables you may want to change are in `.env.example`, each with a
comment. `CORS_ALLOWED_ORIGINS` only matters if something calls the API from
a browser at a different origin than the dashboard.

## Configuration reference

Every setting the server reads, all from the environment (or a `.env` file in
its working directory). The Compose files pass through the ones marked
**C**; to set another one there, add it to the `server` service's
`environment:`. Durations are in seconds.

| Variable | Default | Meaning |
|----------|---------|---------|
| `DATABASE_URL` | required | PostgreSQL connection URL. **C** (built from `POSTGRES_*`) |
| `JWT_SIGNING_KEY` | required | At least 32 characters, never a `.env.example` placeholder. **C** |
| `BIND_ADDR` | `127.0.0.1:8080` | `ip:port` to listen on. The Docker image sets `0.0.0.0:8080`. **C** |
| `BEHIND_PROXY` | `false` | Trust `X-Real-IP` / `X-Forwarded-For` for rate limiting. **C** (always `true`) |
| `CORS_ALLOWED_ORIGINS` | empty | Comma-separated origins allowed to call the API cross-origin. **C** |
| `REQUIRE_ENCRYPTION` | `true` | Reject unencrypted sync payloads. **C** |
| `ALLOW_REGISTRATION` | `true` | Accept new accounts. **C** |
| `MAX_ACCOUNT_STORAGE_BYTES` | `5368709120` | Stored payload bytes per account. **C** |
| `MAX_DEVICES_PER_ACCOUNT` | `25` | Connected browsers per account. **C** |
| `ACCESS_TOKEN_TTL_SECS` | `900` | Device access token lifetime. **C** |
| `REFRESH_TOKEN_TTL_SECS` | `2592000` | Device refresh token lifetime (30 days). **C** |
| `WEB_SESSION_TTL_SECS` | `1209600` | Dashboard session lifetime (14 days). **C** |
| `COMPACTION_INTERVAL_SECS` | `3600` | How often operation-log compaction runs. **C** |
| `TOMBSTONE_RETENTION_SECS` | `2592000` | Extra time a delete's raw log row is kept. **C** |
| `AUDIT_LOG_RETENTION_SECS` | `7776000` | How long audit-log rows are kept (90 days). **C** |
| `RUST_LOG` | `info` | Log filter (`tracing` env-filter syntax). **C** |
| `LOG_FORMAT` | `text` | `text` or `json`. **C** |
| `INACTIVE_DEVICE_COMPACTION_GRACE_PERIOD_SECS` | `2592000` | A device idle this long stops holding back compaction; it resyncs from a snapshot if it returns |
| `NEVER_SYNCED_DEVICE_COMPACTION_GRACE_PERIOD_SECS` | `86400` | The same for a device that never downloaded changes |
| `HOUSEKEEPING_INTERVAL_SECS` | `86400` | How often expired credentials, sessions and old audit rows are deleted |
| `DEVICE_CREDENTIAL_RETENTION_SECS` | `604800` | How long an expired refresh token row is kept |
| `EPHEMERAL_TOMBSTONE_RETENTION_SECS` | `2592000` | How long tab and window tombstones are kept |
| `DATABASE_MAX_CONNECTIONS` | `50` | Connection pool size; keep it under PostgreSQL's `max_connections` |
| `WEBSOCKET_PING_INTERVAL_SECS` | `30` | WebSocket keep-alive and re-authorization interval |
| `REQUEST_TIMEOUT_SECS` | `30` | Longest an HTTP request may run |
| `WEBSOCKET_SEND_TIMEOUT_SECS` | `10` | Longest one WebSocket send may block |
| `UPLOAD_SEMAPHORE_ACQUIRE_TIMEOUT_SECS` | `20` | Longest an upload waits behind the same device's previous one |
| `SHUTDOWN_DEADLINE_SECS` | `30` | Longest a graceful shutdown waits for open requests |

On/off settings accept `true`, `false`, `1` or `0`. A value that doesn't
parse, or is out of range (a zero interval, for example), stops the server at
startup with a message naming the variable. Rate limits are fixed in code
(`docs/security.md` §5).

## Content-Security-Policy and a separate API origin

The `web` image serves a strict Content-Security-Policy that only allows
same-origin resources and connections (see `docs/security.md` §4). That fits
the default setup, where the dashboard calls the API on its own origin through
nginx. If you build your own `web` image with `VITE_API_BASE_URL` pointing at a
different origin, add that origin to `connect-src` in
`web/security-headers.conf`, or the dashboard won't be able to reach its API.

## Building from source

`server/Dockerfile` builds with `SQLX_OFFLINE=true`, using the checked-in
`server/.sqlx/` query cache so that building the server container image does not
require connecting to a live Postgres instance during compilation. If you
change a query, regenerate the cache with `cargo sqlx prepare` (see
`CONTRIBUTING.md`).

## Running without Docker

The server is a single binary and the dashboard is a folder of static files, so
Docker is optional. The README walks through building both
([option E](../README.md#e-without-docker)); this section covers keeping the
server running and what the proxy in front of it has to do.

**Server as a service.** Install the binary and keep its settings in a file only
root can read. The server's settings are the same environment variables as in
`.env.example`, plus `DATABASE_URL` and `BIND_ADDR` (see `server/.env.example`):

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin helixsync
sudo install -d /opt/helixsync /etc/helixsync
sudo install -m 0755 server/target/release/helixsync-server /opt/helixsync/
sudo install -m 0600 /dev/null /etc/helixsync/server.env
sudoedit /etc/helixsync/server.env     # DATABASE_URL=..., JWT_SIGNING_KEY=..., BIND_ADDR=127.0.0.1:8080, BEHIND_PROXY=true
```

An example systemd unit, `/etc/systemd/system/helixsync.service`:

```ini
[Unit]
Description=HelixSync server
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=helixsync
Group=helixsync
WorkingDirectory=/opt/helixsync
EnvironmentFile=/etc/helixsync/server.env
ExecStart=/opt/helixsync/helixsync-server
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Enable it with `sudo systemctl enable --now helixsync`. `GET /readyz` on
`BIND_ADDR` tells you whether it is up and can reach the database.

**What the proxy must do.** The dashboard and the API have to share one origin,
so one proxy in front of both:

- serve the dashboard's static files (`web/dist`) for every path, falling back to
  `index.html` for paths that are not a file (the dashboard is a single-page
  app);
- forward `/api/` to the server, including WebSocket upgrades on `/api/v1/ws`;
- terminate TLS and allow request bodies of at least the server's upload limit
  (about 126 MiB; the `web` image's nginx allows 150 MB);
- overwrite `X-Real-IP` with the real client address. With `BEHIND_PROXY=true`
  the server trusts `X-Real-IP` first and `X-Forwarded-For` second for per-client
  rate limiting, so a proxy that passes a client-supplied `X-Real-IP` through
  lets that client choose its own rate-limit bucket. Only set `BEHIND_PROXY=true`
  when the proxy is the sole way to reach the server, and bind the server to
  loopback so that holds.

The README has a Caddy example that does all of this. The `web` image's
[`nginx.conf`](../web/nginx.conf) is a complete nginx equivalent: replace
`server:8080` with your server's address.

**Security headers.** The `web` image sets a strict Content-Security-Policy and
other headers from [`web/security-headers.conf`](../web/security-headers.conf)
(see [`security.md`](security.md) §4). Without the image you have to add them in
your own proxy, or the dashboard loses that protection.

## Backup and restore

Minimum supported backup mechanism is `pg_dump`/`pg_restore` against the
`postgres` service's volume:

```bash
docker compose exec postgres pg_dump -U helixsync helixsync > backup.sql
```

Restore into a fresh instance:

```bash
docker compose exec -T postgres psql -U helixsync helixsync < backup.sql
```

If E2E encryption (`docs/encryption.md`) is enabled, `sync_operations.payload`
and `sync_snapshots.data` contain only opaque encrypted blobs — the database
backup alone is sufficient for disaster recovery of the encrypted data. The
backup holds each account's key only in wrapped form, encrypted under a key
derived from the account password, and in a second copy under a key derived
from the user's recovery code; the server never sees either. A restored
database is therefore only readable by someone who knows the password or the
recovery code: if a user loses both, their data is unrecoverable by design
(docs/encryption.md §9) — this is not a backup gap, it's the point of E2E
encryption. Keep database
backups as private as the database itself, since they also hold the account
metadata (emails, device names) in the clear.

Deleting an account removes its data from the live database immediately, but
not from backups taken before; they age out with your backup retention.

## Database migrations

The schema is `server/migrations/0001_init.sql`, applied automatically at
server startup via `sqlx::migrate!`. To apply it by hand instead:

```bash
cd server
sqlx migrate run --database-url "$DATABASE_URL"
```

## Disaster recovery checklist

1. Restore the `postgres` volume from the latest `pg_dump` backup.
2. Bring up `server` against the restored database; migrations are
   idempotent (`sqlx::migrate!` tracks applied versions) and safe to re-run.
3. Devices resume incremental sync from their last acknowledged cursor, or
   fall back to snapshot resync automatically if that cursor is no longer
   covered by retained operations (`docs/protocol.md` §11).
4. If encryption is enabled, sign in to the dashboard (or reconnect a device)
   with a restored account's password to confirm the restore is complete —
   the database alone cannot decrypt anything.

## Health checks

`GET /healthz` returns `200 ok` once the process is up. It checks nothing
else — it's pure liveness, so it never reports unhealthy for a reason a
process restart can't fix.

`GET /readyz` additionally runs `SELECT 1` against the connection pool with
a 2s timeout, and reports pool size/idle counts in the response body. It
returns `503` if the database is unreachable or the query times out, so an
orchestrator can detect (and restart or stop routing to) an instance whose
pool can no longer reach Postgres, rather than that going unnoticed while
every real endpoint 500s. The Dockerfile's `HEALTHCHECK` (and Docker
Compose's container health status) uses this endpoint.

## Logs

The server logs to standard output: `docker compose logs server`, or the
journal for the systemd unit above. `RUST_LOG` selects what is logged (default
`info`; for example `RUST_LOG=info,helixsync_server=debug`), and
`LOG_FORMAT=json` switches from text lines to one JSON object per line for a
log collector. The Compose files rotate each container's log at 10 MB, keeping
three files.

Logs never contain passwords, `authKey`s, tokens, key material or synced data
(`docs/security.md` §7). Security events such as logins, revocations and
account deletion are recorded in the `audit_logs` table, kept for
`AUDIT_LOG_RETENTION_SECS` (default 90 days).

## Deleting an account (operators)

Users delete their own account from the dashboard (**Security → Danger zone**)
or through the API, which removes everything under it and takes effect
immediately:

```http
DELETE /api/v1/auth/account
Cookie: helixsync_session=...; helixsync_csrf=...
X-CSRF-Token: <the helixsync_csrf value>
Content-Type: application/json

{ "authKey": "<the account's current authKey>" }
```

The `authKey` is derived from the account password by the client
(`docs/encryption.md` §2), so only the account holder can produce it; the
response is `204`, and a wrong key is `401` with nothing deleted. See
`docs/protocol.md` for the details.

If an account has to be removed without its holder (a departed user, abuse),
delete its row; every other table cascades from it:

```bash
docker compose exec postgres psql -U helixsync helixsync \
  -c "DELETE FROM users WHERE email = 'user@example.com';"
```

Then restart `server` (`docker compose restart server`). The database is the
source of truth, but the running server caches session and device validity for
up to 30 seconds and may hold an open WebSocket, so without a restart that
user's already-signed-in browser and connected extensions keep working until
those expire. Audit-log rows for the account stay, with the account columns
nulled. Deleting by hand skips the `account_deleted` audit event the API
writes.

## Deleting an account for a user who lost their password

A user who forgot their password resets it themselves with their recovery
code (**Forgot your password?** on the sign-in page). If they lost the code
too, their data on the server can't be decrypted by anyone, and the account
blocks their email from registering again. Delete it from the server host:

```bash
docker compose exec server /app/helixsync-server delete-account user@example.com
```

(Option E: run `helixsync-server delete-account user@example.com` with the
server's environment.) The command asks you to type `delete`, removes the
account and everything under it exactly like the dashboard's account
deletion, and records `account_deleted_by_operator` in the audit log. The
server sends no email, so make sure the request really comes from the
account's owner first. The account's sessions and devices stop working within
30 seconds. The user can then register again; their browsers upload their
bookmarks and history again when reconnected.
