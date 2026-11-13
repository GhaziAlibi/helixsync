# HelixSync Privacy Policy

_Last updated: 2026-11-12_

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
| `contextMenus`         | Add the "Send to device" right-click menu.                           |
| `notifications` (optional) | Show a notification when a tab is sent or arrives, only if you turn it on. |
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

## What your server stores

The server you configure stores the following in its PostgreSQL database:

- **Account:** your email address, a hash of a sign-in key derived from your
  password (never the password itself), the key-derivation salt and
  parameters, and your account key in encrypted form. The server cannot decrypt
  it.
- **Devices:** the name you give each browser, its browser name and version,
  platform and extension version, and when it was last seen.
- **Dashboard sessions:** a hash of the session identifier, its expiry, and the
  IP address and user agent of the browser that signed in.
- **Synced data:** encrypted bookmark, history and tab payloads. Stored beside
  them, unencrypted, so the server can order and store them: the type and random
  identifier of each object, the kind of change, timestamps and sizes, and the
  number of history visits per hour (counts only, never URLs or titles).
- **Restore points:** encrypted copies of your bookmark tree that your browsers
  save so you can roll back (daily, before a restore, and in a few other
  situations; you can also make them yourself). The server cannot read them. It
  stores beside each one, unencrypted, when it was made, by which device, what
  kind it is, its size, the number of bookmarks and whether you pinned it.
  Unpinned ones are deleted after 90 days by default
  (`RESTORE_POINT_RETENTION_DAYS`), and you can delete any of them yourself.
- **Sent tabs:** when you send a tab to another of your devices, the page
  address travels encrypted through your server to that device and is not
  stored: the server passes it on only if the other device is connected at that
  moment, and keeps nothing afterwards (no record, no log entry). The server can
  see that one of your devices sent something to another, and when.
- **Settings:** which data you sync, your tab restore policy, your history
  retention and whether automatic restore points are on.
- **Audit log:** security events such as sign-ins, device changes and password
  changes, linked to your account and device. Entries are kept for 90 days by
  default (`AUDIT_LOG_RETENTION_SECS`).

## Data retention and deletion

Data lives in the PostgreSQL database of the server you configured, under
your control.

**Deleting your account.** You can delete your account at any time, yourself:
in the web dashboard under **Security → Danger zone** (you confirm with your
password and by typing `DELETE`), or with the API call
`DELETE /api/v1/auth/account` described in
[`docs/protocol.md`](docs/protocol.md). Deletion is immediate and permanent: it
removes the account and every device, synced bookmark, history entry and tab
record, and every sign-in session from the server's database, and the server
stops accepting the account's devices. Anyone running the server can also
remove an account directly from its database. Backups the server's operator
took before the deletion keep a copy until the operator's backup retention
expires, which only that operator controls. The operator can also delete an
account at your request without your password (for example when you lost
both your password and your recovery code). Because your data is encrypted
with a key only your password or your recovery code unlocks, no one can
recover a deleted account's data afterwards.

**Disconnecting a device.** "Disconnect" in the extension's settings revokes
that device on the server (when it can be reached) and deletes the extension's
local data for it. Uninstalling the extension also deletes its local on-device
storage (settings and sync cache) immediately.

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
for privacy-related questions. For security issues, see
[`SECURITY.md`](SECURITY.md).
