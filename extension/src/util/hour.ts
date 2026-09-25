/** Aligns an epoch-ms timestamp down to its UTC hour, as an RFC3339 string
 * (`2026-09-23T09:47:12.345Z` -> `"2026-09-23T09:00:00.000Z"`). This is the
 * wire key for the plaintext per-hour visit-count histograms
 * (`LocalOperation.visitHours`, docs/protocol.md §8.3.2); the live and bulk
 * history paths must both use it so the same instant maps to the same key. */
export function hourKey(ms: number): string {
  return new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();
}
