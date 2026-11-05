// The restore job (docs/protocol.md §16.5): applies a restore point to the
// browser as ordinary operations, in chunks, so the other devices converge the
// way they do for any change and an interrupted run can resume.
import {
  ApiError,
  downloadRestorePoint,
  reportRestoreApplied,
  serverSupportsRestorePoints,
  type RestorePointMeta,
} from "../api/client";
import { applyRestoreOperations, readLiveBookmarks, sweepStaleBookmarkMappings } from "../bookmarks";
import { getSdek, UnsupportedEnvelopeVersionError } from "../crypto";
import { deleteRestoreJob, getDevice, getRestoreJob, putRestoreJob, type RestoreJobRecord } from "../storage/db";
import {
  createLocalOperationsBatch,
  downloadAndApply,
  runExclusive,
  scheduleLocalSync,
  uploadPending,
  type PendingLocalOperation,
} from "../sync/engine";
import { chunk } from "../util/chunk";
import { startKeepAlive } from "../util/keep-alive";
import { yieldToEventLoop } from "../util/yield";
import { createUploadedRestorePoint } from "./create";
import {
  decodePoint,
  UnreadableRestorePointError,
  UnsupportedRestorePointVersionError,
  type PointPlaintext,
} from "./format";
import { planRestore, UnknownRestoreScopeError, type RestorePlan, type RestoreMode, type RestoreScope } from "./planner";
import { BookmarksNotReadyError } from "./snapshot";
import {
  getRestoreProgress,
  isRestoreRunning,
  RestoreError,
  setRestoreProgress,
} from "./state";

export interface RestoreRequest {
  pointId: string;
  mode: RestoreMode;
  scope: RestoreScope;
}

/** Operations per chunk: one batched encrypt, one apply, one progress write. */
export const RESTORE_CHUNK_SIZE = 500;

interface LoadedPoint {
  meta: RestorePointMeta;
  point: PointPlaintext;
}

// A preview and the restore that follows it use the same point; one entry
// keeps the second from downloading it again.
let loadedCache: LoadedPoint | undefined;

export function clearLoadedRestorePoint(): void {
  loadedCache = undefined;
}

/** Downloads and decodes a point, failing closed: nothing is applied from a
 * point that can't be authenticated and validated. */
export async function loadRestorePoint(pointId: string): Promise<LoadedPoint> {
  if (loadedCache?.meta.id === pointId) return loadedCache;
  const device = await getDevice();
  if (!device) throw new RestoreError("not_connected", "This browser is not connected.");
  let downloaded;
  try {
    downloaded = await downloadRestorePoint(pointId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new RestoreError("download_failed", "This restore point no longer exists.");
    }
    throw new RestoreError("download_failed", "Could not download the restore point. Check your connection.");
  }
  try {
    const point = await decodePoint(downloaded.envelope, downloaded.codec, pointId, (keyVersion) =>
      getSdek(device.accountKey, keyVersion),
    );
    const { envelope: _envelope, ...meta } = downloaded;
    loadedCache = { meta, point };
    return loadedCache;
  } catch (err) {
    if (err instanceof UnsupportedEnvelopeVersionError || err instanceof UnsupportedRestorePointVersionError) {
      throw new RestoreError("update_needed", err.message);
    }
    if (err instanceof UnreadableRestorePointError) throw new RestoreError("unreadable", err.message);
    throw err;
  }
}

/** What restoring would do, without touching anything. */
export async function previewRestore(request: RestoreRequest): Promise<RestorePlan> {
  const { point } = await loadRestorePoint(request.pointId);
  const live = await readLiveBookmarks();
  if (live.unmapped > 0) throw new BookmarksNotReadyError(live.unmapped);
  try {
    return planRestore(point, live.nodes, request.mode, request.scope);
  } catch (err) {
    if (err instanceof UnknownRestoreScopeError) throw new RestoreError("unknown_scope", err.message);
    throw err;
  }
}

function toRestoreError(err: unknown): RestoreError {
  if (err instanceof RestoreError) return err;
  if (err instanceof BookmarksNotReadyError) return new RestoreError("bookmarks_not_ready", err.message);
  if (err instanceof UnknownRestoreScopeError) return new RestoreError("unknown_scope", err.message);
  return new RestoreError("failed", err instanceof Error ? err.message : String(err));
}

let running: Promise<void> | null = null;

/** Starts a restore in the background and returns at once; progress is read
 * with `getRestoreProgress`. Throws `restore_in_progress` if one is running. */
export async function startRestore(request: RestoreRequest): Promise<void> {
  if (running || isRestoreRunning()) {
    throw new RestoreError("restore_in_progress", "A restore is already running.");
  }
  const device = await getDevice();
  if (!device) throw new RestoreError("not_connected", "This browser is not connected.");
  if (!(await serverSupportsRestorePoints())) {
    throw new RestoreError("unavailable", "This server does not support restore points.");
  }
  setRestoreProgress({ phase: "preparing", pointId: request.pointId, mode: request.mode, applied: 0, total: 0 });
  running = runRestore(request, undefined).finally(() => {
    running = null;
  });
}

