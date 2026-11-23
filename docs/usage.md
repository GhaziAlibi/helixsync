# Using HelixSync

## Extension popup

The popup is the whole extension UI. It shows the sync
status and when it last synced. The gear icon opens the settings once connected: which data to sync
(bookmarks, history, tabs, tab groups), the tab restore policy (disabled, ask
before restoring, or restore automatically), and history retention (7 days to
unlimited). **Disconnect** revokes the device on the server and removes its
local data. Under **Account**, **Change on the web** opens the dashboard's
password form. When another browser or the dashboard asks to log in with this
device, the toolbar icon shows **!** and the popup lists the request with its
phrase, to approve or deny.

## Restore points

The clock icon in the popup lists the saved copies of your
bookmarks. Your browsers make one daily, and before a restore, a first import,
a full resync, or a large deletion; **Create restore point** makes one on
demand. **Restore…** rolls back everything or one folder: *Merge* brings back
what is missing and undoes edits without deleting anything, *Exact* also
removes bookmarks the point doesn't have. A preview shows what would change,
and a copy of your current bookmarks is saved first, so a restore can itself be
undone. Only pinned points are kept for good: unpinned ones are removed
oldest first when space runs out, and after 90 days. See
[`protocol.md`](protocol.md) §16.

## Selective sync (rulesets)

By default every device syncs everything you
turned on. Rulesets let you keep some things off some devices, for example your
personal folders and local development sites off the office computers.

1. In the dashboard open **Rulesets** and unlock the Vault (the page picks
   folders from your decrypted bookmarks).
2. Click **New ruleset**, name it, and add rules.
3. Under **Devices in this ruleset** tick the browsers it applies to, then
   **Save devices**. A device can be in several rulesets and applies all of
   them together; one ruleset can hold any number of devices.
4. Check it on the **Devices** tab: pick a device to see its rulesets and type
   an address to see which rule would block it.

| Rule | Effect |
|------|--------|
| Don't sync a folder | That folder and everything in it stays on the device that has it and is not sent or received |
| Only sync a folder | Only the chosen folders (and what is in them) sync; everything else bookmark-wise stays local. An exclude always wins over an include |
| Block a domain | Visits to the domain and its subdomains are not synced (`example.com` blocks `www.example.com`, not `notexample.com`) |
| Block a pattern | Visits to addresses matching a regular expression are not synced (case-insensitive, up to 20 patterns of 200 characters per ruleset) |
| Block local addresses | Visits to `localhost`, `*.local`, `*.test`, `*.internal`, `127.0.0.0/8`, `::1` and private network addresses are not synced |

Good to know:

- **History and bookmarks use different rules.** Domain, pattern and local
  rules filter browsing history only; they do not stop a bookmark to that site
  from syncing. To keep bookmarks off a device, put them in a folder and use the
  folder rules. Open tabs are not filtered by any rule.
- **Rules are forward-only and delete nothing.** They stop future data from
  being synced. History and bookmarks already uploaded stay on the server and
  your other devices, and a folder you exclude after it was synced is frozen on
  that device rather than removed. Lifting a rule later catches the device up
  without creating duplicates.
- **Every account has a Default ruleset** with no rules. Every new device joins
  it automatically; it can't be deleted or renamed, and a device can be removed
  from it like from any other.
- **Extensions older than the release that added rulesets ignore them.** The
  dashboard flags devices that are assigned to a ruleset but too old (or of
  unknown version) to apply it. The popup shows which rulesets the device is in,
  read-only.
- **Rulesets are private.** They are encrypted in your browser with your
  account key; the server only stores ciphertext and which devices are in which
  ruleset. A server you don't control could still withhold them, so a device
  would then sync more than you intended. See
  [`protocol.md`](protocol.md) §17.

## Web dashboard


| Page | What you can do |
|------|-----------------|
| Dashboard | Connection and sync health, last sync, device count, how many bookmarks, history items and tabs are synced, storage used against your limit, and recent devices |
| Vault | Read-only view of your bookmarks (folder tree), history (newest first) and open tabs (by device, window and tab group), with one search box. For a phone or a locked-down computer where the extension can't be installed; installable as an app (PWA). Decrypted in the browser's memory only: after a reload, 5 minutes idle or logout it asks for your password again. Nothing can be changed from it |
| Devices | List, rename and revoke connected browsers |
| Rulesets | Selective sync: make named rulesets (folders not to sync or to sync exclusively, domains and address patterns to keep out of history, local and development addresses) and assign devices to them; each device applies the rules of all its rulesets. Encrypted in your browser, so the server can't read them. Needs the Vault unlocked (it picks folders from your decrypted bookmarks). Rules are forward-only, and extensions older than the release that added them ignore them. See [`protocol.md`](protocol.md) §17 |
| Synchronization | The same sync settings as the popup, kept in one place |
| Restore points | See, pin and delete your bookmark restore points, switch automatic ones off, and see the space they use. Restoring is done in the extension |
| Security | Check encryption status, review and revoke web sessions, change your password, get a new recovery code, delete your account |

## Changing your password

re-wraps your account key under the new password.
Nothing already synced becomes unreadable; each browser simply signs in again
with the new password.

## Forgot your password?

On the sign-in page, enter your email, your
recovery code and a new password. Your data stays readable, every web session
is signed out, and you get a new recovery code (each one works once). To just
get into the dashboard, **Log in with a device** lets a connected browser
approve you. If you lost the recovery code as well, the server's operator can
delete the account with `helixsync-server delete-account <email>` so you can
register again; your browsers upload their bookmarks and history again when
you reconnect them. See [`encryption.md`](encryption.md) §9.

## Deleting your account

(Security → Danger zone) permanently removes the
account and everything stored under it, and connected browsers stop syncing.
It asks for your password and for you to type `DELETE`.
