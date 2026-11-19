// Turns a `/sync/snapshot` response into plaintext vault data. Pure: no
// network, no storage. Mirrors how the extension reads the same objects
// (extension/src/sync/engine.ts, extension/src/history/bulk.ts).
import {
  UnsupportedEnvelopeVersionError,
  assertSupportedEnvelopeVersion,
  buildOperationAad,
  decryptBytesWithSdek,
  getSdek,
  type EncryptionEnvelope,
} from "../crypto";
import type {
  SnapshotObjectWire,
  SnapshotWire,
  VaultBookmark,
  VaultData,
  VaultFolder,
  VaultTab,
  VaultTabGroup,
  VaultVisit,
  VaultWindow,
} from "./types";

const textDecoder = new TextDecoder();

/** Largest a decompressed history segment may be. A segment holds a few
 * thousand visits; this only stops a hostile server's compression bomb. */
const MAX_INFLATED_SEGMENT_BYTES = 64 * 1024 * 1024;

/** `deflate-raw` through the browser's `DecompressionStream`. */
export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("deflate-raw is not supported by this browser");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_INFLATED_SEGMENT_BYTES) {
      await reader.cancel();
      throw new Error("history segment is too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBulkImport(object: SnapshotObjectWire): boolean {
  return object.objectType === "historyVisit" && object.operationType === "bulkImport";
}

/** Throws `UnsupportedEnvelopeVersionError` if any object holds an envelope in
 * a format this build can't read. Reads only the `v` tags, so it runs over the
 * whole snapshot first: the vault never shows a partial result as complete. */
export function assertSnapshotSupported(objects: SnapshotObjectWire[]): void {
  for (const object of objects) {
    if (isBulkImport(object)) {
      const segments = isRecord(object.payload) ? object.payload.segments : undefined;
      if (Array.isArray(segments)) for (const segment of segments) assertSupportedEnvelopeVersion(segment);
    } else {
      assertSupportedEnvelopeVersion(object.payload);
      for (const layer of object.layers ?? []) assertSupportedEnvelopeVersion(layer.payload);
    }
  }
}

interface Counters {
  unreadable: number;
  incomplete: number;
}

type SdekFor = (keyVersion: number) => Promise<Uint8Array>;

function sdekResolver(accountKey: Uint8Array): SdekFor {
  const byVersion = new Map<number, Uint8Array>();
  return async (keyVersion) => {
    let sdek = byVersion.get(keyVersion);
    if (!sdek) {
      sdek = await getSdek(accountKey, keyVersion);
      byVersion.set(keyVersion, sdek);
    }
    return sdek;
  };
}

function isEnvelope(value: unknown): value is EncryptionEnvelope {
  return isRecord(value) && typeof value.ciphertext === "string" && typeof value.nonce === "string";
}

async function decryptPayload(
  payload: unknown,
  objectType: string,
  objectId: string,
  operationType: string,
  sdekFor: SdekFor,
): Promise<Record<string, unknown>> {
  if (!isEnvelope(payload)) throw new Error("payload is not an envelope");
  const sdek = await sdekFor(payload.keyVersion);
  const aad = buildOperationAad(objectType, objectId, operationType);
  const plaintext: unknown = JSON.parse(textDecoder.decode(decryptBytesWithSdek(payload, sdek, aad)));
  if (!isRecord(plaintext)) throw new Error("record is not an object");
  return plaintext;
}

/** An object's current state: its `layers` (earlier operations, oldest first)
 * then its latest operation, each field taken from the last operation that set
 * it. A layer that fails authentication is skipped and counted; the latest
 * operation failing fails the object. Each operation is authenticated with its
 * own operation type, like the extension does. */
async function decryptRecord(
  object: SnapshotObjectWire,
  sdekFor: SdekFor,
  counters: Counters,
): Promise<Record<string, unknown>> {
  const record: Record<string, unknown> = {};
  let layerFailed = false;
  for (const layer of object.layers ?? []) {
    try {
      Object.assign(record, await decryptPayload(layer.payload, object.objectType, object.objectId, layer.operationType, sdekFor));
    } catch (err) {
      if (err instanceof UnsupportedEnvelopeVersionError) throw err;
      layerFailed = true;
    }
  }
  Object.assign(
    record,
    await decryptPayload(object.payload, object.objectType, object.objectId, object.operationType, sdekFor),
  );
  if (layerFailed) counters.unreadable += 1;
  return record;
}

/** One history entry before it becomes a `VaultVisit`. */
interface RawVisit {
  url: string;
  title?: string;
  t: number;
}

/** Decodes `{v:2, groups}` and `{v:1, visits}` segment plaintext. */
function decodeSegment(plaintext: unknown): RawVisit[] | null {
  if (!isRecord(plaintext)) return null;
  const out: RawVisit[] = [];
  if (plaintext.v === 2) {
    if (!Array.isArray(plaintext.groups)) return null;
    for (const group of plaintext.groups) {
      if (!isRecord(group) || typeof group.u !== "string" || !Array.isArray(group.v)) continue;
      const title = typeof group.t === "string" ? group.t : undefined;
      for (const t of group.v) if (typeof t === "number" && Number.isFinite(t)) out.push({ url: group.u, title, t });
    }
    return out;
  }
  if (!Array.isArray(plaintext.visits)) return null;
  for (const visit of plaintext.visits) {
    if (!isRecord(visit) || typeof visit.url !== "string" || typeof visit.visitedAt !== "string") continue;
    const t = new Date(visit.visitedAt).getTime();
    if (!Number.isFinite(t)) continue;
    out.push({ url: visit.url, title: typeof visit.title === "string" ? visit.title : undefined, t });
  }
  return out;
}

async function decodeBulkSegments(
  object: SnapshotObjectWire,
  sdekFor: SdekFor,
  counters: Counters,
  onVisit: (visit: RawVisit) => void,
): Promise<void> {
  if (!isRecord(object.payload) || !Array.isArray(object.payload.segments)) {
    counters.unreadable += 1;
    return;
  }
  const deflated = object.payload.codec === "deflate-raw";
  for (const segment of object.payload.segments) {
    try {
      // A segment without ciphertext is never read as plaintext.
      if (!isEnvelope(segment)) throw new Error("segment is not an envelope");
      const sdek = await sdekFor(segment.keyVersion);
      const aad = buildOperationAad("historyVisit", object.objectId, "bulkImport");
      const bytes = decryptBytesWithSdek(segment, sdek, aad);
      const plaintext: unknown = JSON.parse(textDecoder.decode(deflated ? await inflateRaw(bytes) : bytes));
      const visits = decodeSegment(plaintext);
      if (!visits) throw new Error("unrecognized segment");
      for (const visit of visits) onVisit(visit);
    } catch (err) {
      if (err instanceof UnsupportedEnvelopeVersionError) throw err;
      counters.unreadable += 1;
    }
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parentOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Decrypts every object of a snapshot the vault shows. `accountKey` is the
 * 32-byte account key. Throws `UnsupportedEnvelopeVersionError` if any
 * envelope is from a format this build can't read; a record that fails
 * authentication is skipped and counted in `unreadable`. */
export async function decodeSnapshot(snapshot: SnapshotWire, accountKey: Uint8Array): Promise<VaultData> {
  assertSnapshotSupported(snapshot.objects);

  const sdekFor = sdekResolver(accountKey);
  const counters: Counters = { unreadable: 0, incomplete: 0 };
  const bookmarks: VaultBookmark[] = [];
  const folders: VaultFolder[] = [];
  const tabs: VaultTab[] = [];
  const windows: VaultWindow[] = [];
  const tabGroups: VaultTabGroup[] = [];
  const history: VaultVisit[] = [];
  // The same visit can arrive live and again inside a later bulk import.
  const seenVisits = new Set<string>();
  const addVisit = (visit: RawVisit): void => {
    const key = `${visit.t}\n${visit.url}`;
    if (seenVisits.has(key)) return;
    seenVisits.add(key);
    history.push({ url: visit.url, title: visit.title ?? "", t: visit.t });
  };

  for (const object of snapshot.objects) {
    const kind = object.objectType;
    if (
      kind !== "bookmark" &&
      kind !== "bookmarkFolder" &&
      kind !== "historyVisit" &&
      kind !== "tab" &&
      kind !== "window" &&
      kind !== "tabGroup"
    ) {
      continue;
    }
    // This client never reads unencrypted data, as the extension doesn't.
    if (object.encryptionVersion < 1) {
      counters.unreadable += 1;
      continue;
    }

    if (isBulkImport(object)) {
      await decodeBulkSegments(object, sdekFor, counters, addVisit);
      continue;
    }

    let record: Record<string, unknown>;
    try {
      record = await decryptRecord(object, sdekFor, counters);
    } catch (err) {
      if (err instanceof UnsupportedEnvelopeVersionError) throw err;
      counters.unreadable += 1;
      continue;
    }

    const id = object.objectId;
    const deviceId = object.deviceId ?? "";

    switch (kind) {
      case "bookmark": {
        const url = str(record.url);
        if (url === undefined || url === "") {
          counters.incomplete += 1;
          break;
        }
        bookmarks.push({
          id,
          title: str(record.title) ?? "",
          url,
          parent: parentOf(record.parent),
          position: str(record.position) ?? "",
        });
        break;
      }
      case "bookmarkFolder": {
        const title = str(record.title);
        if (title === undefined) {
          counters.incomplete += 1;
          break;
        }
        folders.push({ id, title, parent: parentOf(record.parent), position: str(record.position) ?? "" });
        break;
      }
      case "historyVisit": {
        const url = str(record.url);
        const t = new Date(str(record.visitedAt) ?? NaN).getTime();
        if (url === undefined || !Number.isFinite(t)) {
          counters.unreadable += 1;
          break;
        }
        addVisit({ url, title: str(record.title), t });
        break;
      }
      case "tab": {
        const url = str(record.url);
        const windowId = str(record.windowObjectId);
        if (url === undefined || windowId === undefined) {
          counters.incomplete += 1;
          break;
        }
        tabs.push({
          id,
          deviceId,
          windowId,
          groupId: parentOf(record.groupObjectId),
          url,
          title: str(record.title) ?? "",
          pinned: record.pinned === true,
          index: typeof record.index === "number" ? record.index : 0,
          active: record.active === true,
        });
        break;
      }
      case "window":
        windows.push({ id, deviceId, focused: record.focused === true, incognito: record.incognito === true });
        break;
      case "tabGroup":
        tabGroups.push({
          id,
          deviceId,
          title: str(record.title) ?? "",
          color: str(record.color) ?? "",
          collapsed: record.collapsed === true,
        });
        break;
    }
  }

  history.sort((a, b) => b.t - a.t);
  return { bookmarks, folders, history, tabs, windows, tabGroups, ...counters };
}
