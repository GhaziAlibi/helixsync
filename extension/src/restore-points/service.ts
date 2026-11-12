// What the popup asks the worker for (the restore-point messages in
// background/index.ts). Failures it expects come back as `{ ok: false, error }`
// with a code the popup turns into words.
import {
  ApiError,
  deleteRestorePoint,
  listRestorePoints,
  ReauthRequiredError,
  serverSupportsRestorePoints,
  setRestorePointPinned,
  updateSettings,
  fetchSettings,
  type RestorePointMeta,
} from "../api/client";
import { getDevice } from "../storage/db";
import { createQueuedRestorePoint } from "./create";
import { drainOutbox, listOutbox, type OutboxItem } from "./outbox";
import { loadRestorePoint, previewRestore, startRestore, clearLoadedRestorePoint, type RestoreRequest } from "./restore";
import { BookmarksNotReadyError } from "./snapshot";
import { getRestoreProgress, isRestoreRunning, resetRestoreProgress, RestoreError } from "./state";
import { restorePointsAvailable } from "./triggers";

export interface ServiceError {
  code: string;
  message: string;
}

export type ServiceResult<T> = ({ ok: true } & T) | { ok: false; error: ServiceError };

/** Maps what can go wrong into a code the popup knows. */
export function toServiceError(err: unknown): ServiceError {
  if (err instanceof RestoreError) return { code: err.code, message: err.message };
  if (err instanceof BookmarksNotReadyError) return { code: "bookmarks_not_ready", message: err.message };
  if (err instanceof ReauthRequiredError) return { code: "reauth", message: "Sign in again to use restore points." };
  if (err instanceof ApiError) {
    if (err.status === 426) return { code: "update_needed", message: "Update the HelixSync extension to use restore points." };
    return { code: err.code ?? `http_${err.status}`, message: err.message };
  }
  if (err instanceof TypeError) return { code: "offline", message: "Could not reach the server." };
  return { code: "failed", message: err instanceof Error ? err.message : String(err) };
}

async function guarded<T>(fn: () => Promise<T>): Promise<ServiceResult<T extends object ? T : { value: T }>> {
  try {
    const value = await fn();
    return { ok: true, ...(typeof value === "object" && value !== null ? value : { value }) } as never;
  } catch (err) {
    return { ok: false, error: toServiceError(err) };
  }
}

export interface RestorePointList {
  available: boolean;
  automatic: boolean;
  points: RestorePointMeta[];
  pending: OutboxItem[];
}

export function listForPopup(): Promise<ServiceResult<RestorePointList>> {
  return guarded(async () => {
    const pending = await listOutbox();
    if (!(await getDevice()) || !(await restorePointsAvailable())) {
      return { available: false, automatic: true, points: [], pending };
    }
    // A waiting point may be ready to go; try before listing.
    await drainOutbox().catch(() => undefined);
    const [points, settings] = await Promise.all([
      listRestorePoints(),
      fetchSettings({ fresh: true }).catch(() => undefined),
    ]);
    return {
      available: true,
      automatic: settings?.restorePointsAutomatic !== false,
      points,
      pending: await listOutbox(),
    };
  });
}

export function createManual(): Promise<ServiceResult<{ id: string; uploaded: boolean }>> {
  return guarded(async () => {
    if (!(await serverSupportsRestorePoints())) {
      throw new RestoreError("unavailable", "This server does not support restore points.");
    }
    const built = await createQueuedRestorePoint("manual", { kind: "full" });
    if (!built) throw new RestoreError("failed", "Nothing to save.");
    const outcome = (await drainOutbox().catch(() => undefined))?.get(built.id);
    if (outcome?.outcome === "discarded") {
      throw new ApiError("The server did not keep the restore point.", 409, outcome.code);
    }
    return { id: built.id, uploaded: outcome?.outcome === "uploaded" };
  });
}

export function folderTree(
  pointId: string,
): Promise<ServiceResult<{ folders: Array<{ id: string; title: string; parent: string }>; bookmarkCount: number }>> {
  return guarded(async () => {
    const { point } = await loadRestorePoint(pointId);
    return {
      folders: point.nodes.filter((n) => n.k === "f").map((n) => ({ id: n.o, title: n.t, parent: n.p })),
      bookmarkCount: point.nodes.filter((n) => n.k === "b").length,
    };
  });
}

export function preview(request: RestoreRequest) {
  return guarded(async () => {
    const plan = await previewRestore(request);
    return { counts: plan.counts, sample: plan.sample };
  });
}

export function start(request: RestoreRequest): Promise<ServiceResult<{ started: true }>> {
  return guarded(async () => {
    await startRestore(request);
    return { started: true as const };
  });
}

export function progress() {
  return { ok: true as const, progress: getRestoreProgress() };
}

/** The user has seen how a finished restore ended (the popup's Done): forget
 * it, so the Restore points view shows the list again. A running restore is
 * kept. */
export function dismissProgress() {
  if (!isRestoreRunning()) resetRestoreProgress();
  return { ok: true as const, progress: getRestoreProgress() };
}

export function pin(id: string, pinned: boolean): Promise<ServiceResult<{ point: RestorePointMeta }>> {
  return guarded(async () => ({ point: await setRestorePointPinned(id, pinned) }));
}

export function remove(id: string): Promise<ServiceResult<{ deleted: true }>> {
  return guarded(async () => {
    await deleteRestorePoint(id);
    clearLoadedRestorePoint();
    return { deleted: true as const };
  });
}

export function setAutomatic(enabled: boolean) {
  return guarded(async () => {
    const settings = await updateSettings({ restorePointsAutomatic: enabled });
    return { automatic: settings.restorePointsAutomatic !== false };
  });
}
