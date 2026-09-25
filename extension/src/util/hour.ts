/** Aligns an epoch-ms timestamp down to its containing UTC hour and returns
 * it as an RFC3339 timestamp string, e.g. `2026-09-23T09:47:12.345Z` ->
 * `"2026-09-23T09:00:00.000Z"`.
 *
 * This is the wire key for the per-hour visit-count histograms (`visitHours`
 * on `LocalOperation`, docs/protocol.md §8.3.2): the server aggregates
 * real-time visit COUNTS in plaintext (URLs/titles stay encrypted in
 * `payload`) so the dashboard's "History items synced" figure can follow
 * the browser's actual rolling retention window instead of upload time,
 * which the server otherwise has no way to see through the encryption.
 *
 * `Math.floor` (not rounding) is what makes this an alignment down to the
 * hour boundary rather than a truncation that could round up past it. A
 * single small helper so both the live-visit path (history/index.ts) and
 * the bulk-import chunk histogram (history/bulk.ts) compute the exact same
 * key for the exact same instant. */
export function hourKey(ms: number): string {
  return new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();
}
