// Background compaction of the operation log per docs/protocol.md §11:
// once every active (non-revoked) device has acknowledged a
// cursor past an operation, and a snapshot exists covering its effect, the
// raw row is no longer needed for incremental resync. A device that
// reconnects after its cursor falls behind the compacted boundary is
// signaled `cursor_too_old` by `sync::routes::download` (unchanged by this
// module) and falls back to snapshot resync via `sync::routes::snapshot`,
// which is why the snapshot generated here (via `compute_objects`) must
// always be written *before* the rows it covers are deleted, in the same
// transaction.
use std::collections::HashSet;
use std::time::Duration;

use chrono::Utc;
use futures::StreamExt;
use uuid::Uuid;

use crate::error::AppResult;
use crate::state::AppState;

use super::routes::{compute_objects, filter_tombstoned, history_retention_cutoff};
use super::vocabulary;

/// Spawns the periodic compaction task for the lifetime of the process.
/// Call once from `main.rs` after `AppState` is constructed.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(state.config.compaction_interval_secs));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(e) = run_once(&state).await {
                tracing::error!(error = %e, "compaction run failed");
            }
        }
    });
}

// Compacting one user is mostly waiting on Postgres (several round trips
// per user, one transaction each), so running users one at a time left
// most of the connection pool (`database::connect`'s max_connections=20)
// idle for the length of an hourly compaction pass while ordinary request
// traffic competed for the one connection actually in use. 8 fixed that but
// overshot: with max_connections=20, 8 concurrent compaction transactions
// could tie up 40% of the pool at once, starving ordinary request traffic
// during the pass (SRV-3). 3 is the middle ground — still enough to
// parallelize compaction across users, but even if all 3 slots land on
// unusually large/slow accounts simultaneously, that's a small, bounded
// share of the pool, leaving the large majority of connections free for
// ordinary traffic throughout.
const COMPACTION_CONCURRENCY: usize = 3;

