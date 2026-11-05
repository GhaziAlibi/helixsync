// Making a restore point: read the tree, encode it, hand it to the outbox (or
// upload it right away when the caller can't go on without it).
import { getSdek } from "../crypto";
import { fetchSettings, uploadRestorePoint, type RestorePointKind, type RestorePointMeta } from "../api/client";
import { getDevice } from "../storage/db";
import { uuidv7 } from "../util/uuid";
import { encodePoint, POINT_VERSION, type PointPlaintext } from "./format";
import { enqueueRestorePoint } from "./outbox";
import { captureNodes, hashNodes, type CaptureMode } from "./snapshot";

export class RestorePointsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestorePointsUnavailableError";
  }
}

export interface BuiltPoint {
  id: string;
  kind: RestorePointKind;
  bookmarkCount: number;
  encryptionVersion: 1;
  codec?: "deflate-raw";
  envelope: unknown;
  /** Hash of the tree, for the scheduled trigger's "unchanged" check. */
  treeHash: string;
}

/** Reads the tree in `mode` and encodes it. Throws `BookmarksNotReadyError`
 * from a full capture while bookmarks are unmapped. */
export async function buildRestorePoint(kind: RestorePointKind, mode: CaptureMode): Promise<BuiltPoint> {
  const device = await getDevice();
  if (!device) throw new RestorePointsUnavailableError("This browser is not connected.");
  const nodes = await captureNodes(mode);
  const plaintext: PointPlaintext = {
    v: POINT_VERSION,
    createdAt: new Date().toISOString(),
    deviceId: device.deviceId,
    kind,
    nodes,
  };
  const id = uuidv7();
  const sdek = await getSdek(device.accountKey, device.accountKeyVersion);
  const encoded = await encodePoint(plaintext, id, sdek, device.accountKeyVersion);
  return {
    id,
    kind,
    bookmarkCount: nodes.filter((n) => n.k === "b").length,
    encryptionVersion: 1,
    ...(encoded.codec ? { codec: encoded.codec } : {}),
    envelope: encoded.envelope,
    treeHash: await hashNodes(nodes),
  };
}

/** Builds a point and queues it for upload. Returns the built point, or
 * undefined (nothing queued) when its tree hash is `skipIfHash`. */
export async function createQueuedRestorePoint(
  kind: RestorePointKind,
  mode: CaptureMode,
  options: { skipIfHash?: string } = {},
): Promise<BuiltPoint | undefined> {
  const built = await buildRestorePoint(kind, mode);
  if (options.skipIfHash !== undefined && built.treeHash === options.skipIfHash) return undefined;
  await enqueueRestorePoint({
    id: built.id,
    kind: built.kind,
    bookmarkCount: built.bookmarkCount,
    encryptionVersion: built.encryptionVersion,
    codec: built.codec,
    envelope: built.envelope,
  });
  return built;
}

/** Builds a point and uploads it now; throws if the server doesn't take it.
 * For `pre_restore`, which a restore must not start without. */
export async function createUploadedRestorePoint(kind: RestorePointKind, mode: CaptureMode): Promise<RestorePointMeta> {
  const built = await buildRestorePoint(kind, mode);
  return uploadRestorePoint({
    id: built.id,
    kind: built.kind,
    bookmarkCount: built.bookmarkCount,
    encryptionVersion: built.encryptionVersion,
    codec: built.codec,
    envelope: built.envelope,
  });
}

/** Whether automatic points are on for the account; an older server or a
 * failed lookup reads as on, and the server refuses them if they are off. */
export async function automaticPointsEnabled(): Promise<boolean> {
  try {
    return (await fetchSettings()).restorePointsAutomatic !== false;
  } catch {
    return true;
  }
}
