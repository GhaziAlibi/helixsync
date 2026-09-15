/** Serializes async work per key: concurrent `run` calls for the same `key`
 * queue up and execute one at a time, in call order, while calls for
 * different keys run fully independently (no shared lock across keys, so
 * one key's work can never block or starve another's). Pure/side-effect
 * free aside from the internal map, so it can be unit tested without the
 * chrome API mock harness this project doesn't have (see
 * tabs/groupSync.ts's header comment for the same rationale). Each key's
 * queue entry is dropped once it settles, so a key that's done being
 * contended leaves nothing behind. */
export function createKeyedLock() {
  const queues = new Map<string, Promise<unknown>>();

  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prior = queues.get(key) ?? Promise.resolve();
      const settled = prior.then(fn, fn);
      // Swallow rejection here only so the map's queue chain itself never
      // short-circuits on a failed run — the caller still gets the real
      // rejection via `settled`/`run`'s own return below.
      const tracked = settled.then(
        () => undefined,
        () => undefined,
      );
      queues.set(key, tracked);
      try {
        return await settled;
      } finally {
        if (queues.get(key) === tracked) queues.delete(key);
      }
    },
  };
}
