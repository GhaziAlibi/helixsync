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
