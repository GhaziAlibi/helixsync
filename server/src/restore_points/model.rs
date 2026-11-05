use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use uuid::Uuid;

/// Kinds a point may be uploaded with (matches the table's CHECK).
pub const KINDS: &[&str] = &[
    "manual",
    "scheduled",
    "pre_restore",
    "pre_import",
    "pre_resync",
    "mass_delete",
];

pub const CODEC_DEFLATE_RAW: &str = "deflate-raw";

/// Upper bound for `bookmarkCount`, a sanity check on a client-reported number.
pub const MAX_BOOKMARK_COUNT: i64 = 1_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRequest {
    pub id: Uuid,
    pub kind: String,
    pub bookmark_count: i64,
    pub encryption_version: i32,
    #[serde(default)]
    pub codec: Option<String>,
    /// Kept as the exact JSON text sent; the server never parses it.
    pub envelope: Box<RawValue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinRequest {
    pub pinned: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedRequest {
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct RestorePointMeta {
    pub id: Uuid,
    pub kind: String,
    pub bookmark_count: i32,
    pub encryption_version: i32,
    pub codec: Option<String>,
    pub size_bytes: i32,
    pub pinned: bool,
    pub created_at: DateTime<Utc>,
    pub last_restored_at: Option<DateTime<Utc>>,
    pub device_id: Option<Uuid>,
    pub device_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResponse {
    pub points: Vec<RestorePointMeta>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResponse {
    #[serde(flatten)]
    pub meta: RestorePointMeta,
    pub envelope: Box<RawValue>,
}
