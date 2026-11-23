# Installing HelixSync

Installing HelixSync takes four steps: run the server, create your account,
install the extension, and connect your browser.

## 1. Run the server

You need [Docker](https://docs.docker.com/engine/install/) with the Compose
plugin for options A to C (option E needs no Docker). Pick the deployment
that suits you:

| Option | Best for | Needs |
|--------|----------|-------|
| [A. Docker Compose, prebuilt images](#a-docker-compose-with-prebuilt-images-recommended) | Most self-hosters | Docker |
| [B. Docker Compose, build from source](#b-docker-compose-built-from-source) | Trying local changes, auditing what you run | Docker, a repo checkout |
| [C. Portainer or another stack UI](#c-portainer-or-another-stack-ui) | Managing containers through a UI, no checkout on the host | Docker, Portainer |
| [D. Behind a reverse proxy with HTTPS](#d-reverse-proxy-with-https) | Any use from another machine | A domain name, a TLS proxy |
| [E. Without Docker](#e-without-docker) | Bare-metal or VM installs | Rust, Node.js, PostgreSQL 16 |
| [F. Local trial on `localhost`](#f-local-trial-on-localhost) | Looking around before committing | Docker |

**HTTPS is required for anything but `localhost`.** The dashboard's session
cookies are marked `Secure`, so a browser won't keep you signed in over plain
HTTP, and the extension refuses a Server URL that isn't `https://` (only
`localhost`, `127.0.0.1` and `[::1]` may use `http://`). Options A to C start
an HTTP server on port 5173; put a TLS-terminating proxy in front of it
(option D) before using it from another machine.

### Configure the secrets (options A to D)

Every Compose-based option reads its settings from a `.env` file. Get the
repository (for option C you only need the file contents, so you can skip the
clone), create `.env` from the example, and fill in the two secrets:

```bash
git clone https://github.com/GhaziAlibi/helixsync.git
cd helixsync
cp .env.example .env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 32)|" .env
sed -i "s|^JWT_SIGNING_KEY=.*|JWT_SIGNING_KEY=$(openssl rand -base64 48)|" .env
```

(That is GNU `sed`; on macOS use `sed -i ''`.) Then:

- `POSTGRES_PASSWORD` protects the database. Use a hex value as above: the
  password is embedded in a connection URL, where characters such as `/` or
  `@` would break it. The server refuses to start while it still contains the
  placeholder text.
- `JWT_SIGNING_KEY` signs device access tokens. The server refuses to start
  while it still contains the placeholder text (`change-me` or `replace-me`).
  Keep it stable: changing it invalidates every outstanding access token
  (refresh tokens are unaffected).
- Set `CORS_ALLOWED_ORIGINS` to your public dashboard origin, for example
  `https://sync.example.com`. Only requests from a different origin are
  checked against it; with the default single-origin setup it is not used.

The other variables are optional; see [Configuration](#configuration).

### A. Docker Compose with prebuilt images (recommended)

Pulls the images published for every release to GitHub Container Registry, so
nothing is compiled on your machine.

```bash
# in the helixsync directory, with .env created as above:
# set HELIXSYNC_VERSION in .env to a released version, for example
#   HELIXSYNC_VERSION=1.0.0
docker compose -f docker-compose.prod.yml up -d
```

`HELIXSYNC_VERSION` is required: the stack refuses to start without it rather
than following a moving `latest` tag. See
[Releases](https://github.com/GhaziAlibi/helixsync/releases) for the available
versions. Database migrations run automatically when the server starts.

### B. Docker Compose, built from source

Builds the `server` and `web` images locally from the repository:

```bash
# in the helixsync directory, with .env created as above
docker compose up -d --build
```

The first build takes a few minutes (it compiles the Rust server and builds
the dashboard). The dashboard is then at `http://localhost:5173`.

### C. Portainer or another stack UI

[`docker-compose.prod.yml`](../docker-compose.prod.yml) is self-contained and
pulls prebuilt images, so you can paste it into Portainer's **Stacks → Add
stack → Web editor** with no files on the host. Add the variables from
[`.env.example`](../.env.example) (at least `POSTGRES_PASSWORD`, `JWT_SIGNING_KEY`,
`CORS_ALLOWED_ORIGINS` and `HELIXSYNC_VERSION`) in the stack's environment
section, and deploy. Any other tool that accepts a Compose file works the same
way.

### D. Reverse proxy with HTTPS

Options A to C leave `web` listening on `WEB_PORT` (5173). To use HelixSync
from other machines, put a TLS-terminating proxy in front of it. The proxy
must forward WebSocket upgrades (the extension uses one) and pass the client's
scheme (`X-Forwarded-Proto`) and address (`X-Forwarded-For`) on.

[Caddy](https://caddyserver.com/) does all of that by default. If it runs in
the same Docker network as `web`:

```caddyfile
sync.example.com {
    reverse_proxy web:80
}
```

For nginx:

```nginx
location / {
    proxy_pass http://web:80;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # nginx's default request limit (1 MB) is far below the server's upload
    # limit, so raise it, or large history uploads fail with 413.
    client_max_body_size 150m;
    proxy_read_timeout 3600s;
}
```

Traefik and other proxies need the same three things (and, like nginx, must
allow large request bodies). Details, including how
real client IPs reach the rate limiter and when to narrow
`WEB_TRUSTED_PROXY_CIDRS`, are in [`deployment.md`](deployment.md).

### E. Without Docker

Run the server binary and PostgreSQL directly, and serve the dashboard's
static files from a web server of your choice. You need a stable Rust
toolchain with a C compiler, Node.js 22, and PostgreSQL 16.

```bash
git clone https://github.com/GhaziAlibi/helixsync.git
cd helixsync

# 1. Database (run as the PostgreSQL superuser; use a plain alphanumeric password)
sudo -u postgres createuser helixsync
sudo -u postgres createdb -O helixsync helixsync
sudo -u postgres psql -c "ALTER ROLE helixsync PASSWORD 'choose-a-password'"

# 2. Server. Builds offline from the committed query cache: no database is needed to compile.
cd server
SQLX_OFFLINE=true cargo build --release --locked

# 3. Dashboard: builds static files into web/dist
cd ../web
npm ci
npm run build
```

Configure the server with a `.env` file in the directory you run it from (it
is read at startup and is git-ignored):

```bash
cd ../server
cp .env.example .env
chmod 600 .env
```

Edit `.env`: set `DATABASE_URL` to
`postgres://helixsync:choose-a-password@127.0.0.1:5432/helixsync`, set
`JWT_SIGNING_KEY` to the output of `openssl rand -base64 48`, and add
`BEHIND_PROXY=true` and `CORS_ALLOWED_ORIGINS=https://sync.example.com`. Keep
`BIND_ADDR=127.0.0.1:8080`, so the proxy below is the only way in. Then start
it:

```bash
./target/release/helixsync-server
```

The server applies its database migrations itself on startup. To keep it
running, use a service manager; a systemd unit is in
[`deployment.md`](deployment.md#running-without-docker).

Finally, serve `web/dist` and send `/api/` to the server from one origin, with
TLS. For example with Caddy, after copying `web/dist` to `/var/www/helixsync`:

```caddyfile
sync.example.com {
    handle /api/* {
        reverse_proxy 127.0.0.1:8080 {
            # the server trusts this header for rate limiting (BEHIND_PROXY=true)
            header_up X-Real-IP {remote_host}
        }
    }
    handle {
        root * /var/www/helixsync
        try_files {path} /index.html
        file_server
    }
}
```

Set `BEHIND_PROXY=true` only when a proxy you control is the sole way to reach
the server, as here. This setup doesn't get the security headers that the
`web` image's nginx adds; copy them from
[`web/security-headers.conf`](../web/security-headers.conf) into your proxy.

### F. Local trial on `localhost`

To look around without a domain or certificate, use option B and open
`http://localhost:5173`. In the extension, use `http://localhost:5173` as the
Server URL; loopback addresses are the one case where plain HTTP is allowed.

Compose publishes `WEB_PORT` on all network interfaces by default. On a shared
network, change the `web` service's port mapping to
`"127.0.0.1:${WEB_PORT:-5173}:80"` so only your machine can reach it.

## 2. Create your account

Open the dashboard in your browser (`https://sync.example.com`, or
`http://localhost:5173` for a trial) and choose **Register**. Enter an email
and a password. The account key that encrypts your data is created in your
browser and locked with this password, so neither the server operator nor the
developer can reset it or read your data without it.

The dashboard then shows your **recovery code**, once. Save it somewhere safe
and offline (print it, or keep it in a password manager): if you forget your
password, it's the only way to set a new one without losing your data.

Registration is open by default. **On any instance reachable from the
internet, close it once your accounts exist** (see
[Lock it down](#4-connect-your-browser-and-lock-the-server-down)).

## 3. Install the extension

Pick one:

- **Chrome Web Store:**
  [HelixSync](https://chromewebstore.google.com/detail/helixsync/pkklkldoippchkhpokglpolepbcbjdfk).
- **Firefox Add-ons:**
  [HelixSync](https://addons.mozilla.org/en-US/firefox/addon/helixsync/).
- **Prebuilt zip:** download `helixsync-extension-<version>.zip` from the
  [Releases](https://github.com/GhaziAlibi/helixsync/releases) page, unzip it,
  open `chrome://extensions` (or your browser's equivalent), enable
  **Developer mode**, choose **Load unpacked**, and select the unzipped folder.
- **From source:**

  ```bash
  cd extension
  npm ci
  npm run build
  ```

  Then load `extension/dist/` as an unpacked extension, as above.
- **Firefox (from source):** build with `npm run build:firefox` and load it as described
  in [`firefox.md`](firefox.md).

## 4. Connect your browser, and lock the server down

1. Click the HelixSync toolbar icon. In **Connect this browser**, enter the
   **Server URL** (the same origin as your dashboard, for example
   `https://sync.example.com`), your **Email**, your **Password**, and a
   **Device name** for this browser.
2. Click **Connect**. The browser asks for permission to talk to that one
   server address; allow it. The extension requests access to that origin only,
   never to all sites.
3. Repeat on every browser you want to sync. Each one signs in with the same
   email and password and ends up with the same account key. Instead of the
   password, you can click **Log in with device instead** and approve the
   request from the popup of a browser that's already connected, after
   checking that both show the same phrase.
4. **Close registration.** Once your accounts exist, set
   `ALLOW_REGISTRATION=false` in `.env` and restart the server
   (`docker compose up -d`, or restart the process for option E). Existing
   accounts, logins and devices are unaffected.

Initial sync starts right away. Large histories are uploaded in chunks in the
background, so the first full sync of a big profile can take a while.

## Configuration

Compose reads these from `.env` (see [`.env.example`](../.env.example), which
documents each one; every setting the server reads is listed in
[`deployment.md`](deployment.md#configuration-reference)). The ones
you are most likely to touch:

| Variable | Default | Purpose |
|----------|---------|---------|
| `POSTGRES_PASSWORD` | none, required | Database password |
| `JWT_SIGNING_KEY` | none, required | Signs device access tokens; at least 32 characters, never a placeholder |
| `HELIXSYNC_VERSION` | none, required for `docker-compose.prod.yml` | Released image version to run |
| `CORS_ALLOWED_ORIGINS` | empty | Origins allowed to call the API from a different origin |
| `ALLOW_REGISTRATION` | `true` | Set to `false` to close sign-ups once your accounts exist |
| `REQUIRE_ENCRYPTION` | `true` | Reject unencrypted sync data. Leave it on for real data |
| `MAX_ACCOUNT_STORAGE_BYTES` | 5 GiB | Cap on stored sync data per account |
| `WEB_PORT` | `5173` | Host port the dashboard listens on |
| `WEB_TRUSTED_PROXY_CIDRS` | private ranges | Proxies whose `X-Forwarded-For` is trusted; narrow it if `web` is published directly |
| `LOG_FORMAT` | `text` | `json` writes one JSON object per log line, for a log collector |

Running the server outside Docker uses the same names plus `DATABASE_URL`,
`BIND_ADDR` (default `127.0.0.1:8080`) and `BEHIND_PROXY`; see
[`server/.env.example`](../server/.env.example) and
[`deployment.md`](deployment.md). The server checks its settings at
startup and refuses to start, naming the variable, when one is invalid.

## Before you expose it to the internet

- [ ] **HTTPS** through a reverse proxy in front of `web`. Nothing here works
  properly over plain HTTP.
- [ ] Strong, unique **`POSTGRES_PASSWORD`** and **`JWT_SIGNING_KEY`**.
- [ ] **`REQUIRE_ENCRYPTION`** left at its default (`true`).
- [ ] **`ALLOW_REGISTRATION=false`** once your accounts exist, or anyone who
  finds the URL can sign up and store up to `MAX_ACCOUNT_STORAGE_BYTES` (5 GiB
  by default) each on your server.
- [ ] **Backups** of the database, copied off the host, with a tested restore
  (see below). Backups don't help with a forgotten password; only the user's
  recovery code does.
- [ ] **`HELIXSYNC_VERSION`** pinned to a released version when using
  `docker-compose.prod.yml`, and updated deliberately.
- [ ] If `web` is published directly rather than reached only through your
  proxy on the Docker network, narrow **`WEB_TRUSTED_PROXY_CIDRS`**, or bind
  `WEB_PORT` to loopback.

## Updating and backups

Update by choosing a newer `HELIXSYNC_VERSION` in `.env` (prebuilt images) and
restarting:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

If you build from source, pull the repository and rebuild instead
(`git pull && docker compose up -d --build`).

Read the [changelog](../CHANGELOG.md) first: a release can contain breaking
changes, and its upgrade notes say what to do. Migrations run automatically.

**Backups.** The server can write a scheduled, encrypted dump of the whole
database into the `helix-backup` volume. It is on by default and starts as
soon as you set a key in `.env` (until then the server logs a warning and
writes nothing):

```bash
BACKUP_ENCRYPTION_KEY=...   # openssl rand -base64 48; keep a copy outside the server
```

By default it runs every day at 03:00 UTC and keeps the newest 7 scheduled
files (`BACKUP_CRON`, `BACKUP_KEEP_LAST`; manual and pre-restore files are kept
until you delete them). Copying the files off the host is up to
you. Restore is a command on the host, with the server stopped:

```bash
docker compose stop server
docker compose run --rm server restore-backup      # newest backup, or name a file
docker compose up -d server
```

`backup-now` and `list-backups` work the same way. The files hold each
account's key only in wrapped form, so they are useless without the account
password, but they also contain account emails and device names: keep them as
private as the database. Details, restore steps and a disaster recovery
checklist are in [`deployment.md`](deployment.md#backups). Plain
`pg_dump` (`docker compose exec postgres pg_dump -U helixsync helixsync`) still
works too.
