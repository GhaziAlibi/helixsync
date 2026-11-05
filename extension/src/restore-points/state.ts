// What the popup shows while a restore runs, and the flag the automatic
// triggers check so a restore's own deletions don't make a point.
import type { PlanCounts, RestoreMode } from "./planner";

export type RestoreErrorCode =
  | "not_connected"
  | "unavailable"
  | "restore_in_progress"
  | "unreadable"
  | "update_needed"
  | "sync_failed"
  | "bookmarks_not_ready"
  | "pre_restore_failed"
  | "unknown_scope"
  | "download_failed"
  | "failed";

export interface RestoreProgress {
  phase: "idle" | "preparing" | "applying" | "finishing" | "done" | "error";
  pointId?: string;
  mode?: RestoreMode;
  applied: number;
  total: number;
  counts?: PlanCounts;
  error?: { code: RestoreErrorCode; message: string };
}

const IDLE: RestoreProgress = { phase: "idle", applied: 0, total: 0 };

let progress: RestoreProgress = IDLE;

export function getRestoreProgress(): RestoreProgress {
  return progress;
}

export function setRestoreProgress(next: RestoreProgress): void {
  progress = next;
}

export function resetRestoreProgress(): void {
  progress = IDLE;
}

export function isRestoreRunning(): boolean {
  return progress.phase === "preparing" || progress.phase === "applying" || progress.phase === "finishing";
}

export class RestoreError extends Error {
  constructor(
    readonly code: RestoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RestoreError";
  }
}
