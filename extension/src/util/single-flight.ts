/** Wraps `fn` so concurrent calls share one in-flight promise. The slot is
 * cleared once it settles, so a failure never wedges later calls. Arguments
 * of calls made while a run is in flight are ignored. */
export function singleFlight<Args extends unknown[], T>(fn: (...args: Args) => Promise<T>): (...args: Args) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (...args: Args): Promise<T> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        return await fn(...args);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}
