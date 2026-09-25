// Background compaction of the operation log (docs/protocol.md §11).
//
// Once every active device has acknowledged past an operation and a
// snapshot covers it, the raw row can be deleted. Devices that fall behind
// get `cursor_too_old` and resync from the snapshot.
//
// Rule: the snapshot must be committed before any row it covers is deleted.
// They don't need to share a transaction; commit order is what matters.
use std::time::Duration;

use chrono::Utc;
use futures::StreamExt;
use sqlx::Acquire;
use uuid::Uuid;

use crate::error::AppResult;
use crate::state::AppState;

use super::snapshot::{
    compress_snapshot_data_async, compute_objects, filter_tombstoned, history_retention_cutoff,
    load_active_tombstones,
};
use super::stats::lock_user_stats;
use super::vocabulary;

/// Starts the background compaction task. Call once from `main.rs`.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(Duration::from_secs(state.config.compaction_interval_secs));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(e) = run_once(&state).await {
                tracing::error!(error = %e, "compaction run failed");
            }
        }
    });
}

// How many users are compacted at once. Enough to use the pool in
// parallel, small enough to leave most connections for normal requests.
const COMPACTION_CONCURRENCY: usize = 3;

/// Runs one compaction pass over all users. Public so tests can call it.
///
/// Users come from `devices`, not `SELECT DISTINCT` on `sync_operations`,
/// which would scan that whole (large) table every pass. Users with no
/// operations exit early in `compact_user`.
pub async fn run_once(state: &AppState) -> AppResult<()> {
    let user_ids: Vec<Uuid> = sqlx::query_scalar!("SELECT DISTINCT user_id FROM devices")
        .fetch_all(&state.db)
        .await?;

    futures::stream::iter(user_ids)
        .for_each_concurrent(COMPACTION_CONCURRENCY, |user_id| async move {
            if let Err(e) = compact_user(state, user_id).await {
                tracing::error!(error = %e, %user_id, "compaction failed for user");
            }
        })
        .await;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct CompactionCandidate {
    id: i64,
    object_type: String,
    operation_type: String,
    created_at: chrono::DateTime<Utc>,
}

async fn compact_user(state: &AppState, user_id: Uuid) -> AppResult<()> {
    let mut tx = state.db.begin().await?;

    // The boundary is the lowest cursor acknowledged by the user's active
    // devices (docs/protocol.md §11(1)).
    //
    // - `COALESCE` per row (not around `MIN`) so a device that never called
    //   `/changes` counts as 0 instead of being ignored.
    // - Joining on `user_id` too lets Postgres use the
    //   `(user_id, device_id)` index.
    // - Devices inactive past `inactive_device_compaction_grace_period_secs`
    //   are skipped, so an abandoned device can't block compaction forever.
    //   New devices age from `created_at`.
    // - Devices that never called `/changes` are skipped after the shorter
    //   `never_synced_device_compaction_grace_period_secs`, since uploads
    //   alone keep them looking active.
    let inactive_device_cutoff = Utc::now()
        - chrono::Duration::seconds(state.config.inactive_device_compaction_grace_period_secs);
    let never_synced_device_cutoff = Utc::now()
        - chrono::Duration::seconds(
            state
                .config
                .never_synced_device_compaction_grace_period_secs,
        );

    let ack_boundary: Option<i64> = sqlx::query_scalar!(
        r#"
        SELECT MIN(COALESCE(sc.cursor_value, 0))
        FROM devices d
        LEFT JOIN sync_cursors sc ON sc.user_id = d.user_id AND sc.device_id = d.id
        WHERE d.user_id = $1 AND d.revoked_at IS NULL
          AND COALESCE(d.last_seen_at, d.created_at) > $2
          AND (sc.cursor_value IS NOT NULL OR d.created_at > $3)
        "#,
        user_id,
        inactive_device_cutoff,
        never_synced_device_cutoff
    )
    .fetch_one(&mut *tx)
    .await?;

    let max_op_cursor: i64 = sqlx::query_scalar!(
        r#"SELECT COALESCE(MAX(server_cursor), 0) as "c!" FROM sync_operations WHERE user_id = $1"#,
        user_id
    )
    .fetch_one(&mut *tx)
    .await?;

    // No active devices left, so nothing still needs the raw log.
    // Compact everything.
    let ack_boundary = ack_boundary.unwrap_or(max_op_cursor);

    // Never trust a boundary above the highest real cursor.
    let ack_boundary = ack_boundary.min(max_op_cursor);

    if ack_boundary <= 0 {
        return Ok(()); // nothing universally acknowledged yet
    }

    // Skip rebuilding the snapshot when too few new ops arrived; rebuilding
    // means parsing and rewriting the whole snapshot. Deferring is always
    // safe. A user with no snapshot yet always gets one.
    //
    // Only the rebuild is skipped, never the prune below. Otherwise a quiet
    // account could leave a backlog stuck forever.
    const MIN_NEW_OPERATIONS_TO_COMPACT: i64 = 200;

    let latest_snapshot_cursor: i64 = sqlx::query_scalar!(
        r#"SELECT COALESCE(MAX(snapshot_cursor), 0) as "c!" FROM sync_snapshots WHERE user_id = $1"#,
        user_id
    )
    .fetch_one(&mut *tx)
    .await?;

    if latest_snapshot_cursor > 0
        && ack_boundary - latest_snapshot_cursor < MIN_NEW_OPERATIONS_TO_COMPACT
    {
        // Only reads so far; nothing to commit.
        tx.rollback().await?;
        // Prune up to the existing snapshot, which is already durable.
        // This lets leftover backlog drain on quiet accounts.
        prune_compacted_operations(state, user_id, latest_snapshot_cursor).await?;
        return Ok(());
    }

    // A snapshot must cover the boundary before anything is deleted
    // (docs/protocol.md §11(2)). Reuse one from an earlier run if it exists.
    let existing: Option<i64> = sqlx::query_scalar!(
        "SELECT snapshot_cursor FROM sync_snapshots WHERE user_id = $1 AND snapshot_cursor = $2",
        user_id,
        ack_boundary
    )
    .fetch_optional(&mut *tx)
    .await?;

    if existing.is_none() {
        // Old historyVisits are left out of the snapshot here, which is how
        // history retention is applied. Their raw rows get pruned below.
        let history_cutoff = history_retention_cutoff(&mut *tx, user_id).await?;
        let (_, objects_map) =
            compute_objects(&mut tx, user_id, Some(ack_boundary), history_cutoff).await?;

        let tombstones = load_active_tombstones(&mut *tx, user_id).await?;

        let objects = filter_tombstoned(objects_map, &tombstones);

        // Self-heal for bulk history chunks compacted *before*
        // `sync::routes::process_batch`'s permanent-dedup fix was deployed
        // (see the `known_bulk` lookup there): such a chunk's ledger row was
        // never written, and once its `sync_operations` row was deleted by
        // the prune below, the ledger can't be backfilled from SQL alone —
        // its only remaining copy is inside this compressed snapshot blob.
        // So instead: every time an object set is folded into a snapshot
        // here, insert a ledger row for every bulk history object it
        // contains, `ON CONFLICT DO NOTHING` (cheap once already healed).
        // Must run in the same transaction, before `tx.commit()` and before
        // `prune_compacted_operations` below — from the next compaction run
        // on, a bulk object can then never lose both its `sync_operations`
        // row and its ledger row at the same time, closing the gap this
        // fixes. Migration `0017_bulk_import_ledger.sql` does the equivalent
        // backfill for rows that still exist in `sync_operations` right now;
        // this covers the rest, one compaction at a time.
        let bulk_ids: Vec<Uuid> = objects
            .iter()
            .filter(|o| o.object_type == "historyVisit" && o.operation_type == "bulkImport")
            .map(|o| o.object_id)
            .collect();
        if !bulk_ids.is_empty() {
            sqlx::query!(
                r#"
                INSERT INTO sync_objects (user_id, object_type, object_id)
                SELECT $1, 'historyVisit', u.object_id
                FROM UNNEST($2::uuid[]) AS u(object_id)
                ON CONFLICT DO NOTHING
                "#,
                user_id,
                &bulk_ids
            )
            .execute(&mut *tx)
            .await?;
        }

        let data = compress_snapshot_data_async(objects).await?;

        sqlx::query!(
            "INSERT INTO sync_snapshots (user_id, snapshot_cursor, encryption_version, data) VALUES ($1, $2, 0, $3)",
            user_id,
            ack_boundary,
            data
        )
        .execute(&mut *tx)
        .await?;

        // Recount `sync_stats` from scratch (see migrations/0007_sync_stats.sql).
        //
        // Objects and tombstones are both read "as of now", so they match.
        // This is usually cheap since `compute_objects` starts from the
        // snapshot just written.
        //
        // Takes the same tag-1 advisory lock as the upload path, so the two
        // can't overwrite each other's counts.
        lock_user_stats(&mut tx, user_id).await?;

        let (_, stats_objects_map) =
            compute_objects(&mut tx, user_id, None, history_cutoff).await?;

        // Read tombstones again now that we hold the lock.
        let now_tombstones = load_active_tombstones(&mut *tx, user_id).await?;

        let stats_objects = filter_tombstoned(stats_objects_map, &now_tombstones);

        // A full recount, so it can't go negative. `saturating_add` is just
        // a safety net.
        //
        // `history_visit_count` (and this recount) are kept exactly as they
        // were — `sync::stats::stats` no longer reads this column at all
        // (docs/protocol.md §8.3.2): it now sums the dedicated
        // `history_visit_hours` table instead, which buckets by real visit
        // time and survives operations being pruned below, rather than by
        // this snapshot's upload-time-based retention filtering. Left in
        // place rather than removed since it costs nothing to keep populated
        // and other code may still reasonably expect it to be accurate.
        let mut bookmark_count: i64 = 0;
        let mut history_visit_count: i64 = 0;
        let mut tab_count: i64 = 0;
        for obj in &stats_objects {
            match obj.object_type.as_str() {
                "bookmark" | "bookmarkFolder" => bookmark_count += 1,
                // Count visits, not rows. Old objects count as 1.
                "historyVisit" => {
                    history_visit_count =
                        history_visit_count.saturating_add(obj.visit_count.unwrap_or(1));
                }
                "tab" => tab_count += 1,
                _ => {}
            }
        }

        sqlx::query!(
            r#"
            INSERT INTO sync_stats (user_id, bookmark_count, history_visit_count, tab_count, updated_at)
            VALUES ($1, $2, $3, $4, now())
            ON CONFLICT (user_id) DO UPDATE SET
                bookmark_count = EXCLUDED.bookmark_count,
                history_visit_count = EXCLUDED.history_visit_count,
                tab_count = EXCLUDED.tab_count,
                updated_at = now()
            "#,
            user_id,
            bookmark_count,
            history_visit_count,
            tab_count
        )
        .execute(&mut *tx)
        .await?;
    }

    // The new snapshot replaces older ones for this user. Small delete, so
    // it's fine in this transaction.
    sqlx::query!(
        "DELETE FROM sync_snapshots WHERE user_id = $1 AND snapshot_cursor < $2",
        user_id,
        ack_boundary
    )
    .execute(&mut *tx)
    .await?;

    // Commit before pruning. Row locks last until commit, so this frees the
    // `sync_stats` lock before the slow delete loop, and uploads don't wait.
    tx.commit().await?;

    // Delete rows the committed snapshot now covers, in separate short
    // transactions. If we crash midway, the rest is picked up next pass.
    prune_compacted_operations(state, user_id, ack_boundary).await?;

    Ok(())
}

/// Rows per DELETE statement.
pub const DELETE_CHUNK_SIZE: i64 = 5_000;

/// Max rows deleted per user per pass. The rest waits for the next pass.
pub const MAX_PRUNED_PER_PASS: i64 = 50_000;

/// Pause between chunks so other work can get DB connections.
pub const PRUNE_COOPERATIVE_DELAY: Duration = Duration::from_millis(10);

/// Deletes `sync_operations` rows covered by the snapshot at `ack_boundary`.
/// The caller must have committed that snapshot already. Each chunk runs in
/// its own short transaction.
pub async fn prune_compacted_operations(
    state: &AppState,
    user_id: Uuid,
    ack_boundary: i64,
) -> AppResult<()> {
    // Deletes are kept for an extra retention window, for audit only
    // (docs/protocol.md §9, §11).
    let retention_cutoff =
        Utc::now() - chrono::Duration::seconds(state.config.tombstone_retention_secs);

    // Find the terminal ops still inside their retention window; these
    // survive. Only `delete`/`close` rows are fetched (a loose filter);
    // `is_terminal_operation` does the exact check. Uses the
    // `idx_sync_operations_terminal` partial index.
    let terminal_candidates = sqlx::query_as!(
        CompactionCandidate,
        "SELECT id, object_type, operation_type, created_at FROM sync_operations \
         WHERE user_id = $1 AND server_cursor <= $2 AND operation_type IN ('delete', 'close')",
        user_id,
        ack_boundary
    )
    .fetch_all(&state.db)
    .await?;

    let survivor_ids: Vec<i64> = terminal_candidates
        .into_iter()
        .filter(|c| {
            vocabulary::is_terminal_operation(&c.object_type, &c.operation_type)
                && c.created_at > retention_cutoff
        })
        .map(|c| c.id)
        .collect();

    // Delete in chunks, each in its own transaction, so no lock is held for
    // long and uploads never wait on this loop.
    //
    // Ordering by `server_cursor` makes Postgres use the
    // `(user_id, server_cursor)` index. The loop always ends: survivors
    // never match, so every chunk shrinks the set.
    //
    // Survivor ids go into a temp table once, instead of a big array on
    // every chunk. Temp tables are per connection, so we hold one connection
    // for the whole sweep and drop the table at the end.
    //
    // To avoid holding that connection too long:
    // 1. Sleep `PRUNE_COOPERATIVE_DELAY` after each chunk.
    // 2. Stop after `MAX_PRUNED_PER_PASS` rows; the next pass continues.
    let mut conn = state.db.acquire().await?;

    // Plain `sqlx::query`, since the `query!` macro checks on a separate
    // connection and can't see the temp table.
    sqlx::query(
        "CREATE TEMPORARY TABLE IF NOT EXISTS compaction_survivor_ids (id BIGINT PRIMARY KEY) ON COMMIT PRESERVE ROWS",
    )
    .execute(&mut *conn)
    .await?;

    sqlx::query("TRUNCATE compaction_survivor_ids")
        .execute(&mut *conn)
        .await?;

    if !survivor_ids.is_empty() {
        sqlx::query("INSERT INTO compaction_survivor_ids SELECT unnest($1::bigint[])")
            .bind(&survivor_ids)
            .execute(&mut *conn)
            .await?;
    }

    let sweep_result: AppResult<()> = async {
        let mut total_pruned: i64 = 0;

        loop {
            let mut tx = Acquire::begin(&mut conn).await?;

            let result = sqlx::query(
                "DELETE FROM sync_operations WHERE id IN ( \
                    SELECT so.id FROM sync_operations so \
                    WHERE so.user_id = $1 AND so.server_cursor <= $2 \
                      AND NOT EXISTS ( \
                          SELECT 1 FROM compaction_survivor_ids s WHERE s.id = so.id \
                      ) \
                    ORDER BY so.server_cursor ASC \
                    LIMIT $3 \
                 )",
            )
            .bind(user_id)
            .bind(ack_boundary)
            .bind(DELETE_CHUNK_SIZE)
            .execute(&mut *tx)
            .await?;

            tx.commit().await?;

            let rows_affected = result.rows_affected();
            total_pruned += rows_affected as i64;

            if rows_affected < DELETE_CHUNK_SIZE as u64 {
                break;
            }

            if total_pruned >= MAX_PRUNED_PER_PASS {
                tracing::info!(
                    %user_id,
                    total_pruned,
                    max = MAX_PRUNED_PER_PASS,
                    "compaction prune hit per-pass deletion limit; remaining rows deferred to next pass"
                );
                break;
            }

            // Let other tasks get connections.
            tokio::time::sleep(PRUNE_COOPERATIVE_DELAY).await;
        }

        Ok(())
    }
    .await;

    // Best effort; the next run copes if the table is left behind.
    let _ = sqlx::query("DROP TABLE IF EXISTS compaction_survivor_ids")
        .execute(&mut *conn)
        .await;

    sweep_result
}
