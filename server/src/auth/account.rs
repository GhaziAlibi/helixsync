//! Account deletion, shared by `DELETE /auth/account` and the operator's
//! `helixsync-server delete-account <email>` command (docs/security.md §11).

use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::normalize_email;
use crate::error::AppResult;

/// What the database cascade can't reach: the deleted account's web-session
/// hashes and device ids, so a running server can purge its in-memory caches.
pub struct DeletedAccount {
    pub session_hashes: Vec<String>,
    pub device_ids: Vec<Uuid>,
}

/// Deletes the account and everything under it, recording `audit_event` in
/// the same transaction. Returns `None` if the account no longer exists (a
/// concurrent delete won the race).
///
/// Every other table references `users` with `ON DELETE CASCADE` (audit rows
/// are `SET NULL`, so the event trail survives without the user id), so
/// deleting the one row is the whole database cleanup.
pub async fn delete_user(
    db: &PgPool,
    user_id: Uuid,
    audit_event: &str,
) -> AppResult<Option<DeletedAccount>> {
    let mut tx = db.begin().await?;

    // Lock the user row first. Inserting a session or device takes a
    // FOR KEY SHARE lock on it through the foreign key, so a login or device
    // registration racing with this delete either lands before the lock (and
    // shows up in the lists below) or waits and then fails its foreign key.
    // Without it, the lists could miss a row that the cascade then deletes.
    let locked = sqlx::query!("SELECT id FROM users WHERE id = $1 FOR UPDATE", user_id)
        .fetch_optional(&mut *tx)
        .await?;
    if locked.is_none() {
        return Ok(None);
    }

    let session_hashes = sqlx::query_scalar!(
        "SELECT session_hash FROM web_sessions WHERE user_id = $1",
        user_id
    )
    .fetch_all(&mut *tx)
    .await?;

    let device_ids = sqlx::query_scalar!("SELECT id FROM devices WHERE user_id = $1", user_id)
        .fetch_all(&mut *tx)
        .await?;

    // Written in the same transaction as the delete, so the event exists
    // exactly when the account is gone. The cascade nulls its `user_id`.
    sqlx::query!(
        "INSERT INTO audit_logs (user_id, device_id, event_type) VALUES ($1, NULL, $2)",
        user_id,
        audit_event
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!("DELETE FROM users WHERE id = $1", user_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(Some(DeletedAccount {
        session_hashes,
        device_ids,
    }))
}

/// The operator command's entry point: deletes the account registered under
/// `email`, audited as `account_deleted_by_operator`. Returns `None` if no
/// account uses that email.
///
/// Runs in its own process, so it can't touch a running server's caches:
/// that server keeps accepting the account's cached sessions and device
/// tokens until their entries expire (`WEB_SESSION_CACHE_TTL` and
/// `DEVICE_REVOCATION_CACHE_TTL`, 30 seconds).
pub async fn delete_user_by_email(db: &PgPool, email: &str) -> AppResult<Option<DeletedAccount>> {
    let email = normalize_email(email);
    let user_id = sqlx::query_scalar!("SELECT id FROM users WHERE email = $1", email)
        .fetch_optional(db)
        .await?;
    match user_id {
        Some(user_id) => delete_user(db, user_id, "account_deleted_by_operator").await,
        None => Ok(None),
    }
}
