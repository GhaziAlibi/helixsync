use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct UserPublic {
    pub id: Uuid,
    pub email: String,
}

/// The authenticated web-account principal, extracted from a valid session
/// cookie. See docs/security.md §1.1.
#[derive(Debug, Clone)]
pub struct AuthenticatedUser {
    pub user_id: Uuid,
    pub email: String,
}

/// The authenticated device principal, extracted from a valid device access
/// token. See docs/security.md §1.2 and docs/protocol.md §7.
#[derive(Debug, Clone)]
pub struct AuthenticatedDevice {
    pub device_id: Uuid,
    pub user_id: Uuid,
}
