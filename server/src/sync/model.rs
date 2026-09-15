use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Wire format for an operation uploaded by a device. Note there is no
/// `deviceId` or `createdAt` field here: `deviceId` is always taken from
/// the authenticated device credential (docs/security.md §3), and
/// `createdAt` is server-assigned at insert time.
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
    /// When the operation that produced this object's current merged state
    /// was uploaded (`sync_operations.created_at`) — the same timestamp
    /// `history_retention_cutoff`/`compute_objects` (`sync::routes`) filter
    /// `historyVisit` operations against (SRV-1). Carrying it forward here
    /// is what lets a `historyVisit` object *already folded into a
    /// persisted snapshot* be re-evaluated against retention on every
    /// future `compute_objects` call: a historyVisit is immutable (never
    /// produces a second operation once created), so once one lands in
    /// `objects` it would otherwise never appear in `new_rows` again to be
    /// filtered, and would stay embedded in every snapshot forever
    /// regardless of the configured retention window.
    ///
    /// `#[serde(default = "epoch")]` covers every snapshot blob persisted
    /// before this field existed: it deserializes as the Unix epoch, which
    /// is older than any configured retention cutoff, so a legacy object is
    /// treated as immediately eligible for pruning rather than permanently
    /// un-prunable for lack of a recorded timestamp.
    #[serde(default = "epoch")]
    pub created_at: DateTime<Utc>,
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
    pub objects: Vec<SnapshotObject>,
    pub tombstones: Vec<SnapshotTombstone>,
}
