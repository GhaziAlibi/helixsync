# HelixSync

[![CI](https://github.com/GhaziAlibi/helixsync/actions/workflows/ci.yml/badge.svg)](https://github.com/GhaziAlibi/helixsync/actions/workflows/ci.yml)
[![Release](https://github.com/GhaziAlibi/helixsync/actions/workflows/release.yml/badge.svg)](https://github.com/GhaziAlibi/helixsync/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-HelixSync-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/helixsync/pkklkldoippchkhpokglpolepbcbjdfk)
[![Firefox Add-ons](https://img.shields.io/badge/Firefox_Add--ons-HelixSync-FF7139?logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/helixsync/)

**HelixSync** is a self-hosted, end-to-end encrypted sync server for your
browser. It syncs bookmarks, history, and (optionally) open tabs and tab
groups across your devices, through a server you run yourself.

Works with **Helium** and other Chromium browsers (116+), and **Firefox**
desktop (159+).

- **You own the data.** Everything lives in PostgreSQL on your server.
- **End-to-end encrypted.** The server only stores ciphertext; your password
  never leaves your devices.
- **Multi-device.** Connect any number of browsers; manage them from the web
  dashboard.
- **Simple to run.** One `docker compose up`.

Passwords, cookies and site sessions are **not** synced.

## What it syncs

| Data           | Status                                             |
|----------------|----------------------------------------------------|
| Bookmarks      | Full sync, including folders and moves             |
| History        | Synced into the browser's own history ([limits](docs/limitations.md)) |
| Tabs / windows | Optional                                           |
| Tab groups     | Title, color and collapsed state                   |
| Restore points | Encrypted bookmark snapshots you can roll back to  |
| Passwords      | Out of scope                                       |

## Quick start

```bash
git clone https://github.com/GhaziAlibi/helixsync.git
cd helixsync
cp .env.example .env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 32)|" .env
sed -i "s|^JWT_SIGNING_KEY=.*|JWT_SIGNING_KEY=$(openssl rand -base64 48)|" .env
# set HELIXSYNC_VERSION in .env to a released version, e.g. 1.1.1
docker compose -f docker-compose.prod.yml up -d
```

Then put HTTPS in front of it, register in the dashboard, install the
extension and connect. Full steps: [Installation](docs/installation.md).

## Documentation

| Document | Contents |
|----------|----------|
| [Installation](docs/installation.md) | Server setup, account, extension, configuration, updates and backups |
| [Usage](docs/usage.md) | Extension popup, restore points, rulesets, web dashboard, passwords |
| [Troubleshooting](docs/troubleshooting.md) | Common errors and fixes |
| [Limitations](docs/limitations.md) | Known limits |
| [Deployment](docs/deployment.md) | Operating a server: proxy, config reference, backups, migrations |
| [Architecture](docs/architecture.md) | Components, data flow, topology |
| [Protocol](docs/protocol.md) | Sync protocol and REST/WebSocket API |
| [Encryption](docs/encryption.md) | Key hierarchy and encryption envelope |
| [Security](docs/security.md) | Threat model and hardening |
| [Firefox](docs/firefox.md) · [Safari](docs/safari.md) | Browser-specific notes |
| [Releasing](docs/releasing.md) | Release process (maintainers) |
| [Privacy](PRIVACY.md) · [Changelog](CHANGELOG.md) · [Accessibility](ACCESSIBILITY.md) | |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as
described in [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE). Third-party licenses ship in `THIRD_PARTY_LICENSES.txt` in
each build.
