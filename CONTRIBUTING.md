# Contributing to HelixSync

Thanks for helping. HelixSync is three parts that must agree with each other,
so a little context goes a long way:

| Directory     | What it is                                                        |
|---------------|-------------------------------------------------------------------|
| `server/`     | Rust (axum, SQLx) sync API and WebSocket server, PostgreSQL       |
| `web/`        | React + TypeScript dashboard (accounts, devices, settings)        |
| `extension/`  | TypeScript Manifest V3 browser extension (the sync client)        |
| `docs/`       | Architecture, protocol, encryption, security, deployment and release documents |

The documents in `docs/` are normative. Read [`docs/protocol.md`](docs/protocol.md)
and [`docs/encryption.md`](docs/encryption.md) before changing sync behavior,
and open an issue first for anything that changes the wire format or the
encryption model: a change there affects every deployed client.

By contributing you agree that your work is licensed under the project's
[MIT license](LICENSE). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Development setup

You need a recent stable Rust toolchain (with `rustfmt` and `clippy`),
Node.js 22 and npm, and PostgreSQL 16. Docker is optional; it is only needed
to try the images or the Compose stack.

### Server

1. Start a PostgreSQL 16 you can create databases in. With Docker:

   ```bash
   docker run -d --name helixsync-pg -p 5432:5432 \
     -e POSTGRES_USER=helix -e POSTGRES_PASSWORD=helix -e POSTGRES_DB=helixsync \
     postgres:16-alpine
   ```

   With a system PostgreSQL, create a superuser (or a role with `CREATEDB`)
   and a database: `createuser -s helix` and `createdb -O helix helixsync`.
   `cargo test` runs every integration test in its own throwaway database, so
   the role must be able to create databases.

2. Configure the server:

   ```bash
   cd server
   cp .env.example .env
   # set JWT_SIGNING_KEY (openssl rand -base64 48); the server refuses any key
   # that still contains "replace-me" or "change-me"
   ```

3. Apply the schema once. The server applies migrations itself when it starts,
   but the SQLx query macros are checked against the database while the code
   *compiles*, so the schema has to exist before the first `cargo build` or
   `cargo test`:

   ```bash
   psql "$DATABASE_URL" -f migrations/0001_init.sql    # or: sqlx migrate run
   ```

   (`export DATABASE_URL=...` first, with the same URL as in `.env`.)

4. Run it:

   ```bash
   cargo run          # listens on 127.0.0.1:8080
   cargo test --locked
   ```

   Tests need `DATABASE_URL` in the environment (or in `server/.env`).

#### The SQLx offline cache

The Docker image compiles with `SQLX_OFFLINE=true`, using the query metadata
committed in `server/.sqlx/` instead of a live database. If you **add or change
a `query!`, `query_as!` or `query_scalar!` macro in `server/src`**, regenerate
the cache or the image build breaks:

```bash
cargo install sqlx-cli --version '^0.8' --no-default-features --features postgres,rustls --locked   # once
cd server
cargo sqlx prepare          # DATABASE_URL set, schema applied; do not pass --tests
git add .sqlx               # includes deletions of entries that no longer apply
SQLX_OFFLINE=true cargo check --locked --lib --bins   # must pass: this is what CI runs
```

Queries in `server/tests/` use the live database and are deliberately not cached.

#### Schema changes

The whole schema is `server/migrations/0001_init.sql`. Change that file in
place; don't add a second numbered migration. Then regenerate `server/.sqlx/`
as above. SQLx records a checksum of each applied migration and the server
refuses to start when it no longer matches, so recreate your local database
after a schema change.

### Extension

```bash
cd extension
npm ci
npm run typecheck
npm test
npm run build          # output in extension/dist/
```

To try it, open `chrome://extensions`, enable Developer mode and load
`extension/dist/` as an unpacked extension. The popup is the whole UI; set its
Server URL to your dashboard's origin (HTTPS, except `localhost`).

