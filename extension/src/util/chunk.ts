/** Splits `items` into consecutive slices of at most `size` elements each
 * (the last slice may be shorter). Pure and side-effect free so it can be
 * unit tested without the chrome API mock harness this project doesn't
 * have (see tabs/groupSync.test.ts's header comment) — callers combine it
 * with `Promise.all` to run bounded-concurrency batches of otherwise-
 * sequential async work (e.g. background/index.ts's RESTORE_ALL_TABS
 * handler), which itself isn't unit tested for the same reason. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk size must be positive, got ${size}`);
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}
