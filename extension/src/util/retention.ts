/** Converts the account's history retention into a chrome.history.search
 * `startTime`. The server can only enforce retention by upload time
 * (payloads are encrypted), so history imports are scoped by visit time.
 * Unknown or unlimited retention means everything (0). */
export function retentionCutoffMs(retention: string | undefined): number {
  const days =
    retention === "7d" ? 7 : retention === "30d" ? 30 : retention === "90d" ? 90 : retention === "1y" ? 365 : undefined;
  if (days === undefined) return 0;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}
