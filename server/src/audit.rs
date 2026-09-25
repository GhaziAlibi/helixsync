use uuid::Uuid;

use crate::state::AppState;

/// Record a security-relevant event. Per docs/security.md §7, this never
/// receives secrets/tokens/decrypted payloads as `event_type` or metadata.
pub async fn log(
    state: &AppState,
    user_id: Option<Uuid>,
    device_id: Option<Uuid>,
    event_type: &str,
) {
    if let Err(e) = sqlx::query!(
        "INSERT INTO audit_logs (user_id, device_id, event_type) VALUES ($1, $2, $3)",
        user_id,
        device_id,
        event_type
    )
    .execute(&state.db)
    .await
    {
        tracing::error!(error = %e, %event_type, "audit: log write failed");
    }
}
