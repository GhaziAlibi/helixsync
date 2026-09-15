// Background compaction of the operation log per docs/protocol.md §11:
// once every active (non-revoked) device has acknowledged a
// cursor past an operation, and a snapshot exists covering its effect, the
// raw row is no longer needed for incremental resync. A device that
// reconnects after its cursor falls behind the compacted boundary is
// signaled `cursor_too_old` by `sync::routes::download` (unchanged by this
// module) and falls back to snapshot resync via `sync::routes::snapshot`,
// which is why the snapshot generated here (via `compute_objects`) must
// always be *durably committed* before the rows it covers are deleted
// (SRV-2: not necessarily in the same transaction — see `compact_user` /
// `prune_compacted_operations` below. The invariant that actually matters is
// commit-order, not statement-grouping: as long as the snapshot's INSERT has
// committed before a covered row's DELETE commits, a crash or interleaving
// at any point leaves either "old row still present, no newer snapshot yet"
// or "row gone, but a snapshot already covers it" — both safe. What would be
// unsafe is a covered row's DELETE committing before the snapshot that
// covers it, which can't happen here because the delete phase only ever
// targets `server_cursor <= ack_boundary` for an `ack_boundary` whose
// snapshot has already committed by the time the delete phase starts).
use std::collections::HashSet;
use std::time::Duration;

use chrono::Utc;
use futures::StreamExt;
use sqlx::Acquire;
use uuid::Uuid;

use crate::error::AppResult;
use crate::state::AppState;

use super::routes::{
    compress_snapshot_data, compute_objects, filter_tombstoned, history_retention_cutoff,
};
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
// most of the connection pool (sized by `database_max_connections`, see
// `database::connect`) idle for the length of an hourly compaction pass
// while ordinary request traffic competed for the one connection actually
// in use. 8 fixed that but overshot: 8 concurrent compaction transactions
// could tie up a large share of the pool at once, starving ordinary request
// traffic during the pass (SRV-3). 3 is the middle ground — still enough to
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
    //
    // `AND COALESCE(d.last_seen_at, d.created_at) > $2` additionally drops a
    // device from the boundary computation once it's been inactive longer
    // than `inactive_device_compaction_grace_period_secs` (SRV-PERF-1):
    // without this, a device the user simply abandoned (old phone,
    // uninstalled extension, a work browser never explicitly revoked from
    // the dashboard) permanently pins the boundary at whatever it last
    // acknowledged — or at 0, if it never synced at all — and
    // `sync_operations` grows unboundedly forever. `last_seen_at` is only
    // ever set by `touch_last_seen`/`touch_last_seen_background`
    // (`devices::routes`), which run exclusively from authenticated sync
    // requests, so it's NULL both for a device that's never made a single
    // request since registration *and* for one that just registered a
    // moment ago — `COALESCE(last_seen_at, created_at)` is required (rather
    // than `last_seen_at` alone) so the freshly-registered case ages from
    // its `created_at` instead of being immediately treated as infinitely
    // stale; a device that synced once and then went dark still ages
    // correctly off its real `last_seen_at`.
    let inactive_device_cutoff =
        Utc::now() - chrono::Duration::seconds(state.config.inactive_device_compaction_grace_period_secs);

    let ack_boundary: Option<i64> = sqlx::query_scalar!(
        r#"
        SELECT MIN(COALESCE(sc.cursor_value, 0))
        FROM devices d
        LEFT JOIN sync_cursors sc ON sc.user_id = d.user_id AND sc.device_id = d.id
        WHERE d.user_id = $1 AND d.revoked_at IS NULL
          AND COALESCE(d.last_seen_at, d.created_at) > $2
        "#,
        user_id,
        inactive_device_cutoff
    )
    .fetch_one(&mut *tx)
    .await?;

    let max_op_cursor: i64 = sqlx::query_scalar!(
        r#"SELECT COALESCE(MAX(server_cursor), 0) as "c!" FROM sync_operations WHERE user_id = $1"#,
        user_id
    )
    .fetch_one(&mut *tx)
    .await?;

    // No rows matched the query above: either this user has no active
    // devices at all, or every active device is now past the staleness
    // cutoff. Either way, nothing left that could still incrementally sync
    // needs the raw log, so it's safe to compact everything that exists so
    // far — same fallback as before this device-staleness exclusion was
    // added, just covering one more reason the device set can come up empty.
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
        let data = compress_snapshot_data(&objects)?;

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
    // again. Still grouped into this same transaction as the snapshot
    // INSERT/`sync_stats` upsert above: it's a single bounded DELETE against
    // a small table (at most a handful of rows per user), not the
    // potentially-huge, potentially-slow sweep below, so it doesn't
    // contribute meaningfully to how long the `sync_stats` row lock is held.
    sqlx::query!(
        "DELETE FROM sync_snapshots WHERE user_id = $1 AND snapshot_cursor < $2",
        user_id,
        ack_boundary
    )
    .execute(&mut *tx)
    .await?;

    // Commit here — deliberately *before* pruning `sync_operations` below
    // (SRV-2). Postgres holds a row lock from the statement that acquires it
    // until COMMIT/ROLLBACK of that same transaction, no matter how early or
    // late in the transaction the statement runs — so merely moving the
    // `sync_stats` upsert to a later position in one long transaction would
    // NOT shrink how long it holds that lock; the lock would still be held
    // until this transaction's eventual commit, i.e. for the full duration
    // of the chunked delete loop either way. The only way to actually bound
    // the hold time is to commit the transaction that touches `sync_stats`
    // before starting the slow part, which is what this does: by the time
    // `prune_compacted_operations` runs, this transaction (and its
    // `sync_stats` row lock) is already gone, so a concurrent
    // `POST /sync/upload` upserting the same row never blocks on it.
    tx.commit().await?;

    // Deletes the now-redundant `sync_operations` rows covered by the
    // snapshot just committed above, in their own short-lived transactions
    // — never in the same transaction as the `sync_stats` upsert (see the
    // module doc comment and the commit above for why). Safe to run after
    // the snapshot's commit specifically because `ack_boundary` is fixed at
    // this point and every row this deletes satisfies `server_cursor <=
    // ack_boundary`, i.e. is already represented in the snapshot that's now
    // durable. If this process crashes partway through, whatever chunks
    // haven't run yet simply remain in `sync_operations` — safe, and picked
    // up by the next compaction pass (its `terminal_candidates` query below
    // is re-derived from current data each run, not from any state carried
    // over from this one).
    prune_compacted_operations(state, user_id, ack_boundary).await?;

    Ok(())
}

