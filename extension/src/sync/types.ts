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