/** Resumes a restore a worker restart interrupted, if there is one. */
export async function resumeInterruptedRestore(): Promise<void> {
  if (running || isRestoreRunning()) return;
  const job = await getRestoreJob();
  if (!job) return;
  setRestoreProgress({
    phase: "preparing",
    pointId: job.pointId,
    mode: job.mode,
    applied: job.applied,
    total: job.total,
  });
  running = runRestore({ pointId: job.pointId, mode: job.mode, scope: job.scope }, job).finally(() => {
    running = null;
  });
}

export function whenRestoreSettled(): Promise<void> {
  return running ?? Promise.resolve();
}

async function runRestore(request: RestoreRequest, resumeJob: RestoreJobRecord | undefined): Promise<void> {
  const stopKeepAlive = startKeepAlive();
  try {
    const { point } = await loadRestorePoint(request.pointId);

    const plan = await runExclusive(() => applyUnderLock(request, point, resumeJob));

    setRestoreProgress({ ...getRestoreProgress(), phase: "finishing" });
    scheduleLocalSync();
    try {
      await reportRestoreApplied(request.pointId, request.mode, request.scope !== "all");
    } catch (err) {
      // The restore is done; this only feeds the point's "last restored" time.
      console.warn("HelixSync: could not report the restore to the server", err);
    }
    await deleteRestoreJob();
    setRestoreProgress({
      phase: "done",
      pointId: request.pointId,
      mode: request.mode,
      applied: plan.operations.length,
      total: plan.operations.length,
      counts: plan.counts,
    });
  } catch (err) {
    const error = toRestoreError(err);
    console.error("HelixSync: restore failed", err);
    // A failed run is reported, not resumed: only an interrupted worker resumes.
    await deleteRestoreJob().catch(() => {});
    setRestoreProgress({
      phase: "error",
      pointId: request.pointId,
      mode: request.mode,
      applied: getRestoreProgress().applied,
      total: getRestoreProgress().total,
      error: { code: error.code, message: error.message },
    });
  } finally {
    stopKeepAlive();
  }
}

async function applyUnderLock(
  request: RestoreRequest,
  point: PointPlaintext,
  resumeJob: RestoreJobRecord | undefined,
): Promise<RestorePlan> {
  // The account's latest changes first, so the restore is planned against the
  // same tree the other devices see.
  try {
    await uploadPending();
    await downloadAndApply();
  } catch (err) {
    throw new RestoreError("sync_failed", "Could not sync before restoring. Check your connection and try again.");
  }
  await sweepStaleBookmarkMappings();
  const live = await readLiveBookmarks();
  if (live.unmapped > 0) throw new BookmarksNotReadyError(live.unmapped);

  let preRestorePointId = resumeJob?.preRestorePointId;
  if (!resumeJob) {
    preRestorePointId = (await uploadPreRestorePoint()).id;
  }

  const plan = planRestore(point, live.nodes, request.mode, request.scope);
  const total = resumeJob ? resumeJob.total : plan.operations.length;
  const alreadyApplied = resumeJob ? Math.max(0, total - plan.operations.length) : 0;
  const job: RestoreJobRecord = {
    id: "current",
    pointId: request.pointId,
    mode: request.mode,
    scope: request.scope,
    preRestorePointId: preRestorePointId!,
    startedAt: resumeJob?.startedAt ?? new Date().toISOString(),
    applied: alreadyApplied,
    total,
    phase: "applying",
  };
  await putRestoreJob(job);
  setRestoreProgress({
    phase: "applying",
    pointId: request.pointId,
    mode: request.mode,
    applied: alreadyApplied,
    total,
    counts: plan.counts,
  });

  let applied = alreadyApplied;
  for (const slice of chunk(plan.operations, RESTORE_CHUNK_SIZE)) {
    const pending: PendingLocalOperation[] = slice.map((op) => ({
      objectType: op.objectType,
      objectId: op.objectId,
      operationType: op.operationType,
      payload: op.payload,
    }));
    const created = await createLocalOperationsBatch(pending);
    await applyRestoreOperations(
      created,
      slice.map((op) => op.payload),
    );
    applied += slice.length;
    await putRestoreJob({ ...job, applied });
    setRestoreProgress({ ...getRestoreProgress(), applied });
    await yieldToEventLoop();
  }
  return plan;
}

/** The safety copy a restore starts from. A server with automatic points off
 * refuses the `pre_restore` kind, so the copy is then made as a manual one:
 * the user is restoring, and the copy must exist either way. */
async function uploadPreRestorePoint(): Promise<RestorePointMeta> {
  try {
    return await createUploadedRestorePoint("pre_restore", { kind: "full" });
  } catch (err) {
    if (err instanceof ApiError && err.code === "restore_points_disabled") {
      try {
        return await createUploadedRestorePoint("manual", { kind: "full" });
      } catch (retryErr) {
        if (retryErr instanceof BookmarksNotReadyError) throw retryErr;
        throw new RestoreError("pre_restore_failed", "Could not save a copy of your bookmarks first, so nothing was restored.");
      }
    }
    if (err instanceof BookmarksNotReadyError) throw err;
    throw new RestoreError("pre_restore_failed", "Could not save a copy of your bookmarks first, so nothing was restored.");
  }
}
