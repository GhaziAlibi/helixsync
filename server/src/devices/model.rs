use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DevicePublic {
    pub id: Uuid,
    pub name: String,
    pub browser: Option<String>,
    pub browser_version: Option<String>,
    pub platform: Option<String>,
    pub extension_version: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

/// `DevicePublic` plus live connection state, for `GET /devices`.
#[derive(Debug, Serialize)]
pub struct DeviceListEntry {
    #[serde(flatten)]
    pub device: DevicePublic,
    /// True while the device has an open websocket.
    pub online: bool,
}
