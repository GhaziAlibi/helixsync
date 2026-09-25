/** Serializes async work per key: `run` calls for the same key execute one
 * at a time in call order, while different keys run independently. A key's
 * queue entry is dropped once it settles. */
export function createKeyedLock() {
  const queues = new Map<string, Promise<unknown>>();

  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prior = queues.get(key) ?? Promise.resolve();
      const settled = prior.then(fn, fn);
      // The queue chain must never reject, or one failure would skip every
      // later run; the caller still sees the real rejection via `settled`.
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