**End-to-end test.** `npm run test:e2e` drives the built extension in two
throwaway browser profiles against a local stack: it registers on the
dashboard, connects both popups, checks that bookmark create, rename and delete
and a history visit sync between them, that open tabs sync under both "ask"
and "automatic" restore and tab groups keep their title, color and collapsed
state, and that a bookmark or visit made while the extension's service worker
is stopped is still captured, then tests Disconnect and login with device. It needs a Chromium-based browser (Chromium, Helium, Brave, ...;
branded Google Chrome ignores `--load-extension`). It creates accounts, so it
only accepts a local server; give it a stack of its own. CI doesn't run it.

```bash
# from the repository root, with .env set up as in the README
WEB_PORT=127.0.0.1:5174 docker compose -p helixsync-e2e up -d --build
cd extension && npm run build
HELIXSYNC_E2E_URL=http://localhost:5174 HELIXSYNC_E2E_BROWSER=/usr/bin/chromium npm run test:e2e
cd .. && docker compose -p helixsync-e2e down -v
```

`HELIXSYNC_E2E_BROWSER_B` runs the second device in a different browser.

### Web dashboard

```bash
cd web
npm ci
npm run typecheck
npm test
npm run build
npm run dev            # Vite dev server on :5173; needs the server on :8080
```

The dev server does not proxy `/api` for you: either serve the dashboard from
the Compose stack (`docker compose up --build`) or set `VITE_API_BASE_URL` to
the server's address and add that origin to the server's `CORS_ALLOWED_ORIGINS`.

## Checks CI runs

Every pull request runs [`ci.yml`](.github/workflows/ci.yml). Run the same
checks locally before you push:

```bash
# server/
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
SQLX_OFFLINE=true cargo check --locked --lib --bins
cargo audit                                  # cargo install cargo-audit --locked

# extension/ and web/
npm run typecheck && npm test && npm run build
npm audit --omit=dev --audit-level=high
```

The release workflow calls the same checks, and nothing is tagged, pushed or
published until they pass on `main`.

## Making a change

- **Keep pull requests focused.** One logical change each; unrelated cleanups
  go in their own PR.
- **Write the test first when you can**, and include one with every behavior
  change or bug fix. Don't skip or disable a failing test to get green.
- **Match the surrounding code**: naming, comment density, error handling.
  Comments explain *why*, not what.
- **Update the docs** that describe what you changed (`docs/protocol.md` for
  the API and wire format, `docs/security.md` for security behavior,
  `docs/deployment.md` and `.env.example` for configuration).
- **Add a line under "Unreleased" in [`CHANGELOG.md`](CHANGELOG.md)** for
  anything a user or operator will notice.
- **Commit messages**: a short imperative summary with an optional type prefix
  (`fix:`, `feat:`, `chore:`, `docs:`, `ci:`), then a body that says why.
- Never commit secrets, real browsing data, or personal information, and
  don't paste them into issues or screenshots.
- **New dependencies** must be under a permissive license that is compatible
  with MIT. For the server, the allowed licenses are listed in
  `server/about.toml`, and the server image build (which also runs on pull
  requests) fails on anything else. To check locally:
  `cargo install cargo-about --locked --version 0.9.2 --features cli`, then
  `cargo about generate --locked about.hbs` in `server/`. The web and extension
  builds list the licenses of everything they bundle in
  `dist/THIRD_PARTY_LICENSES.txt`.

### Versions and releases

[`VERSION`](VERSION) is the single source of truth for the release version.
**Don't change it, or the version in `extension/manifest.json`, in an ordinary
pull request.** On every push to `main`, the release workflow:

1. runs CI;
2. bumps the patch number in `VERSION` automatically, unless that push itself
   changed `VERSION` (a maintainer making a deliberate minor or major bump), in
   which case that value is used as-is;
3. copies the version into `extension/manifest.json`;
4. tags `vX.Y.Z`, builds and pushes the server and web images, and attaches the
   extension zip to the GitHub release.

`extension/package.json`, `web/package.json` and `server/Cargo.toml` carry the
version too, but nothing depends on them matching exactly between releases; a
maintainer updates them when bumping a minor or major version. The release
procedure, and the repository setup it needs, are in
[`docs/releasing.md`](docs/releasing.md).

## Reporting bugs and proposing features

Use the issue templates. For anything security-related, follow
[SECURITY.md](SECURITY.md) instead.