/// Runs one compaction pass over every user that currently has any
/// operations. Exposed separately from `spawn`'s loop so tests (and any
/// future admin/manual trigger) can run a single pass synchronously.
///
/// Sourced from `devices` rather than `SELECT DISTINCT user_id FROM
/// sync_operations`: the latter has no way to skip past user_id groups
/// (Postgres has no automatic loose/skip index scan as of the versions
/// this targets), so it's a full scan of `idx_sync_operations_user_cursor`
/// plus a `HashAggregate` over *every row in the table* — the exact table
/// this whole module exists to keep bounded — run hourly, forever.
/// `devices` has one row per registered device (bounded by how many
/// devices actually exist, never by how many operations they've produced)
/// and is exactly the set `compact_user` itself already needs to compute
/// each user's ack boundary; a user with devices but zero operations just
/// exits `compact_user` at the `ack_boundary <= 0` check below, which is
/// far cheaper than the scan this replaces.
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

    // docs/protocol.md §11(1): the boundary is the minimum cursor
    // acknowledged across this user's active (non-revoked) devices. A LEFT
    // JOIN with a per-row `COALESCE(sc.cursor_value, 0)` (not a
    // `COALESCE` wrapped around the final `MIN`) is required so an active
    // device that has never called `/changes` (no `sync_cursors` row yet)
    // still caps the boundary at 0 — `MIN()` silently ignores NULLs, so
    // without the per-row coalesce such a device would be excluded
    // entirely and its not-yet-synced history could be compacted away
    // before it ever gets a chance to sync.
    //
    // The join predicate also matches `sc.user_id = d.user_id` in addition
    // to `sc.device_id = d.id`: `sync_cursors` rows are always written with
    // `user_id` and `device_id` together for the same device (see
    // `sync::routes`), so this can't exclude any legitimately-matching row —
    // but it does let Postgres use the existing composite index on
    // `sync_cursors(user_id, device_id)` (from its `uq_sync_cursors_user_device`
    // unique constraint) for this join, instead of falling back to a full
    // sequential scan of `sync_cursors` on every user, every compaction pass.
    let ack_boundary: Option<i64> = sqlx::query_scalar!(
        r#"
        SELECT MIN(COALESCE(sc.cursor_value, 0))
        FROM devices d
        LEFT JOIN sync_cursors sc ON sc.user_id = d.user_id AND sc.device_id = d.id
        WHERE d.user_id = $1 AND d.revoked_at IS NULL
        "#,
        user_id
    )
    .fetch_one(&mut *tx)
    .await?;

    let max_op_cursor: i64 = sqlx::query_scalar!(
        r#"SELECT COALESCE(MAX(server_cursor), 0) as "c!" FROM sync_operations WHERE user_id = $1"#,
        user_id
    )
    .fetch_one(&mut *tx)
    .await?;

    // No active devices at all: nothing needs the raw log anymore, so it's
    // safe to compact everything that exists so far.
    let ack_boundary = ack_boundary.unwrap_or(max_op_cursor);

    if ack_boundary <= 0 {
        return Ok(()); // nothing universally acknowledged yet
    }

    // Skip the recompute-and-rewrite below (parses this user's *entire*
    // previous snapshot blob — for an account with a large synced history,
    // effectively their whole historyVisit set — then re-serializes and
    // persists a new one of the same size) when too few new operations
    // have landed since the last persisted snapshot to justify paying that
    // cost again. The only guard previously in place (the exact-cursor
    // match a few lines down) misses as soon as *any* device's ack cursor
    // advances at all, which for an actively-used account is every hourly
    // run — this compacted a hot account's full snapshot every single
    // pass regardless of how little actually changed.
    //
    // Always safe to defer: docs/protocol.md §11's only correctness
    // requirement is that a snapshot exists *before* the rows it covers
    // are deleted, never that compaction runs on any particular cadence —
    // rows below the old snapshot's cursor just remain in `sync_operations`
    // a bit longer than they otherwise would, and the next run naturally
    // has a bigger `ack_boundary` to work with. Exempted when no snapshot
    // exists for this user yet (`latest_snapshot_cursor == 0`) so a
    // consistently-low-activity account still gets its first snapshot
    // rather than never bootstrapping the mechanism at all.
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
        return Ok(());
    }

    // docs/protocol.md §11(2): a snapshot must exist covering the boundary
    // before anything is deleted. Reuse an exact-match row if a previous
    // (possibly interrupted) run already created one for this boundary —
    // makes this function idempotent under retry.
    let existing: Option<i64> = sqlx::query_scalar!(
        "SELECT snapshot_cursor FROM sync_snapshots WHERE user_id = $1 AND snapshot_cursor = $2",
        user_id,
        ack_boundary
    )
    .fetch_optional(&mut *tx)
    .await?;

    if existing.is_none() {
        // docs/protocol.md §11 note above `history_retention_cutoff`: this
        // is what actually converges an account's historyVisit set toward
        // its configured retention window, since it's what
        // `sync::routes::snapshot`/`stats` are themselves reduced from —
        // any historyVisit op excluded here for being past the cutoff
        // never makes it into the persisted snapshot, and its now-orphaned
        // raw row is swept up by the unconditional historyVisit deletion
        // below (never a terminal operation, so always eligible once past
        // `ack_boundary`).
        let history_cutoff = history_retention_cutoff(&mut tx, user_id).await?;
        let (_, objects_map) = compute_objects(&mut tx, user_id, Some(ack_boundary), history_cutoff).await?;

        let tombstone_ids: HashSet<(String, Uuid)> = sqlx::query!(
            "SELECT object_type, object_id FROM tombstones WHERE user_id = $1 AND active = true",
            user_id
        )
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(|r| (r.object_type, r.object_id))
        .collect();

        let objects = filter_tombstoned(objects_map, &tombstone_ids);
        let data = serde_json::to_value(&objects).map_err(anyhow::Error::from)?;

        sqlx::query!(
            "INSERT INTO sync_snapshots (user_id, snapshot_cursor, encryption_version, data) VALUES ($1, $2, 0, $3)",
            user_id,
            ack_boundary,
            data
        )
        .execute(&mut *tx)
        .await?;

        // Authoritative `sync_stats` reconciliation (see
        // migrations/0007_sync_stats.sql for the full three-part design):
        // `objects` above is exactly the live, post-tombstone-filter object
        // set this pass just persisted into the snapshot — counting it here
        // is free (already in memory) and, unlike `sync::routes::
        // process_batch`'s incremental per-batch deltas, authoritative: it
        // *overwrites* rather than adds, so it self-corrects any drift the
        // incremental path might have accumulated, and correctly
        // initializes the row for any account that had operations before
        // this table existed, the first time compaction runs for them
        // post-upgrade. Deliberately scoped to the `existing.is_none()`
        // branch (a snapshot is actually (re)computed this pass) rather
        // than running unconditionally on every `compact_user` call — the
        // early-return paths above (nothing acknowledged yet, or too few
        // new operations since the last snapshot to bother) have no fresh
        // object set to reconcile against.
        let mut bookmark_count: i32 = 0;
        let mut history_visit_count: i32 = 0;
        let mut tab_count: i32 = 0;
        for obj in &objects {
            match obj.object_type.as_str() {
                "bookmark" | "bookmarkFolder" => bookmark_count += 1,
                "historyVisit" => history_visit_count += 1,
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

    // The new snapshot supersedes any older one for this user — nothing
    // below `ack_boundary` will remain in `sync_operations` after this run,
    // so an older, lower-cursor snapshot can never be a useful resync base
    // again.
    sqlx::query!(
        "DELETE FROM sync_snapshots WHERE user_id = $1 AND snapshot_cursor < $2",
        user_id,
        ack_boundary
    )
    .execute(&mut *tx)
    .await?;

    // docs/protocol.md §9/§11: tombstone-creating operations additionally
    // wait out the configured retention window before their raw log row is
    // deleted. The tombstone's effect (`tombstones.active`, and the
    // just-persisted snapshot's exclusion of the object) is independently
    // durable and untouched by this deletion — this is a pure audit-trail
    // safety margin, not a correctness requirement.
    let retention_cutoff = Utc::now() - chrono::Duration::seconds(state.config.tombstone_retention_secs);

    // Every row with `server_cursor <= ack_boundary` is a deletion
    // candidate *except* the rare terminal (tombstone-creating) op still
    // inside its retention window — so rather than pulling every candidate
    // row into Rust to compute that (usually tiny) exception list and then
    // sending it right back out as a huge `id = ANY($1)`, only the rows
    // that could possibly be a terminal op (`operation_type IN ('delete',
    // 'close')`, a deliberately loose superset of `vocabulary::
    // is_terminal_operation` — keeping that function the single source of
    // truth for the actual per-type check below rather than duplicating
    // its match arms in SQL) are ever fetched into the app process. The
    // DELETE then excludes just that small survivor set.
    let terminal_candidates = sqlx::query_as!(
        CompactionCandidate,
        "SELECT id, object_type, operation_type, created_at FROM sync_operations \
         WHERE user_id = $1 AND server_cursor <= $2 AND operation_type IN ('delete', 'close')",
        user_id,
        ack_boundary
    )
    .fetch_all(&mut *tx)
    .await?;

    let survivor_ids: Vec<i64> = terminal_candidates
        .into_iter()
        .filter(|c| {
            vocabulary::is_terminal_operation(&c.object_type, &c.operation_type)
                && c.created_at > retention_cutoff
        })
        .map(|c| c.id)
        .collect();

    sqlx::query!(
        "DELETE FROM sync_operations WHERE user_id = $1 AND server_cursor <= $2 AND NOT (id = ANY($3))",
        user_id,
        ack_boundary,
        &survivor_ids
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}
