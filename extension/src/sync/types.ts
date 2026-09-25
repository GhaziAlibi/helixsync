// Wire types mirroring docs/protocol.md. Must match the server's
// src/sync/model.rs exactly, since they cross the wire as JSON.

export type ObjectType =
  | "bookmark"
  | "bookmarkFolder"
  | "historyVisit"
  | "tab"
  | "window"
  | "tabGroup"
  | "extensionMeta"
  | "extensionStorageEntry";

export type OperationType =
  | "create"
  | "update"
  | "move"
  | "delete"
  | "restore"
  | "visit"
  | "bulkImport"
  | "close"
  | "activate"
  | "observe"
  | "set";

export interface OperationOut {
  operationId: string;
  deviceId: string;
  deviceSequence: number;
  lamportTimestamp: number;
  objectType: ObjectType;
  objectId: string;
  operationType: OperationType;
  encryptionVersion: number;
  payload: unknown;
  serverCursor: number;
  createdAt: string;
}

/** A locally-created operation, pre-upload. Mirrors OperationIn on the server. */
export interface LocalOperation {
  operationId: string;
  deviceSequence: number;
  lamportTimestamp: number;
  objectType: ObjectType;
  objectId: string;
  operationType: OperationType;
  encryptionVersion: number;
  payload: unknown;
  /** Plaintext visit count of a historyVisit/bulkImport op (docs/protocol.md
   * §8.3). The server rejects it on any other op. */
  visitCount?: number;
  /** Plaintext per-hour visit-count histogram (`hourKey` -> count,
   * docs/protocol.md §8.3.2), historyVisit ops only. Lets the server track
   * visit-time retention without seeing URLs. A live `visit` carries one
   * entry of 1; a `bulkImport` chunk's entries sum to its `visitCount`.
   * Older queued rows lack it and are bucketed at upload hour. */
  visitHours?: Record<string, number>;
}

export interface UploadRejection {
  operationId: string;
  reason: string;
}

export interface UploadResponse {
  accepted: string[];
  duplicate: string[];
  rejected: UploadRejection[];
  serverCursor: number;
}

export interface DownloadResponse {
  operations: OperationOut[];
  nextCursor: number;
  hasMore: boolean;
}

export interface SnapshotObject {
  objectType: ObjectType;
  objectId: string;
  operationType: OperationType;
  encryptionVersion: number;
  payload: unknown;
}

export interface SnapshotTombstone {
  objectType: ObjectType;
  objectId: string;
}

export interface SnapshotResponse {
  snapshotCursor: number;
  objects: SnapshotObject[];
  tombstones: SnapshotTombstone[];
}

// --- Payload shapes for known object types (docs/protocol.md §6, §8) ---

export interface BookmarkPayload {
  title: string;
  url: string | null; // null for folders
  parent: string | null; // objectId of parent folder
  position: string; // fractional index key
}

export interface HistoryVisitPayload {
  url: string;
  title?: string;
  visitedAt: string;
  transition?: string;
}

// --- Bulk history import (historyVisit / bulkImport, docs/protocol.md §8.3,
// docs/encryption.md §6) ---

/** One visit inside a v1 bulk segment (pre-encryption plaintext). */
export interface BulkVisit {
  url: string;
  title?: string;
  visitedAt: string;
}

// Note on the `v` fields below: they version the *layout* of a bulk segment's
// plaintext and of the container around the segments. They are unrelated to
// the encryption envelope's own `v` (ENVELOPE_VERSION in ../crypto), which
// every segment carries separately.

export interface BulkSegmentPlaintextV1 {
  v: 1;
  visits: BulkVisit[];
}

/** Stored op payload (v1): plaintext visit count plus N standard §6
 * envelopes under one SDEK. The server only ever reads `visitCount`. The
 * container itself is not an envelope, so its `v` is just a layout version. */
export interface BulkHistoryContainerV1 {
  v: 1;
  bulkVersion: 1;
  visitCount: number;
  segments: unknown[];
}

// --- bulkVersion 2: visits grouped by URL, so url/title appear once per URL.
// Field names are short on purpose: this plaintext is compressed, encrypted
// and base64'd, so key overhead is paid per group. ---

export interface BulkVisitGroup {
  u: string; // url
  t?: string; // title
  v: number[]; // visit times, epoch ms
}

export interface BulkSegmentPlaintextV2 {
  v: 2;
  groups: BulkVisitGroup[];
}

/** Stored op payload (v2). `codec` is the compression applied to plaintext
 * bytes before encryption; absent means uncompressed. */
export interface BulkHistoryContainerV2 {
  v: 1;
  bulkVersion: 2;
  codec?: "deflate-raw";
  visitCount: number;
  segments: unknown[];
}

/** Either wire version. v1 data is never rewritten, so both must decode
 * forever; v1-only clients store-but-don't-apply v2 (protocol.md §13). */
export type BulkHistoryContainer = BulkHistoryContainerV1 | BulkHistoryContainerV2;

export interface TabPayload {
  url: string;
  title?: string;
  pinned: boolean;
  index: number;
  windowObjectId: string;
  active: boolean;
  groupObjectId?: string | null;
}

export interface WindowPayload {
  focused: boolean;
  incognito: boolean;
  state?: string;
}

export interface TabGroupPayload {
  title?: string;
  color?: string;
  collapsed: boolean;
}
