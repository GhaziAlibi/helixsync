# HelixSync Privacy Policy

_Last updated: 2026-09-14_

HelixSync is a self-hosted browser extension. There is no HelixSync-operated
service, and the developer does not collect, receive, or have access to any
of your data.

## What the extension accesses, and why

| Permission            | Purpose                                                             |
|------------------------|----------------------------------------------------------------------|
| `bookmarks`            | Read and write bookmarks so they can be synced.                      |
| `history`              | Read and write browsing history so it can be synced.                 |
| `tabs`                 | Read open tabs/windows to optionally sync them.                      |
| `tabGroups` (optional) | Read/apply tab group title, color, and collapsed state, if supported.|
| `storage`, `unlimitedStorage` | Store your settings and a local sync cache/queue on-device.  |
| `alarms`               | Schedule periodic background sync checks.                            |
| Host permission (optional, requested per-site) | Only for the exact server address you enter when connecting a device — requested once, for that origin only, never for "all sites." |

## Where your data goes

The extension only ever communicates with the server address **you**
configure — a HelixSync server that you run yourself (or that someone you
trust runs). It never sends data to the developer, to any HelixSync-operated
service (none exists), or to any third party.

With encryption enabled (the default for any real deployment, see
[`docs/encryption.md`](docs/encryption.md)), your bookmarks, history, and tab
data are encrypted on your device before being sent, and your configured
server only ever stores ciphertext it cannot read.

## Data retention and deletion

Data lives in the PostgreSQL database of the server you configured, under
your control. Deleting your account or database on that server deletes your
data. Uninstalling the extension deletes its local on-device storage
(settings and sync cache) immediately.

## Analytics and tracking

None. The extension contains no analytics, telemetry, crash reporting, or
advertising code of any kind.

## Changes to this policy

Changes will be made via pull requests to this file in the
[HelixSync repository](https://github.com/GhaziAlibi/helixsync), visible in
its commit history.

## Contact

Open an issue at
[github.com/GhaziAlibi/helixsync](https://github.com/GhaziAlibi/helixsync/issues)
for privacy-related questions. For security issues, see the
[Security section of the README](README.md#security).
