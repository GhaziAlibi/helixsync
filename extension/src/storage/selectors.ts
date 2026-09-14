// Pure query logic over `remote_objects` records (src/storage/db.ts),
// split out so it can be unit tested without a real IndexedDB — this
// project's vitest setup has no IndexedDB/`idb` polyfill, so anything that
// calls `getDb()` directly can't run under `vitest run`.
import type { RemoteObjectRecord } from "./db";
import type { HistoryVisitPayload, TabPayload } from "../sync/types";

/** Most recent history visits synced from other devices, newest first —
 * backs the popup's "Synced history from other devices" list
 * (README.md "Known gaps": `chrome.history.addUrl` can't set a historical
 * timestamp or title, so this is how the real title/url/visitedAt stay
 * visible even though `chrome://history` itself can't show them). */
export function selectRecentHistoryVisits(
  records: RemoteObjectRecord[],
  limit = 20,
): HistoryVisitPayload[] {
  return records
    .filter((r): r is RemoteObjectRecord & { payload: HistoryVisitPayload } => r.objectType === "historyVisit" && !r.deleted && !!r.payload)
    .map((r) => r.payload)
    .sort((a, b) => (a.visitedAt < b.visitedAt ? 1 : a.visitedAt > b.visitedAt ? -1 : 0))
    .slice(0, limit);
}

export interface PendingTabRestore {
  objectId: string;
  payload: TabPayload;
}

/** Remote tabs tracked for display but not yet materialized as a real
 * local browser tab — backs the popup's "ask" restore-policy list
 * (README.md "Known gaps": the `ask` policy used to behave identically to
 * `disabled`, with nothing surfacing tracked-but-unrestored tabs). A tab
 * counts as already materialized if `materializedObjectIds` contains its
 * objectId (i.e. it already has a local Chromium tab mapping —
 * `sync/mapping.ts`), which the caller determines from `object_mappings`. */
export function selectPendingTabRestores(
  records: RemoteObjectRecord[],
  materializedObjectIds: ReadonlySet<string>,
): PendingTabRestore[] {
  return records
    .filter((r): r is RemoteObjectRecord & { payload: TabPayload } => r.objectType === "tab" && !r.deleted && !!r.payload)
    .filter((r) => !materializedObjectIds.has(r.objectId))
    .map((r) => ({ objectId: r.objectId, payload: r.payload }));
}
