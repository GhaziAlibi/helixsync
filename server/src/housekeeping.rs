// Background retention sweep for three tables that otherwise accumulate
// rows forever: `device_credentials` (one new row per credential rotation),
// `web_sessions` (one row per web login, never removed on expiry/revocation),
// and `audit_logs` (appended on every auth/revocation/settings-change
// event). Unlike `sync::compaction`, none of these deletes needs a snapshot
// or any other precondition first — each row's data has no downstream
// consumer once it's past its retention window. Each delete is still
// chunked in bounded passes (see `DELETE_CHUNK_SIZE`) rather than a single
// unconditional statement, since any of the three can accumulate a large
// backlog between sweeps and an unchunked DELETE over that many rows would
// hold row-exclusive locks and spike WAL for the full duration of one giant
// statement.
use std::time::Duration;

use chrono::Utc;

use crate::error::AppResult;
use crate::state::AppState;

/// Max rows removed per DELETE statement in each housekeeping sweep. Kept
/// small enough that no single statement holds row-exclusive locks or
/// spikes WAL for long, regardless of how large the backlog is — mirrors
/// `sync::compaction::compact_user_sync_operations_chunked`'s
/// `DELETE_CHUNK_SIZE`.
const DELETE_CHUNK_SIZE: i64 = 5_000;

/// Spawns the periodic housekeeping task for the lifetime of the process.
/// Call once from `main.rs` after `AppState` is constructed.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(state.config.housekeeping_interval_secs));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            run_once(&state).await;
        }
    });
}

/// Runs one housekeeping pass. Exposed separately from `spawn`'s loop so
/// tests can run a single pass synchronously.
///
/// Each table's delete is independent and runs on its own, rather than
/// inside a shared transaction: there's no cross-table invariant to
/// preserve here (unlike `sync::compaction`'s snapshot-before-delete
/// requirement), so one table's delete failing shouldn't block the others
/// from running. Errors are logged per-table instead of propagated so a
/// single bad pass never crashes the task.
pub async fn run_once(state: &AppState) {
    if let Err(e) = delete_expired_device_credentials(state).await {
        tracing::error!(error = %e, "housekeeping: device_credentials cleanup failed");
    }

    if let Err(e) = delete_expired_web_sessions(state).await {
        tracing::error!(error = %e, "housekeeping: web_sessions cleanup failed");
    }

    if let Err(e) = delete_old_audit_logs(state).await {
        tracing::error!(error = %e, "housekeeping: audit_logs cleanup failed");
    }
}

async fn delete_expired_device_credentials(state: &AppState) -> AppResult<()> {
    let cutoff =
        Utc::now() - chrono::Duration::seconds(state.config.device_credential_retention_secs);
    let mut total_rows: u64 = 0;
    loop {
        let result = sqlx::query!(
            "DELETE FROM device_credentials WHERE id IN ( \
                SELECT id FROM device_credentials WHERE expires_at < $1 LIMIT $2 \
             )",
            cutoff,
            DELETE_CHUNK_SIZE
        )
        .execute(&state.db)
        .await?;
        total_rows += result.rows_affected();
        if result.rows_affected() == 0 {
            break;
        }
    }
    tracing::debug!(rows = total_rows, "housekeeping: pruned device_credentials");
    Ok(())
}

// No grace period past `expires_at` here, unlike `device_credentials`: an
// expired web session has no other data derived from it that a small
// window would protect, so "expired" alone is the right cutoff.
async fn delete_expired_web_sessions(state: &AppState) -> AppResult<()> {
    let now = Utc::now();
    let mut total_rows: u64 = 0;
    loop {
        let result = sqlx::query!(
            "DELETE FROM web_sessions WHERE id IN ( \
                SELECT id FROM web_sessions WHERE expires_at < $1 LIMIT $2 \
             )",
            now,
            DELETE_CHUNK_SIZE
        )
        .execute(&state.db)
        .await?;
        total_rows += result.rows_affected();
        if result.rows_affected() == 0 {
            break;
        }
    }
    tracing::debug!(rows = total_rows, "housekeeping: pruned web_sessions");
    Ok(())
}

async fn delete_old_audit_logs(state: &AppState) -> AppResult<()> {
    let cutoff = Utc::now() - chrono::Duration::seconds(state.config.audit_log_retention_secs);
    let mut total_rows: u64 = 0;
    loop {
        let result = sqlx::query!(
            "DELETE FROM audit_logs WHERE id IN ( \
                SELECT id FROM audit_logs WHERE created_at < $1 LIMIT $2 \
             )",
            cutoff,
            DELETE_CHUNK_SIZE
        )
        .execute(&state.db)
        .await?;
        total_rows += result.rows_affected();
        if result.rows_affected() == 0 {
            break;
        }
    }
    tracing::debug!(rows = total_rows, "housekeeping: pruned audit_logs");
    Ok(())
}
