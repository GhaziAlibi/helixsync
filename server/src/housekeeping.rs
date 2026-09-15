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
//
// The subqueries explicitly order by timestamp ASC (`expires_at` / `created_at`)
// so PostgreSQL's planner is compelled to use the timestamp B-tree indexes
// (`idx_device_credentials_expires_at`, `idx_web_sessions_expires_at`, and
// `idx_audit_logs_created_at`) rather than falling back to sequential scans or
// PK index scans (mirroring the query-plan guarantees in `sync::compaction`).
// Loops break early if fewer than `DELETE_CHUNK_SIZE` rows were affected to avoid
// an extra wasted round-trip query. Each sweep caps total deletions at
// `MAX_PRUNED_PER_PASS` and sleeps `PRUNE_COOPERATIVE_DELAY` between chunks
// to yield cooperatively to Tokio and prevent WAL/I/O spikes.
use std::time::Duration;

use chrono::Utc;

use crate::error::AppResult;
use crate::state::AppState;

/// Max rows removed per DELETE statement in each housekeeping sweep. Kept
/// small enough that no single statement holds row-exclusive locks or
/// spikes WAL for long, regardless of how large the backlog is — mirrors
/// `sync::compaction::DELETE_CHUNK_SIZE`.
pub const DELETE_CHUNK_SIZE: i64 = 5_000;

/// Sensible upper bound on total rows deleted per housekeeping pass per table (PERF-06).
/// Caps the deletion loop so an enormous backlog does not monopolize database
/// resources in a single pass (any remainder will be picked up on the next pass).
pub const MAX_PRUNED_PER_PASS: i64 = 50_000;

/// Cooperative delay between chunk deletions (PERF-06) to yield to Tokio so concurrent
/// tasks can acquire connections and Postgres write load is amortized.
pub const PRUNE_COOPERATIVE_DELAY: Duration = Duration::from_millis(10);

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
                SELECT id FROM device_credentials WHERE expires_at < $1 ORDER BY expires_at ASC LIMIT $2 \
             )",
            cutoff,
            DELETE_CHUNK_SIZE
        )
        .execute(&state.db)
        .await?;
        let rows_affected = result.rows_affected();
        total_rows += rows_affected;
        if rows_affected < DELETE_CHUNK_SIZE as u64 {
            break;
        }
        if total_rows >= MAX_PRUNED_PER_PASS as u64 {
            tracing::info!(
                total_pruned = total_rows,
                max = MAX_PRUNED_PER_PASS,
                "housekeeping: device_credentials prune hit per-pass deletion limit; remaining rows deferred to next pass"
            );
            break;
        }
        tokio::time::sleep(PRUNE_COOPERATIVE_DELAY).await;
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
                SELECT id FROM web_sessions WHERE expires_at < $1 ORDER BY expires_at ASC LIMIT $2 \
             )",
            now,
            DELETE_CHUNK_SIZE
        )
        .execute(&state.db)
        .await?;
        let rows_affected = result.rows_affected();
        total_rows += rows_affected;
        if rows_affected < DELETE_CHUNK_SIZE as u64 {
            break;
        }
        if total_rows >= MAX_PRUNED_PER_PASS as u64 {
            tracing::info!(
                total_pruned = total_rows,
                max = MAX_PRUNED_PER_PASS,
                "housekeeping: web_sessions prune hit per-pass deletion limit; remaining rows deferred to next pass"
            );
            break;
        }
        tokio::time::sleep(PRUNE_COOPERATIVE_DELAY).await;
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
                SELECT id FROM audit_logs WHERE created_at < $1 ORDER BY created_at ASC LIMIT $2 \
             )",
            cutoff,
            DELETE_CHUNK_SIZE
        )
        .execute(&state.db)
        .await?;
        let rows_affected = result.rows_affected();
        total_rows += rows_affected;
        if rows_affected < DELETE_CHUNK_SIZE as u64 {
            break;
        }
        if total_rows >= MAX_PRUNED_PER_PASS as u64 {
            tracing::info!(
                total_pruned = total_rows,
                max = MAX_PRUNED_PER_PASS,
                "housekeeping: audit_logs prune hit per-pass deletion limit; remaining rows deferred to next pass"
            );
            break;
        }
        tokio::time::sleep(PRUNE_COOPERATIVE_DELAY).await;
    }
    tracing::debug!(rows = total_rows, "housekeeping: pruned audit_logs");
    Ok(())
}
