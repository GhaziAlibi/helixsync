// Wire types mirroring docs/protocol.md. Keep in sync with the server's
// src/sync/model.rs — this file has no runtime dependency on the server,
// but the shapes must match exactly since they cross the wire as JSON.

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
  /** Single-operation history import (historyVisit / bulkImport,
   * docs/protocol.md §8.3): how many plaintext visits this op carries.
   * Omitted for all other ops; the server rejects non-bulk ops carrying it. */
  visitCount?: number;
  /** Per-hour visit-COUNT histogram (docs/protocol.md §8.3.2): hour-aligned
   * UTC RFC3339 timestamp (see util/hour.ts's `hourKey`) -> plaintext count.
   * Sent in the clear so the server can track real visit-time retention
   * without ever seeing a URL or title — only `historyVisit` ops carry this;
   * the server rejects it on anything else. A live `visit` op carries
   * exactly one entry with value 1; a `bulkImport` chunk's entries sum to
   * its `visitCount`. Omitted entirely for ops built before this field
   * existed (older queued IndexedDB rows) — the server falls back to
   * bucketing those at their upload hour. */
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

// --- Single-operation history import (historyVisit / bulkImport,
// docs/protocol.md §8.3, docs/encryption.md §6) ---

/** One visit inside a bulk segment (pre-encryption plaintext). */
export interface BulkVisit {
  url: string;
  title?: string;
  visitedAt: string;
}

/** Per-segment plaintext (pre-encryption): ~10k visits per segment. */
export interface BulkSegmentPlaintextV1 {
  v: 1;
  visits: BulkVisit[];
}

/** Stored op payload (v1): plaintext visit count plus N standard §6
 * envelopes (own nonce, own tag) under the same SDEK/keyVersion. The server
 * stores this opaquely and never inspects the segments — only visitCount. */
export interface BulkHistoryContainerV1 {
  v: 1;
  bulkVersion: 1;
  visitCount: number;
  segments: unknown[];
}

// --- bulkVersion 2: grouped-by-URL container (CPU-reduction spec §C/§D) ---
//
// v1 repeats the full `url` (and `title`) for every visit of that URL, even
// though enumerateVisits already has visits grouped per URL before it
// flattens them for the wire. v2 declines to throw that grouping away: one
// `u`/`t` per URL, an array of visit times under it. Short field names (`u`,
// `t`, `v`) are deliberate — this plaintext is what gets compressed (§D) and
// then base64'd, so per-field name overhead is paid per segment either way.

/** One URL's visits inside a v2 segment (pre-encryption plaintext). */
export interface BulkVisitGroup {
  u: string; // url
  t?: string; // title
  v: number[]; // visit times, epoch ms
}

/** Per-segment plaintext (pre-encryption), v2: grouped by URL. */
export interface BulkSegmentPlaintextV2 {
  v: 2;
  groups: BulkVisitGroup[];
}

/** Stored op payload (v2). `codec` names the compression applied to the
 * plaintext bytes before encryption (§D) — absent means uncompressed, not
 * "unknown"; a producer that can't confirm CompressionStream support omits
 * it rather than guessing. The server still never inspects `segments`. */
export interface BulkHistoryContainerV2 {
  v: 1;
  bulkVersion: 2;
  codec?: "deflate-raw";
  visitCount: number;
  segments: unknown[];
}

/** Stored op payload, either wire version. Old clients that only know v1
 * (protocol.md §13) store-but-don't-apply anything with bulkVersion !== 1;
 * v1 data is never rewritten to v2. */
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
