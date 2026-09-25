// Background cleanup for tables that would otherwise grow forever:
// `device_credentials`, `web_sessions`, `audit_logs`, and tab/window
// `tombstones`. Nothing depends on these rows once they're past retention.
//
// Deletes run in small chunks, oldest first (so the timestamp indexes are
// used), with a short pause between chunks and a cap per pass. This keeps
// locks and WAL spikes small.
use std::future::Future;
use std::time::Duration;

use chrono::Utc;

use crate::error::AppResult;
use crate::state::AppState;

/// Max rows per DELETE statement.
pub const DELETE_CHUNK_SIZE: i64 = 5_000;

/// Max rows deleted per table per pass. The rest waits for the next pass.
pub const MAX_PRUNED_PER_PASS: i64 = 50_000;

/// Pause between chunks so other work can get DB connections.
pub const PRUNE_COOPERATIVE_DELAY: Duration = Duration::from_millis(10);

/// Starts the background housekeeping task. Call once from `main.rs`.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(Duration::from_secs(state.config.housekeeping_interval_secs));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            run_once(&state).await;
        }
    });
}

/// Runs one housekeeping pass. Public so tests can call it directly.
///
/// Each table is cleaned on its own, so one failure doesn't block the rest.
/// Errors are logged, not returned.
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

    if let Err(e) = delete_old_ephemeral_tombstones(state).await {
        tracing::error!(error = %e, "housekeeping: tombstones cleanup failed");
    }

    if let Err(e) = delete_old_history_visit_hours(state).await {
        tracing::error!(error = %e, "housekeeping: history_visit_hours cleanup failed");
    }
}

/// Runs `delete_chunk` repeatedly until a chunk deletes fewer than
/// `DELETE_CHUNK_SIZE` rows or `MAX_PRUNED_PER_PASS` is reached, pausing
/// `PRUNE_COOPERATIVE_DELAY` between chunks. Returns the rows deleted.
/// `table` only names the table in the log line.
async fn delete_in_chunks<F, Fut>(table: &str, mut delete_chunk: F) -> AppResult<u64>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = AppResult<u64>>,
{
    let mut total_rows: u64 = 0;
    loop {
        let rows_affected = delete_chunk().await?;
        total_rows += rows_affected;
        if rows_affected < DELETE_CHUNK_SIZE as u64 {
            break;
        }
        if total_rows >= MAX_PRUNED_PER_PASS as u64 {
            tracing::info!(
                total_pruned = total_rows,
                max = MAX_PRUNED_PER_PASS,
                "housekeeping: {table} prune hit per-pass deletion limit; remaining rows deferred to next pass"
            );
            break;
        }
        tokio::time::sleep(PRUNE_COOPERATIVE_DELAY).await;
    }
    Ok(total_rows)
}

async fn delete_expired_device_credentials(state: &AppState) -> AppResult<()> {
    let cutoff =
        Utc::now() - chrono::Duration::seconds(state.config.device_credential_retention_secs);
    let total_rows = delete_in_chunks("device_credentials", || async move {
        let result = sqlx::query!(
            "DELETE FROM device_credentials WHERE id IN ( \
                SELECT id FROM device_credentials WHERE expires_at < $1 ORDER BY expires_at ASC LIMIT $2 \
             )",
            cutoff,
            DELETE_CHUNK_SIZE
        )
        .execute(&state.db)
        .await?;
        Ok(result.rows_affected())
    })
    .await?;
    tracing::debug!(rows = total_rows, "housekeeping: pruned device_credentials");
    Ok(())
}

// Expired sessions are deleted right away; no grace period needed.
async fn delete_expired_web_sessions(state: &AppState) -> AppResult<()> {
    let now = Utc::now();
    let total_rows = delete_in_chunks("web_sessions", || async move {
        let result = sqlx::query!(
            "DELETE FROM web_sessions WHERE id IN ( \
                SELECT id FROM web_sessions WHERE expires_at < $1 ORDER BY expires_at ASC LIMIT $2 \
             )",
            now,
            DELETE_CHUNK_SIZE
        )
        .execute(&state.db)
        .await?;
        Ok(result.rows_affected())
    })
    .await?;
    tracing::debug!(rows = total_rows, "housekeeping: pruned web_sessions");
    Ok(())
}

async fn delete_old_audit_logs(state: &AppState) -> AppResult<()> {
    let cutoff = Utc::now() - chrono::Duration::seconds(state.config.audit_log_retention_secs);
    let total_rows = delete_in_chunks("audit_logs", || async move {
        let result = sqlx::query!(
            "DELETE FROM audit_logs WHERE id IN ( \
                SELECT id FROM audit_logs WHERE created_at < $1 ORDER BY created_at ASC LIMIT $2 \
             )",
            cutoff,
            DELETE_CHUNK_SIZE
        )
        .execute(&state.db)
        .await?;
        Ok(result.rows_affected())
    })
    .await?;
    tracing::debug!(rows = total_rows, "housekeeping: pruned audit_logs");
    Ok(())
}

