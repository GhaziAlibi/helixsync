import type { BulkHistoryContainer } from "./types";

/** Accepts both container versions; v1 data is never rewritten.
 *
 * Lives outside src/history/ because the sync engine needs it too: a bulk
 * history op's payload is this container, not a single encryption envelope,
 * so the engine must recognise it before deciding how to decrypt. */
export function isBulkContainer(payload: unknown): payload is BulkHistoryContainer {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    (p["bulkVersion"] === 1 || p["bulkVersion"] === 2) &&
    typeof p["visitCount"] === "number" &&
    Array.isArray(p["segments"])
  );
}
