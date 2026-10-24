/** MV3 keep-alive for long work. A sleep doesn't count as activity for the
 * ~30s service-worker idle timer, so a trivial extension API call on a steady
 * cadence keeps a long, paced run from being killed. Returns the stopper. */
export function startKeepAlive(intervalMs = 20_000): () => void {
  const id = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {
        void chrome.runtime.lastError; // acknowledge to avoid an "unchecked" warning
      });
    } catch {
      // No extension runtime (e.g. a test); nothing to keep alive.
    }
  }, intervalMs);
  return () => clearInterval(id);
}
