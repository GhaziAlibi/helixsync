// Pure query logic over `remote_objects` records (src/storage/db.ts),
// split out so it can be unit tested without a real IndexedDB — this
// project's vitest setup has no IndexedDB/`idb` polyfill, so anything that
// calls `getDb()` directly can't run under `vitest run`.
import type { FieldStateRecord, RemoteObjectRecord } from "./db";
import type { HistoryVisitPayload, TabPayload } from "../sync/types";

/** Most recent history visits synced from other devices, newest first —
 * backs the popup's "Synced history from other devices" list. Remote visits
 * are never replayed into this browser's real history at all (see
 * history/index.ts's applyRemote/applyRemoteBatch — replaying via
 * `chrome.history.addUrl` used to cause runaway duplicate growth and added
 * nothing anyway, since addUrl can't set a historical timestamp or title),
 * so this list — backed by `remote_objects`, not `chrome://history` — is the
 * only place the real title/url/visitedAt of a synced remote visit is ever
 * visible. See README.md "Limitations". */
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

/** Per-record predicate behind `selectPendingTabRestores` below: whether one
 * `remote_objects` row counts as a not-yet-restored pending tab (a "tab"
 * record, not tombstoned, with a payload, that isn't already materialized
 * as a real local Chromium tab per `materializedObjectIds`). Factored out so
 * `storage/db.ts::countPendingTabRestores` can apply the exact same
 * semantics while walking records one at a time via a cursor, instead of
 * needing the whole array `selectPendingTabRestores` operates over just to
 * read off a `.length`. */
export function isPendingTabRestore(
  record: RemoteObjectRecord,
  materializedObjectIds: ReadonlySet<string>,
): record is RemoteObjectRecord & { payload: TabPayload } {
  return (
    record.objectType === "tab" &&
    !record.deleted &&
    !!record.payload &&
    !materializedObjectIds.has(record.objectId)
  );
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
    .filter((r): r is RemoteObjectRecord & { payload: TabPayload } => isPendingTabRestore(r, materializedObjectIds))
    .map((r) => ({ objectId: r.objectId, payload: r.payload }));
}

/** objectIds eligible for `storage/db.ts::gcFieldStates` to purge — every
 * object whose "liveness" field_state record reads "deleted" and was
 * recorded at least `cutoffMs` in the past. See `gcFieldStates`'s doc
 * comment for the full resurrection-bug rationale this retention window
 * exists to prevent; this only factors out the filtering so it can be
 * tested without a real IndexedDB (see this file's header).
 *
 * A record with no `recordedAt` (written before that field existed) is
 * deliberately excluded rather than treated as eligible: its true age is
 * unknown, and purging data of unconfirmed age risks exactly the
 * resurrection bug this window exists to prevent. */
export function selectFieldStateGcCandidates(
  records: FieldStateRecord[],
  cutoffMs: number,
): string[] {
  const objectIds = new Set<string>();
  for (const r of records) {
    if (r.field === "liveness" && r.value === "deleted" && r.recordedAt !== undefined && r.recordedAt < cutoffMs) {
      objectIds.add(r.objectId);
    }
  }
  return [...objectIds];
}

/** objectIds eligible for `storage/db.ts::pruneDeferredMaterializations` —
 * every deferred-materialization row recorded at least `cutoffMs` in the
 * past. Split out so it can be unit tested without a real IndexedDB, like
 * `selectFieldStateGcCandidates` above. A row with an unparseable `createdAt`
 * is excluded rather than purged on a guess. */
export function selectStaleDeferredMaterializations(
  records: Array<{ objectId: string; createdAt: string }>,
  cutoffMs: number,
): string[] {
  const objectIds = new Set<string>();
  for (const r of records) {
    const created = new Date(r.createdAt).getTime();
    if (Number.isFinite(created) && created < cutoffMs) objectIds.add(r.objectId);
  }
  return [...objectIds];
}