/// Deletes `sync_operations` rows already covered by the snapshot at
/// `ack_boundary` (which must already be durably committed by the caller —
/// see `compact_user`). Runs as a series of separate, short-lived
/// transactions rather than one, so no single transaction here ever holds
/// locks for longer than one chunk's delete, and none of them touch
/// `sync_stats` at all.
async fn prune_compacted_operations(state: &AppState, user_id: Uuid, ack_boundary: i64) -> AppResult<()> {
    // docs/protocol.md §9/§11: tombstone-creating operations additionally
    // wait out the configured retention window before their raw log row is
    // deleted. The tombstone's effect (`tombstones.active`, and the
    // already-committed snapshot's exclusion of the object) is independently
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
    // DELETE then excludes just that small survivor set. Read directly off
    // the pool (no transaction): this is a plain point-in-time SELECT, and
    // `ack_boundary` is already fixed by the caller, so there's nothing here
    // that needs snapshot isolation with the deletes below. This query is
    // backed by the `idx_sync_operations_terminal` partial index to avoid
    // scanning and filtering every operation below the boundary.
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

    // Chunked rather than one statement: an unchunked DELETE here can match
    // tens of thousands of rows — not on an ordinary hourly pass (gated well
    // below this scale by `MIN_NEW_OPERATIONS_TO_COMPACT` above), but on a
    // first-ever compaction against a large pre-existing backlog, or an
    // account that went uncompacted for a long time. Holding row locks and
    // spiking WAL for the full duration of one giant statement is avoidable
    // by looping a bounded DELETE instead. Each chunk now additionally gets
    // its own transaction (SRV-2): the snapshot-before-delete invariant this
    // module is built around (see the module doc comment) only requires
    // each delete to commit *after* the snapshot covering it already has —
    // never that every chunk share one transaction with each other, let
    // alone with the snapshot write. Splitting them means a concurrent
    // `sync_stats` upsert from an upload never waits on this loop at all
    // (it's a separate table, untouched here), and a slow account's sweep
    // never holds any single set of locks for longer than one 5,000-row
    // chunk.
    //
    // The inner subquery orders by `server_cursor` before `LIMIT`: this is
    // purely a query-plan concern, orthogonal to the termination argument
    // below. `sync_operations` holds every user's rows, so without an
    // ordering that matches `idx_sync_operations_user_cursor(user_id,
    // server_cursor)`, the planner has no reason to prefer that index over
    // one that satisfies `LIMIT` some other way (e.g. the primary key) and
    // filters the rest in memory — potentially scanning far more of the
    // table than the chunk it actually returns. Ordering by `server_cursor`
    // lets it walk `idx_sync_operations_user_cursor` forward from this
    // user's first matching row and stop as soon as it has `LIMIT` of them.
    // Correctness never depended on the ordering — regardless of *which*
    // eligible rows a pass picks up, `survivor_ids` rows never satisfy the
    // WHERE clause, so they're never selected by any iteration (not merely
    // pushed outside an unlucky LIMIT window) — every row the subquery does
    // return this pass is one this pass actually deletes. That makes the
    // matching set strictly finite and monotonically shrinking, so the loop
    // is guaranteed to terminate once a pass deletes zero rows, regardless
    // of how large `survivor_ids` is or which subset of eligible rows any
    // given chunk happens to pick up.
    //
    // `survivor_ids` is loaded into a temp table once, up front, rather than
    // passed as an `= ANY($n)` array parameter on every loop iteration: for
    // an active account this can hold thousands of ids, and re-sending the
    // whole array plus re-evaluating it against every candidate row on each
    // of potentially many chunks is wasteful compared to an index-backed
    // anti-join against a table Postgres can plan once. A temp table is only
    // usable here because the whole sweep pins one connection out of the
    // pool up front (`state.db.acquire()`) instead of letting each loop
    // iteration's `begin()` pull a (possibly different) pooled connection —
    // temp tables are session-scoped, so a table created on one pooled
    // connection is invisible to another. Each chunk still runs as its own
    // short transaction *on that connection*, preserving the property that
    // matters (no lock outlives one chunk's delete); only the connection
    // checkout itself, not any lock or transaction, spans the whole sweep.
    // The temp table is dropped explicitly before the connection is
    // returned to the pool, since a pooled connection is recycled rather
    // than closed and Postgres would otherwise leave it visible to whatever
    // this connection serves next.
    const DELETE_CHUNK_SIZE: i64 = 5_000;

    let mut conn = state.db.acquire().await?;

    // Plain (non-macro) `sqlx::query` here, not `sqlx::query!`: the latter's
    // compile-time check runs each macro invocation against its own
    // connection, so it can never see a temp table a *previous* macro
    // invocation created — the exact same cross-connection-visibility issue
    // called out above, just at compile time instead of runtime. These
    // three statements are simple enough that losing compile-time column
    // verification isn't a meaningful cost.
    sqlx::query("CREATE TEMPORARY TABLE compaction_survivor_ids (id BIGINT PRIMARY KEY) ON COMMIT PRESERVE ROWS")
        .execute(&mut *conn)
        .await?;

    if !survivor_ids.is_empty() {
        sqlx::query("INSERT INTO compaction_survivor_ids SELECT unnest($1::bigint[])")
            .bind(&survivor_ids)
            .execute(&mut *conn)
            .await?;
    }

    let sweep_result: AppResult<()> = async {
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

            if result.rows_affected() == 0 {
                break;
            }
        }

        Ok(())
    }
    .await;

    // Best-effort: the connection returning to the pool without this table
    // dropped would only cause a (loud, immediate) "already exists" error
    // the next time this same connection runs a prune pass, not silent
    // corruption — but there's no reason to leave it behind when we can
    // clean up now.
    let _ = sqlx::query("DROP TABLE IF EXISTS compaction_survivor_ids")
        .execute(&mut *conn)
        .await;

    sweep_result
}
