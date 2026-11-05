// When restore points get made without the user asking (docs/protocol.md
// §16.6). Every one of them is quiet and best-effort: a failure is logged and
// the next trigger tries again, and none can hold up sync or capture, because
// the point goes to the outbox rather than to the network.
import { fetchSettings, serverSupportsRestorePoints, type RestorePointKind } from "../api/client";
import { readLiveBookmarks, setMassDeleteHandler, type MassDeleteEvent } from "../bookmarks";
import { getDevice } from "../storage/db";
import { registerPreSnapshotHook } from "../sync/engine";
import { automaticPointsEnabled, createQueuedRestorePoint } from "./create";
import { BookmarksNotReadyError, type CaptureMode } from "./snapshot";
import { drainOutbox } from "./outbox";
import { isRestoreRunning } from "./state";

export const RESTORE_POINT_ALARM = "helixsync-restore-point";
const SCHEDULE_PERIOD_MINUTES = 24 * 60;
const SCHEDULE_FIRST_DELAY_MINUTES = 30;

/** At most one mass-delete point per device in this window. */
export const MASS_DELETE_MIN_INTERVAL_MS = 10 * 60_000;

const LAST_TREE_HASH_KEY = "restorePointLastTreeHash";
const LAST_MASS_DELETE_KEY = "restorePointLastMassDeleteAt";

/** Ready for restore points: connected, bookmark sync on, server able. The
 * initial import must be done too, except for the point made during it. */
async function featureAvailable(options: { duringImport?: boolean } = {}): Promise<boolean> {
  const device = await getDevice();
  if (!device) return false;
  if (!options.duringImport && !device.initialImportCompletedAt) return false;
  try {
    if ((await fetchSettings()).syncBookmarks === false) return false;
  } catch {
    // Offline: the outbox covers the upload, and capture fails open too.
  }
  return serverSupportsRestorePoints();
}

/** Whether the popup and the triggers should treat restore points as on. */
export async function restorePointsAvailable(): Promise<boolean> {
  return featureAvailable();
}

/** Makes an automatic point if the feature is on and the account allows
 * automatic points. Returns the tree hash, or undefined if none was made. */
async function makeAutomaticPoint(
  kind: RestorePointKind,
  mode: CaptureMode,
  options: { duringImport?: boolean; skipIfHash?: string } = {},
): Promise<string | undefined> {
  try {
    if (!(await featureAvailable(options))) return undefined;
    if (!(await automaticPointsEnabled())) return undefined;
    const built = await createQueuedRestorePoint(kind, mode, { skipIfHash: options.skipIfHash });
    if (!built) return undefined;
    void drainOutbox().catch((e) => console.warn("HelixSync: restore point upload failed", e));
    return built.treeHash;
  } catch (err) {
    if (err instanceof BookmarksNotReadyError) {
      console.log(`HelixSync: ${kind} restore point skipped, bookmarks not ready`);
    } else {
      console.warn(`HelixSync: ${kind} restore point failed`, err);
    }
    return undefined;
  }
}

// --- scheduled -----------------------------------------------------------

export function ensureRestorePointAlarm(): void {
  void chrome.alarms.get(RESTORE_POINT_ALARM).then((existing) => {
    if (!existing) {
      chrome.alarms.create(RESTORE_POINT_ALARM, {
        delayInMinutes: SCHEDULE_FIRST_DELAY_MINUTES,
        periodInMinutes: SCHEDULE_PERIOD_MINUTES,
      });
    }
  });
}

/** The daily point. Skipped when the tree is the same as the last point this
 * device made; a `restore_point_recent` verdict (another device made today's)
 * is handled when the outbox drains. */
export async function runScheduledRestorePoint(): Promise<void> {
  const before = (await chrome.storage.local.get(LAST_TREE_HASH_KEY))[LAST_TREE_HASH_KEY] as string | undefined;
  const hash = await makeAutomaticPoint("scheduled", { kind: "full" }, { skipIfHash: before });
  if (hash !== undefined) await chrome.storage.local.set({ [LAST_TREE_HASH_KEY]: hash });
}

// --- import, resync, mass delete -----------------------------------------

/** During the first import, after the account's bookmarks arrived and before
 * this browser's own are uploaded: if the account already had bookmarks and
 * this browser has some it hasn't linked, a point of the account's state lets
 * the user undo what the import adds. Mapped nodes only, by design. */
export async function createPreImportPoint(): Promise<void> {
  try {
    const live = await readLiveBookmarks();
    if (live.nodes.length === 0 || live.unmapped === 0) return;
  } catch (err) {
    console.warn("HelixSync: pre-import restore point check failed", err);
    return;
  }
  await makeAutomaticPoint("pre_import", { kind: "mapped-only" }, { duringImport: true });
}

async function createPreResyncPoint(): Promise<void> {
  await makeAutomaticPoint("pre_resync", { kind: "full" });
}

async function handleMassDelete(event: MassDeleteEvent): Promise<void> {
  // A restore's own deletions already have its pre_restore point.
  if (isRestoreRunning()) return;
  const last = (await chrome.storage.local.get(LAST_MASS_DELETE_KEY))[LAST_MASS_DELETE_KEY] as number | undefined;
  if (last !== undefined && Date.now() - last < MASS_DELETE_MIN_INTERVAL_MS) return;
  const mode: CaptureMode = event.origin === "local" ? { kind: "plus-removed", removed: event.removed } : { kind: "full" };
  const hash = await makeAutomaticPoint("mass_delete", mode);
  if (hash !== undefined) await chrome.storage.local.set({ [LAST_MASS_DELETE_KEY]: Date.now() });
}

/** Wires the engine and bookmark hooks. Call once at startup. */
export function installRestorePointTriggers(): void {
  registerPreSnapshotHook(createPreResyncPoint);
  setMassDeleteHandler(handleMassDelete);
}

/** Forgets the device-local trigger state, for a disconnect. */
export async function clearRestorePointTriggerState(): Promise<void> {
  await chrome.storage.local.remove([LAST_TREE_HASH_KEY, LAST_MASS_DELETE_KEY]);
}

/** Uploads waiting points; for startup and the periodic sync. */
export async function drainRestorePointOutbox(): Promise<void> {
  if (!(await getDevice())) return;
  try {
    await drainOutbox();
  } catch (err) {
    console.warn("HelixSync: restore point upload failed", err);
  }
}
