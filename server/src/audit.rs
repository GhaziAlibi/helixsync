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

/// Records an event that has no user or device (operator actions such as
/// backups), with a small JSON `metadata` object. Takes the pool instead of
/// the app state because the operator commands run without one. Never put
/// secrets in `metadata` (docs/security.md §7).
pub async fn record(db: &sqlx::PgPool, event_type: &str, metadata: serde_json::Value) {
    if let Err(e) = sqlx::query("INSERT INTO audit_logs (event_type, metadata) VALUES ($1, $2)")
        .bind(event_type)
        .bind(metadata)
        .execute(db)
        .await
    {
        tracing::error!(error = %e, %event_type, "audit: log write failed");
    }
}