// Deletes old `tab` / `window` tombstones. These can't be restored and their
// ids are never reused, so they're safe to drop. Bookmark tombstones are
// never touched: they stay until a `restore`, and `/snapshot` needs them.
//
// The matching `sync_objects` ledger rows are deleted in the same
// transaction. Afterwards, any new op on that tab/window id is rejected as
// `object_not_found`, which is fine since the id is dead. Closed tabs still
// stay out of snapshots (`filter_tombstoned` drops them anyway), and replay
// detection uses `devices.last_device_sequence`, not this table.
async fn delete_old_ephemeral_tombstones(state: &AppState) -> AppResult<()> {
    let cutoff =
        Utc::now() - chrono::Duration::seconds(state.config.ephemeral_tombstone_retention_secs);
    let total_rows = delete_in_chunks("tombstones", || async move {
        let mut tx = state.db.begin().await?;
        let deleted = sqlx::query!(
            "DELETE FROM tombstones WHERE id IN ( \
                SELECT id FROM tombstones \
                WHERE object_type IN ('tab', 'window') AND created_at < $1 \
                ORDER BY created_at ASC LIMIT $2 \
             ) RETURNING user_id, object_type, object_id",
            cutoff,
            DELETE_CHUNK_SIZE
        )
        .fetch_all(&mut *tx)
        .await?;
        let rows_affected = deleted.len() as u64;

        if !deleted.is_empty() {
            let mut user_ids = Vec::with_capacity(deleted.len());
            let mut object_types = Vec::with_capacity(deleted.len());
            let mut object_ids = Vec::with_capacity(deleted.len());
            for row in &deleted {
                user_ids.push(row.user_id);
                object_types.push(row.object_type.clone());
                object_ids.push(row.object_id);
            }
            // Only the ledger rows for the tombstones just deleted.
            sqlx::query!(
                "DELETE FROM sync_objects so \
                 USING UNNEST($1::uuid[], $2::text[], $3::uuid[]) AS u(user_id, object_type, object_id) \
                 WHERE so.user_id = u.user_id AND so.object_type = u.object_type AND so.object_id = u.object_id",
                &user_ids,
                &object_types,
                &object_ids
            )
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;

        Ok(rows_affected)
    })
    .await?;
    tracing::debug!(
        rows = total_rows,
        "housekeeping: pruned ephemeral tombstones and their sync_objects ledger rows"
    );
    Ok(())
}

// `history_visit_hours` (migration `0018_history_visit_hours.sql`,
// docs/protocol.md §8.3.2) buckets visit COUNTS by real visit time,
// independent of `sync_operations`/`sync::compaction`'s upload-time-based
// pruning — so unlike every other table this module prunes, its retention
// cutoff is per-user (each account's own `user_settings.history_retention`),
// not one fixed interval from `Config`. Users with `history_retention`
// `'unlimited'`, an unrecognized value, or no `user_settings` row at all are
// never pruned here (the `IN (...)` list below only ever matches the four
// finite values) — matching `sync::snapshot::history_retention_cutoff`'s own
// "falls open" convention for those same cases.
//
// The extra day of slack mirrors `sync::stats::stats`'s own documented
// imprecision (`history_visit_hours_sum`'s doc comment): bucket granularity
// is one hour, and a dashboard read racing this sweep right at the boundary
// should never see a count dip below what the account's retention window
// actually promises. Pruning a day late costs a handful of extra small rows
// per account, not a correctness problem.
async fn delete_old_history_visit_hours(state: &AppState) -> AppResult<()> {
    let total_rows = delete_in_chunks("history_visit_hours", || async move {
        let result = sqlx::query!(
            r#"
            DELETE FROM history_visit_hours
            WHERE (user_id, hour) IN (
                SELECT hvh.user_id, hvh.hour
                FROM history_visit_hours hvh
                JOIN user_settings us ON us.user_id = hvh.user_id
                WHERE us.history_retention IN ('7d', '30d', '90d', '1y')
                  AND hvh.hour < now() - (
                      CASE us.history_retention
                          WHEN '7d' THEN INTERVAL '7 days'
                          WHEN '30d' THEN INTERVAL '30 days'
                          WHEN '90d' THEN INTERVAL '90 days'
                          WHEN '1y' THEN INTERVAL '365 days'
                      END + INTERVAL '1 day'
                  )
                ORDER BY hvh.hour ASC
                LIMIT $1
            )
            "#,
            DELETE_CHUNK_SIZE
        )
        .execute(&state.db)
        .await?;
        Ok(result.rows_affected())
    })
    .await?;
    tracing::debug!(
        rows = total_rows,
        "housekeeping: pruned history_visit_hours"
    );
    Ok(())
}
