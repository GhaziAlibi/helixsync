use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// An operation uploaded by a device. There's no `deviceId` or `createdAt`:
/// the device comes from the auth token and the server sets the time.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationIn {
    pub operation_id: Uuid,
    pub device_sequence: i64,
    pub lamport_timestamp: i64,
    pub object_type: String,
    pub object_id: Uuid,
    pub operation_type: String,
    #[serde(default)]
    pub encryption_version: i32,
    pub payload: serde_json::Value,
    /// Number of visits in a historyVisit/bulkImport op (docs/protocol.md §8.3).
    /// `None` means one. Must be >= 1 when set (checked in `process_batch`).
    #[serde(default)]
    pub visit_count: Option<i64>,
    /// Hourly visit-count buckets (docs/protocol.md §8.3.2): hour-aligned UTC
    /// timestamp -> plaintext count, sent in the clear (URLs/titles stay
    /// encrypted in `payload`) so the server can track real visit-time
    /// retention through end-to-end encryption. `#[serde(rename_all =
    /// "camelCase")]` on this struct makes the wire field `visitHours`.
    /// Legal only on `historyVisit` ops (validated in
    /// `sync::routes::process_batch`, alongside the existing `visit_count`
    /// checks) — `None` means either a non-historyVisit op, or a historyVisit
    /// op from a client built before this field existed, which
    /// `process_batch`'s write path falls back to bucketing at its upload
    /// hour. Chrono's `DateTime<Utc>` deserializes the RFC3339
    /// (`"2026-09-23T09:00:00.000Z"`) map keys the extension sends.
    #[serde(default)]
    pub visit_hours: Option<BTreeMap<DateTime<Utc>, i64>>,
}

impl OperationIn {
    /// A `historyVisit`/`bulkImport` op: one chunk of an imported history
    /// carrying `visit_count` visits (docs/protocol.md §8.3).
    pub fn is_bulk_history_import(&self) -> bool {
        self.object_type == "historyVisit" && self.operation_type == "bulkImport"
    }
}

/// Wire format for an operation returned to a client via the download API.
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct OperationOut {
    pub operation_id: Uuid,
    pub device_id: Uuid,
    pub device_sequence: i64,
    pub lamport_timestamp: i64,
    pub object_type: String,
    pub object_id: Uuid,
    pub operation_type: String,
    pub encryption_version: i32,
    pub payload: serde_json::Value,
    pub server_cursor: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRejection {
    pub operation_id: Uuid,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResponse {
    pub accepted: Vec<Uuid>,
    pub duplicate: Vec<Uuid>,
    pub rejected: Vec<UploadRejection>,
    pub server_cursor: i64,
}

#[derive(Debug, Deserialize)]
pub struct UploadRequest {
    pub operations: Vec<OperationIn>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResponse {
    pub operations: Vec<OperationOut>,
    pub next_cursor: i64,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotObject {
    pub object_type: String,
    pub object_id: Uuid,
    pub operation_type: String,
    pub encryption_version: i32,
    pub payload: serde_json::Value,
    /// Upload time of the op that produced this state. Used to apply history
    /// retention to `historyVisit` objects already stored in a snapshot;
    /// otherwise they'd never be pruned.
    ///
    /// Old snapshots without this field default to the epoch, so they're
    /// pruned right away.
    #[serde(default = "epoch")]
    pub created_at: DateTime<Utc>,
    /// Number of visits this object represents (docs/protocol.md §8.3).
    /// `None` means one, which is also right for old snapshots.
    #[serde(default)]
    pub visit_count: Option<i64>,
    /// Ordering key of the op that produced this state.
    /// `filter_tombstoned` compares it with a tombstone's key to see which
    /// is newer.
    ///
    /// Old snapshots default to the minimum key, so any tombstone wins.
    #[serde(default)]
    pub lamport_timestamp: i64,
    #[serde(default = "Uuid::nil")]
    pub device_id: Uuid,
    #[serde(default = "Uuid::nil")]
    pub operation_id: Uuid,
}

impl SnapshotObject {
    pub fn ordering_key(&self) -> super::conflict::OrderingKey {
        super::conflict::OrderingKey {
            lamport_timestamp: self.lamport_timestamp,
            device_id: self.device_id,
            operation_id: self.operation_id,
        }
    }
}

fn epoch() -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp(0, 0).expect("0,0 is always a valid unix timestamp")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTombstone {
    pub object_type: String,
    pub object_id: Uuid,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResponse {
    pub snapshot_cursor: i64,
    /// Highest encryption version among `objects`: the version a client must
    /// support to read this snapshot (docs/protocol.md §10.3). `0` if empty.
    pub encryption_version: i32,
    pub objects: Vec<SnapshotObject>,
    pub tombstones: Vec<SnapshotTombstone>,
}
