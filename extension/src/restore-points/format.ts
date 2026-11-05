// Restore point format and encryption (docs/protocol.md §16, docs/encryption.md
// §6.3). A point is a full bookmark tree: JSON, optionally deflated, then
// encrypted under the account's SDEK. The server stores the envelope as an
// opaque blob.
import {
  assertSupportedEnvelopeVersion,
  buildOperationAad,
  decryptBytesWithSdek,
  encryptBytesWithSdek,
  type EncryptionEnvelope,
} from "../crypto";
import { ROOT_OBJECT_IDS } from "../bookmarks/roots";
import { deflateRaw, inflateRaw, supportsDeflateRaw } from "../util/compression";
import type { RestorePointKind } from "../api/client";

/** Layout version of the plaintext below, not of the encryption envelope. */
export const POINT_VERSION = 1;

/** Not an object type, so a point can never be replayed as an operation (or
 * the other way round): the AAD would not match. */
export const RESTORE_POINT_AAD_OBJECT_TYPE = "bookmarkRestorePoint";
export const RESTORE_POINT_AAD_OPERATION_TYPE = "snapshot";

export interface PointNode {
  /** objectId */
  o: string;
  /** b = bookmark, f = folder */
  k: "b" | "f";
  /** title */
  t: string;
  /** url, bookmarks only */
  u?: string;
  /** parent objectId: a built-in root's, or an earlier node's */
  p: string;
  /** fractional position within the parent */
  x: string;
}

export interface PointPlaintext {
  v: typeof POINT_VERSION;
  createdAt: string;
  deviceId: string;
  kind: RestorePointKind;
  nodes: PointNode[];
}

/** The point can't be read: the ciphertext fails authentication (wrong key, a
 * swapped blob) or the plaintext isn't a valid tree. It is never applied. */
export class UnreadableRestorePointError extends Error {
  constructor(reason: string) {
    super(`This restore point can't be read: ${reason}`);
    this.name = "UnreadableRestorePointError";
  }
}

/** A point written by a newer layout than this extension knows. */
export class UnsupportedRestorePointVersionError extends Error {
  readonly pointVersion: number;
  constructor(pointVersion: number) {
    super(
      `This restore point uses format v${pointVersion}, which this version of HelixSync can't read. ` +
        "Update the HelixSync extension to restore it.",
    );
    this.name = "UnsupportedRestorePointVersionError";
    this.pointVersion = pointVersion;
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function pointAad(pointId: string): Uint8Array {
  return buildOperationAad(RESTORE_POINT_AAD_OBJECT_TYPE, pointId, RESTORE_POINT_AAD_OPERATION_TYPE);
}

export interface EncodedPoint {
  envelope: EncryptionEnvelope;
  codec?: "deflate-raw";
}

export async function encodePoint(
  point: PointPlaintext,
  pointId: string,
  sdek: Uint8Array,
  keyVersion: number,
): Promise<EncodedPoint> {
  const json = textEncoder.encode(JSON.stringify(point));
  const codec = supportsDeflateRaw() ? ("deflate-raw" as const) : undefined;
  const bytes = codec ? await deflateRaw(json) : json;
  const envelope = encryptBytesWithSdek(bytes, sdek, keyVersion, pointAad(pointId));
  return codec ? { envelope, codec } : { envelope };
}

/** Decrypts and validates a point. Throws `UnsupportedEnvelopeVersionError` or
 * `UnsupportedRestorePointVersionError` for data from another format version,
 * and `UnreadableRestorePointError` for anything else wrong with it. */
export async function decodePoint(
  envelope: unknown,
  codec: "deflate-raw" | null | undefined,
  pointId: string,
  resolveSdek: (keyVersion: number) => Promise<Uint8Array>,
): Promise<PointPlaintext> {
  assertSupportedEnvelopeVersion(envelope);
  const env = envelope as Partial<EncryptionEnvelope> | null;
  if (!env || typeof env !== "object" || typeof env.keyVersion !== "number") {
    throw new UnreadableRestorePointError("malformed envelope");
  }
  let plain: Uint8Array;
  try {
    const sdek = await resolveSdek(env.keyVersion);
    plain = decryptBytesWithSdek(env as EncryptionEnvelope, sdek, pointAad(pointId));
  } catch {
    throw new UnreadableRestorePointError("it failed authentication");
  }
  let parsed: unknown;
  try {
    const bytes = codec === "deflate-raw" ? await inflateRaw(plain) : plain;
    parsed = JSON.parse(textDecoder.decode(bytes));
  } catch {
    throw new UnreadableRestorePointError("it is not valid data");
  }
  return validatePoint(parsed);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOT_IDS: ReadonlySet<string> = new Set(Object.values(ROOT_OBJECT_IDS));
const KINDS: ReadonlySet<string> = new Set(["manual", "scheduled", "pre_restore", "pre_import", "pre_resync", "mass_delete"]);

/** Checks the plaintext's shape and the tree it describes: ids are UUIDs and
 * unique, every parent is a root or an earlier node (so no cycles), URLs sit
 * on bookmarks only. Throws `UnreadableRestorePointError`. */
export function validatePoint(value: unknown): PointPlaintext {
  const fail = (reason: string): never => {
    throw new UnreadableRestorePointError(reason);
  };
  if (typeof value !== "object" || value === null) return fail("not an object");
  const point = value as Record<string, unknown>;
  if (typeof point.v === "number" && point.v !== POINT_VERSION) throw new UnsupportedRestorePointVersionError(point.v);
  if (point.v !== POINT_VERSION) return fail("missing version");
  if (typeof point.createdAt !== "string" || Number.isNaN(Date.parse(point.createdAt))) return fail("bad date");
  if (typeof point.deviceId !== "string") return fail("bad device");
  if (typeof point.kind !== "string" || !KINDS.has(point.kind)) return fail("bad kind");
  if (!Array.isArray(point.nodes)) return fail("no nodes");

  const seen = new Set<string>();
  for (const raw of point.nodes as unknown[]) {
    if (typeof raw !== "object" || raw === null) return fail("bad node");
    const node = raw as Record<string, unknown>;
    if (typeof node.o !== "string" || !UUID.test(node.o)) return fail("bad node id");
    if (ROOT_IDS.has(node.o) || seen.has(node.o)) return fail("duplicate or root node");
    if (node.k !== "b" && node.k !== "f") return fail("bad node kind");
    if (typeof node.t !== "string") return fail("bad title");
    if (typeof node.x !== "string" || node.x.length === 0) return fail("bad position");
    if (typeof node.p !== "string" || !(ROOT_IDS.has(node.p) || seen.has(node.p))) return fail("bad parent");
    if (node.k === "b") {
      if (typeof node.u !== "string") return fail("bookmark without a url");
    } else if (node.u !== undefined) {
      return fail("folder with a url");
    }
    seen.add(node.o);
  }
  return value as PointPlaintext;
}
