# HelixSync

[![Release](https://github.com/GhaziAlibi/helixsync/actions/workflows/release.yml/badge.svg)](https://github.com/GhaziAlibi/helixsync/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**HelixSync** is a self-hosted, end-to-end encrypted sync server for your
browser. It keeps bookmarks, history, and (optionally) open tabs/windows/tab
groups in sync across your own devices — through a server you run yourself,
with no Google, Microsoft, or other third-party account involved.

Built for **Helium Browser** and any other Chromium-based browser (Chrome,
Brave, Edge, Vivaldi, etc.) via a Manifest V3 extension.

Passwords are explicitly out of scope — pair HelixSync with
[Vaultwarden](https://github.com/dani-garcia/vaultwarden) for that. Cookies
and site sessions are never synchronized.

## Why HelixSync

- **You own the data.** Everything lives in a Postgres database on your own
  server. No third-party sync service ever sees your browsing data.
- **End-to-end encrypted.** With encryption enabled (the default), the
  server only ever stores opaque ciphertext — it cannot read your
  bookmarks or history even if it wanted to. See
  [`docs/encryption.md`](docs/encryption.md).
- **Multi-device.** Register as many devices as you like, review and revoke
  them individually from the web dashboard.
- **Real conflict resolution**, not last-write-wins for everything — see
  [`docs/protocol.md`](docs/protocol.md) for the sync protocol.
- **Self-hosted, one stack.** A single `docker compose up` gets you the API
  server, database, and web dashboard running.

## What it syncs

| Data           | Status                                                   |
|----------------|-----------------------------------------------------------|
| Bookmarks      | Full sync, including folders and moves                    |
| History        | Synced; see [Limitations](#limitations) for a Chrome API caveat |
| Tabs / windows | Optional, with a choice of automatic or ask-before-restore policy |
| Tab groups     | Synced, including title/color/collapsed state              |
| Passwords      | Out of scope — use a dedicated password manager            |

## Architecture

```text
                         Internet
                            |
                            | HTTPS
                            v
                  +--------------------+
                  | Reverse Proxy      |
                  | Caddy / Nginx      |
                  +---------+----------+
                            |
              +-------------v-------------+
              |      HelixSync Server     |
              |  REST API + WebSocket     |
              |  Auth, Sync, Devices      |
              +-------------+-------------+
                            |
                     +------v------+
                     | PostgreSQL  |
                     +-------------+

              +-----------------------------+
              |                             |
              v                             v
       +---------------+             +---------------+
       | Your Browser  |             | Your Browser  |
       |  (device #1)  |             |  (device #2)  |
       +---------------+             +---------------+
```

- **`server/`** — Rust + Axum + SQLx + PostgreSQL sync API.
- **`web/`** — React + TypeScript dashboard for accounts, devices, and
  sync settings.
- **`extension/`** — TypeScript Manifest V3 browser extension.

See [`docs/architecture.md`](docs/architecture.md) for the full breakdown.

## Quick start

```bash
git clone https://github.com/GhaziAlibi/helixsync.git
cd helixsync
cp .env.example .env
# edit .env — at minimum set POSTGRES_PASSWORD and JWT_SIGNING_KEY
docker compose up -d --build
```

This starts the API server, PostgreSQL, and the web dashboard
(`http://localhost:5173` by default). Database migrations run
automatically on startup.

Prebuilt images are also published to GHCR if you'd rather not build
locally:

```bash
docker pull ghcr.io/ghazialibi/helixsync-server:latest
docker pull ghcr.io/ghazialibi/helixsync-web:latest
```

Pin to a specific released version instead of `latest` (e.g. `0.1.0`) — see
[Releases](https://github.com/GhaziAlibi/helixsync/releases) for the full
list, and the packaged extension zip for each version.

To deploy straight from these images instead of building locally —
including pasting a stack into Portainer with no repo checkout on the host
at all — use [`docker-compose.prod.yml`](docker-compose.prod.yml):

```bash
docker compose -f docker-compose.prod.yml up -d
```

See [docs/deployment.md](docs/deployment.md#deploying-prebuilt-images-portainer-etc)
for details.

Then:

1. Open the web dashboard and register an account.
2. Build and load the extension:

   ```bash
   cd extension
   npm install
   npm run build
   ```

   Load `extension/dist/` as an unpacked extension
   (`chrome://extensions` → Developer mode → Load unpacked).
3. Open the extension's popup and set the **Server URL** to the same
   origin as your web dashboard (e.g. `http://localhost:5173`) — there's
   no separate options page, the popup is the whole UI, including settings
   (gear icon once connected).

Full deployment details — reverse proxy setup, backups, migrations — are
in [`docs/deployment.md`](docs/deployment.md).

## Security

Encryption is on by default (`REQUIRE_ENCRYPTION=true`) and this should
stay enabled for any deployment holding real data — see
[`docs/encryption.md`](docs/encryption.md) and [`docs/security.md`](docs/security.md)
for the full model and threat considerations.

If you find a security issue, please report it privately rather than
opening a public GitHub issue.

## Limitations

- **History visit times aren't reproduced remotely.** Chrome's extension
  APIs don't support setting a historical timestamp when writing to
  `chrome://history`, so a synced visit shows up as "visited now" there.
  The real title, URL, and original visit time are still preserved and
  shown in the extension popup under "Synced history from other devices".
- **Changing your account password changes your encryption key.** Because
  the encryption key is derived from your password, a password change
  affects your ability to decrypt already-synced data on other devices —
  the web dashboard's "Change password" form explains what to expect.
  See [`docs/encryption.md`](docs/encryption.md) for the full rationale
  and trade-offs.
- Tab group restore and "ask before restoring" tabs rely on Chromium APIs
  that aren't exercised by the automated test suite and are verified
  manually — see the [Development](#development) section below if you want
  to help test across more Chromium builds.

## Development

**Server** (needs a local Postgres):

```bash
cd server
cp .env.example .env
cargo test
cargo run
```

**Extension**:

```bash
cd extension
npm install
npm run typecheck
npm test
npm run build
```

**Web**:

```bash
cd web
npm install
npm run dev
```

Protocol, security, and encryption design docs live in [`docs/`](docs/) —
start there before sending a pull request that touches sync behavior.

## License

[MIT](LICENSE)
