// Restore points built on the device wait here until the server has them, so
// building one never blocks sync or capture and an offline moment loses
// nothing. A retry re-sends the same point id, which the server treats as the
// same point.
import {
  ApiError,
  ReauthRequiredError,
  uploadRestorePoint,
  type RestorePointKind,
} from "../api/client";
import {
  deleteRestorePointOutbox,
  getRestorePointOutbox,
  putRestorePointOutbox,
  type RestorePointOutboxRecord,
} from "../storage/db";
import { singleFlight } from "../util/single-flight";

/** Server verdicts that mean this point will never be stored, so retrying it
 * would only fail again. */
const DISCARD_CODES = new Set([
  "restore_point_recent", // another device already made today's
  "restore_points_disabled", // automatic points were turned off meanwhile
  "restore_point_limit",
  "validation_error",
  "encryption_required",
]);

const MAX_ATTEMPTS = 20;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface OutboxItem {
  id: string;
  kind: RestorePointKind;
  bookmarkCount: number;
  createdAt: string;
}

export async function enqueueRestorePoint(record: Omit<RestorePointOutboxRecord, "attempts" | "createdAt">): Promise<void> {
  await putRestorePointOutbox({ ...record, createdAt: new Date().toISOString(), attempts: 0 });
}

export async function listOutbox(): Promise<OutboxItem[]> {
  return (await getRestorePointOutbox()).map(({ id, kind, bookmarkCount, createdAt }) => ({
    id,
    kind: kind as RestorePointKind,
    bookmarkCount,
    createdAt,
  }));
}

export type DrainOutcome = "uploaded" | "discarded" | "retry-later";

/** Per point id, what happened on the last drain. */
export type DrainResult = Map<string, { outcome: DrainOutcome; code?: string }>;

function isPermanent(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.code && DISCARD_CODES.has(err.code)) return true;
  // A rejected body or an oversize point won't change by waiting.
  return err.status === 400 || err.status === 413;
}

/** Uploads what is waiting, oldest first. Stops at the first failure that
 * says the server or network is unwell, keeping the rest for next time. */
export const drainOutbox = singleFlight(async (): Promise<DrainResult> => {
  const result: DrainResult = new Map();
  for (const record of await getRestorePointOutbox()) {
    if (Date.now() - Date.parse(record.createdAt) > MAX_AGE_MS) {
      await deleteRestorePointOutbox(record.id);
      result.set(record.id, { outcome: "discarded", code: "expired" });
      continue;
    }
    try {
      await uploadRestorePoint({
        id: record.id,
        kind: record.kind as RestorePointKind,
        bookmarkCount: record.bookmarkCount,
        encryptionVersion: record.encryptionVersion,
        ...(record.codec ? { codec: record.codec } : {}),
        envelope: record.envelope,
      });
      await deleteRestorePointOutbox(record.id);
      result.set(record.id, { outcome: "uploaded" });
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        result.set(record.id, { outcome: "retry-later", code: "reauth" });
        break;
      }
      if (isPermanent(err)) {
        await deleteRestorePointOutbox(record.id);
        result.set(record.id, { outcome: "discarded", code: err instanceof ApiError ? err.code : undefined });
        continue;
      }
      const attempts = record.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await deleteRestorePointOutbox(record.id);
        result.set(record.id, { outcome: "discarded", code: "too_many_attempts" });
      } else {
        await putRestorePointOutbox({ ...record, attempts });
        result.set(record.id, {
          outcome: "retry-later",
          code: err instanceof ApiError ? err.code : "network",
        });
      }
      break;
    }
  }
  return result;
});
