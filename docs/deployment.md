# HelixSync Deployment

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

`server` has no host port mapping and is only reachable from other
containers on the internal `helixsync` docker network. `web`'s nginx
(`web/nginx.conf`) proxies `/api/*` to `server:8080` and serves the
dashboard's static assets for everything else, so `web` is the single
ingress point for both browsers and the extension.

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
package pages for available tags). Set `HELIXSYNC_VERSION` in `.env` (e.g.
`0.1.2`) to pin a specific released version instead of floating on `latest`.

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

## Required environment variables

See `.env.example` for the full list. The two that must never use the
sample defaults in any real deployment:

- `POSTGRES_PASSWORD` — database credential.
- `JWT_SIGNING_KEY` — signs device access tokens; generate with
  `openssl rand -base64 48`. Rotating this invalidates all outstanding
  access tokens (refresh tokens are unaffected, since they're validated
  against `device_credentials.credential_hash` in the database, not signed).

`REQUIRE_ENCRYPTION=true` is the production default and must stay `true`
for any deployment reachable by real user data — see `docs/encryption.md`
§7. Only local testing or development should ever set it to `false`.

## Building from source

`server/Dockerfile` builds with `SQLX_OFFLINE=true`, using the checked-in
`server/.sqlx/` query cache so that building the server container image does not
require connecting to a live Postgres instance during compilation.

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
backup alone is sufficient for disaster recovery of the encrypted data, but
the server backup **never** includes the user's encryption root key (REK),
which only ever lives on authorized devices (or a user-held recovery
export). Losing all devices and any recovery export means the encrypted
history is unrecoverable by design (docs/encryption.md §5) — this is not a
backup gap, it's the point of E2E encryption.

## Database migrations

Migrations live in `server/migrations/`, named `NNNN_description.sql`, and
are applied automatically at server startup via `sqlx::migrate!`. To run
them manually (e.g. before a blue/green cutover):

```bash
cd server
sqlx migrate run --database-url "$DATABASE_URL"
```

Every schema change must be a new, versioned migration file — never edit
a migration that has already shipped.

## Disaster recovery checklist

1. Restore the `postgres` volume from the latest `pg_dump` backup.
2. Bring up `server` against the restored database; migrations are
   idempotent (`sqlx::migrate!` tracks applied versions) and safe to re-run.
3. Devices resume incremental sync from their last acknowledged cursor, or
   fall back to snapshot resync automatically if that cursor is no longer
   covered by retained operations (`docs/protocol.md` §11).
4. If encryption is enabled, confirm at least one authorized device (or a
   recovery export) is available before considering the restore complete —
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
