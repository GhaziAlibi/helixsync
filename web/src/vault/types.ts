// Decoded vault data. Everything here is plaintext and lives in memory only
// (see keyring.ts and store.ts); nothing in this folder writes to browser storage.

export interface VaultBookmark {
  id: string;
  title: string;
  url: string;
  /** objectId of the parent folder, or null at the top. */
  parent: string | null;
  position: string;
}

export interface VaultFolder {
  id: string;
  title: string;
  parent: string | null;
  position: string;
}

export interface VaultVisit {
  url: string;
  title: string;
  /** Epoch milliseconds. */
  t: number;
}

export interface VaultTab {
  id: string;
  /** The device whose operation produced this tab's current state. */
  deviceId: string;
  windowId: string;
  groupId: string | null;
  url: string;
  title: string;
  pinned: boolean;
  index: number;
  active: boolean;
}

export interface VaultWindow {
  id: string;
  deviceId: string;
  focused: boolean;
  incognito: boolean;
}

export interface VaultTabGroup {
  id: string;
  deviceId: string;
  title: string;
  color: string;
  collapsed: boolean;
}

export interface VaultData {
  bookmarks: VaultBookmark[];
  folders: VaultFolder[];
  /** Newest first. */
  history: VaultVisit[];
  tabs: VaultTab[];
  windows: VaultWindow[];
  tabGroups: VaultTabGroup[];
  /** Records that failed authentication, were malformed, or were not
   * encrypted, and so were left out. */
  unreadable: number;
  /** Records that decrypted but are still only part of an object's state
   * (an older server that sends no `layers`, or operations compacted away
   * before it did) and so can't be shown. */
  incomplete: number;
}

/** What the server's `/sync/snapshot` returns, for the fields the vault reads. */
export interface SnapshotObjectWire {
  objectType: string;
  objectId: string;
  operationType: string;
  encryptionVersion: number;
  payload: unknown;
  deviceId?: string;
  /** Earlier operations of an encrypted object whose latest operation holds
   * only part of its state, oldest first (docs/protocol.md §10.3). Applied in
   * order, then `payload`. Absent from older servers. */
  layers?: SnapshotLayerWire[];
}

export interface SnapshotLayerWire {
  operationType: string;
  payload: unknown;
  lamportTimestamp?: number;
  deviceId?: string;
  operationId?: string;
}

export interface SnapshotWire {
  snapshotCursor: number;
  objects: SnapshotObjectWire[];
  tombstones: Array<{ objectType: string; objectId: string }>;
}
