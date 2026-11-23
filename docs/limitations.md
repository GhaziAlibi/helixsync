# Limitations

- **History from other devices arrives dated when it was synced, without a
  title.** HelixSync adds each synced URL to the browser's own history, so it
  shows up in `chrome://history` and address-bar suggestions. Chrome's
  extension APIs can't write a visit with a historical timestamp or title
  (`chrome.history.addUrl` can only add "visited now", with no title), so the
  entry is dated when it was synced and stays untitled until you open the page.
  Each distinct `http`/`https` URL is added once, and a URL your browser
  already has is left alone. Every visit is read, including a whole first
  import, so a large profile takes a while: the work is paced to keep CPU use
  low.
- **Retention buckets are hourly, not exact.** The dashboard's "History items
  synced" count is tracked in per-hour buckets, so a visit right at the edge of
  your retention window may count for up to an hour longer or shorter than the
  exact cutoff.
- **A URL whose only visits are hidden redirect hops can't always be
  counted.** Chrome's history APIs don't expose every intermediate redirect
  visit to extensions, so a small number of such visits may not be enumerable
  during import.
- **Losing both your password and your recovery code loses your data.** Your
  data is encrypted with a random account key that only your password or your
  recovery code can unlock; the server never sees either, so neither the
  operator nor the developer can reset them or get your data back. The operator
  can only delete the account so you can start over. Keep the recovery code
  private: like the password, it unlocks everything. See
  [`encryption.md`](encryption.md) §9.
- **One server process per database.** Rate limits, short-lived auth caches
  and WebSocket notifications are kept in the server's memory, so running
  several replicas behind a load balancer isn't supported. See
  [`deployment.md`](deployment.md).
- **Use the web dashboard only on a server you trust.** Its code is served by
  that server, so a compromised server could capture the password you type
  there, and, since the Vault page decrypts your bookmarks, history and tabs in
  the browser, read them too. The extension is installed separately and isn't
  affected. See [`security.md`](security.md).
- **The Vault can miss items changed before the server was updated.** The
  snapshot now carries the earlier operations a bookmark or tab needs, so a
  moved or renamed bookmark shows in full. Objects that were compacted into a
  stored snapshot by an older server lost those earlier operations; the Vault
  leaves such an item out and says how many.
- **Tab groups need a permission in each browser.** Turning on Tab Groups in a
  browser's popup asks for it; when the setting was turned on elsewhere, open
  the popup's settings and press Save. Tab, tab group and restore behavior is
  tested end to end in Chromium and Helium (`CONTRIBUTING.md`); reports from
  other Chromium builds are welcome.
