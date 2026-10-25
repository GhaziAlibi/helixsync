# Why HelixSync doesn't support Safari

HelixSync syncs through a browser extension, and Safari's extension platform
doesn't offer the APIs that sync is built on. A native macOS app that edits
Safari's files directly was looked into as well, and it doesn't hold up
either. This page explains both, then shows how to move from Safari to a
Chromium-based browser and keep your bookmarks.

## The extension APIs Safari lacks

Safari runs Manifest V3 extensions, but it leaves out several of the
`chrome.*` APIs HelixSync depends on. Support per [MDN's browser compatibility
data](https://github.com/mdn/browser-compat-data), for Safari on macOS and
iOS:

| API HelixSync uses | Used for | Safari |
|--------------------|----------|--------|
| `bookmarks` | Reading, writing and watching bookmarks | Not supported |
| `history` (`search`, `getVisits`, `addUrl`, `onVisited`) | Reading visits and adding synced ones | Not supported |
| `tabGroups`, `tabs.group` | Tab group sync | Not supported |
| `tabs`, `windows`, `storage`, `alarms`, `permissions`, `action` | Tabs and windows, local state | Supported (Safari 16.4 or later) |

Apple has confirmed on its developer forums that the bookmarks extension API
[isn't supported in Safari](https://developer.apple.com/forums/thread/721635).
Other bookmark sync extensions are stuck on the same gap: Floccus, for
example, [lists Safari as unsupported](https://addons.mozilla.org/firefox/addon/floccus/).

A Safari build of the extension could therefore sync only tabs and windows.
Bookmarks, history and tab groups, which are most of what HelixSync does,
would be missing.

## Why not a native macOS app instead

Without extension APIs, the only other way in is a separate macOS app that
reads and writes Safari's own data files: `~/Library/Safari/Bookmarks.plist`
for bookmarks and the SQLite database `~/Library/Safari/History.db` for
history. Neither file is meant for other apps.

**Bookmarks.** Apple dropped official support for other apps editing Safari's
bookmarks in 2011. The one maintained product that still does it, Sheep
Systems' BookMacster/Synkmark, describes its method as
[reverse-engineered, increasingly complicated every year, and liable to break with any macOS update](https://sheepsystems.com/bookmacster/HelpBook/SSYMH.04.09.html).
Its [version history](https://sheepsystems.com/bookmacster/HelpBook/SSYMH.05.04.html)
shows what that takes: following Safari's private file-locking protocol,
waiting for iCloud's sync agent to release the file, writing the change
records iCloud's CloudKit-based sync expects, keeping every folder under 500
items, and fixing breakage after macOS releases. Editing the file without all
of that
[corrupts iCloud bookmarks across devices](https://www.sheepsystems.com/files/support_articles/bkmx/rebuilding-icloud-bookmarks.html),
even with iCloud Safari sync turned off. None of this is documented by Apple
or available as open source.

**History.** `History.db` can be read once the app is granted Full Disk
Access, but there is no documented way to write to it, and no product or
public code was found that does. Apple protects the database with a
[data vault](https://developer.apple.com/forums/thread/687633), which Apple
describes as
["not a third-party developer opportunity"](https://developer.apple.com/forums/thread/678819).
Safari's only supported way to add history is a manual one:
**File > Import Browsing Data from File or Folder** with an exported
`History.json`. That can't drive continuous sync, so history could only flow
out of Safari, never into it.

**Tab groups.** No API or file format is available for them.

**Distribution.** Full Disk Access
[has no effect on sandboxed apps](https://developer.apple.com/forums/thread/124895)
and has no entitlement, so such an app couldn't ship through the Mac App
Store.

In short, a native app would give two-way bookmark sync that depends on
reverse engineering Apple can break every year, one-way history, and no tab
groups. That isn't a foundation HelixSync can promise to keep working.

## Moving from Safari to a Chromium-based browser

To use HelixSync, switch to Helium or another Chromium-based browser (Chrome,
Brave, Edge, Vivaldi, ...), bring your Safari bookmarks over, then install the
extension.

1. **Export from Safari.** In Safari, choose **File > Export Browsing Data to
   File**, select **Bookmarks** (and a profile, if you use several), click
   **Download** and save the `.zip` file. Unzip it; your bookmarks are in
   `Bookmarks.html`.
2. **Import into the Chromium browser.** Open its **Import bookmarks and
   settings** page (in Chrome: **More > Bookmarks and lists > Import
   bookmarks and settings**), choose **Bookmarks HTML File**, and select
   `Bookmarks.html`. If the browser already has bookmarks, the imported ones go
   into a new folder.
3. **Delete the export.** The exported files
   [are not encrypted](https://support.apple.com/guide/safari/ibrwebf10132/mac),
   so delete the `.zip` and the unzipped folder once the import is done.
4. **Install and connect HelixSync.** Follow
   [Install the extension](../README.md#3-install-the-extension) and
   [Connect your browser](../README.md#4-connect-your-browser-and-lock-the-server-down).
   Bookmarks already in the browser are uploaded on first connect, and any
   you import later are picked up as they're added.

Safari history doesn't carry over. Chromium imports only bookmarks from
Safari, both from an HTML file and through its built-in Safari importer, so
HelixSync syncs the history the new browser records from then on.
