// Pure query logic over IndexedDB records, kept separate from db.ts so it
// can be unit tested without an IndexedDB implementation.
import type { FieldStateRecord, RemoteObjectRecord } from "./db";
import type { HistoryVisitPayload, TabPayload } from "../sync/types";

/** Most recent visits synced from other devices, newest first, for the
 * popup. Remote visits are never replayed into chrome://history, so this is
 * the only place they're shown. */
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

/** Whether a record is a live remote tab not yet materialized locally.
 * Shared by the array selector below and db.ts's cursor-based walks. */
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

/** Remote tabs awaiting the user's "Restore" under the "ask" policy. */
export function selectPendingTabRestores(
  records: RemoteObjectRecord[],
  materializedObjectIds: ReadonlySet<string>,
): PendingTabRestore[] {
  return records
    .filter((r): r is RemoteObjectRecord & { payload: TabPayload } => isPendingTabRestore(r, materializedObjectIds))
    .map((r) => ({ objectId: r.objectId, payload: r.payload }));
}

/** objectIds whose "liveness" has read "deleted" since before `cutoffMs`.
 * Records without `recordedAt` have unknown age and are never selected:
 * purging too early could resurrect deleted objects (see gcFieldStates). */
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

/** Deferred-materialization rows created before `cutoffMs`. Rows with an
 * unparseable `createdAt` are kept rather than purged on a guess. */
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
