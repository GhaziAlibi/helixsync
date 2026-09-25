// `/stats`: per-account item counts for the dashboard.
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::extractors::AnyAuthenticatedUser;
use crate::error::AppResult;
use crate::middleware::rate_limit::{enforce, SYNC_STATS_LIMIT};
use crate::state::AppState;

use super::model::SnapshotObject;
use super::snapshot::{compute_objects, history_retention_cutoff, load_active_tombstones};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SyncStats {
    bookmarks: i64,
    history_visits: i64,
    tabs: i64,
}

/// Truncates a timestamp down to its containing UTC hour — the Rust
/// equivalent of `date_trunc('hour', ...)`, used only where an hour has to
/// be computed from an already-fetched `created_at` (the seeding paths
/// below) rather than inside a query.
fn truncate_to_hour(dt: DateTime<Utc>) -> DateTime<Utc> {
    let secs = dt.timestamp();
    let truncated = secs - secs.rem_euclid(3600);
    DateTime::<Utc>::from_timestamp(truncated, 0).expect("truncated unix seconds is always valid")
}

/// One-time catch-up seeding `history_visit_hours` (docs/protocol.md
/// §8.3.2, migration `0018_history_visit_hours.sql`) from an account's
/// currently-live `historyVisit` objects — used by both `None`/no-`sync_
/// stats`-row branches of `stats` below (an account that predates the
/// table's existence). Buckets by `created_at` since real visit time was
/// never recorded for objects written before `visitHours` existed; merges
/// into whatever's already there via the same `+= EXCLUDED.visits` upsert
/// `process_batch`'s write path uses.
///
/// `only_before`, when given, restricts seeding to objects whose
/// `created_at` is strictly before it — the legacy-`sync_stats`-row path,
/// so a row `process_batch` already wrote into `history_visit_hours` after
/// migration 0018 for this same account (`created_at >= only_before`) is
/// never re-added on top of itself. `None` seeds every object
/// unconditionally — the brand-new "no `sync_stats` row at all" path, which
/// the caller pairs with deleting this account's existing
/// `history_visit_hours` rows first (in the same transaction) precisely
/// because it can't otherwise tell whether anything is already there; the
/// merge below is still `+= EXCLUDED.visits`, same as `process_batch`'s
/// write path, for the `only_before` case where merging with genuinely
/// pre-existing rows is exactly the point.
async fn seed_history_visit_hours(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    objects_map: &HashMap<(String, Uuid), SnapshotObject>,
    only_before: Option<DateTime<Utc>>,
) -> AppResult<()> {
    let mut buckets: HashMap<DateTime<Utc>, i64> = HashMap::new();
    for ((object_type, _), obj) in objects_map.iter() {
        if object_type != "historyVisit" {
            continue;
        }
        if let Some(before) = only_before {
            if obj.created_at >= before {
                continue;
            }
        }
        let hour = truncate_to_hour(obj.created_at);
        *buckets.entry(hour).or_insert(0) += obj.visit_count.unwrap_or(1);
    }
    if buckets.is_empty() {
        return Ok(());
    }
    let (hours, counts): (Vec<DateTime<Utc>>, Vec<i64>) = buckets.into_iter().unzip();
    sqlx::query!(
        r#"
        INSERT INTO history_visit_hours (user_id, hour, visits)
        SELECT $1, u.hour, u.visits FROM UNNEST($2::timestamptz[], $3::bigint[]) AS u(hour, visits)
        ON CONFLICT (user_id, hour) DO UPDATE SET visits = history_visit_hours.visits + EXCLUDED.visits
        "#,
        user_id,
        &hours,
        &counts
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Sums `history_visit_hours` buckets at or after `cutoff`'s hour (`None` —
/// unlimited retention or no settings row, matching
/// `history_retention_cutoff`'s own convention — sums every bucket). This
/// (not `sync_stats.history_visit_count`) is what `stats` below returns as
/// `historyVisits` — see docs/protocol.md §8.3.2 for why: it follows real
/// visit time, not upload time, and survives its originating operation
/// being compacted away. Read-only, no lock needed. Bucket precision is one
/// hour, so a visit right at the edge of the retention window may count for
/// up to an hour longer or shorter than the exact cutoff.
async fn history_visit_hours_sum<'e, E>(
    executor: E,
    user_id: Uuid,
    cutoff: Option<DateTime<Utc>>,
) -> AppResult<i64>
where
    E: sqlx::PgExecutor<'e>,
{
    // Cast to bigint explicitly: Postgres's `SUM(bigint)` widens to NUMERIC
    // by default (overflow safety for a plain aggregate), which sqlx can
    // only decode with the `bigdecimal` feature enabled — casting here keeps
    // the column type sqlx already expects everywhere else `visits`/BIGINT
    // counters are summed in this codebase.
    let sum: Option<i64> = sqlx::query_scalar!(
        r#"
        SELECT SUM(visits)::bigint FROM history_visit_hours
        WHERE user_id = $1 AND ($2::timestamptz IS NULL OR hour >= date_trunc('hour', $2::timestamptz))
        "#,
        user_id,
        cutoff
    )
    .fetch_one(executor)
    .await?;
    Ok(sum.unwrap_or(0))
}

/// `history_visit_hours_sum` over the account's current retention window
/// (`history_retention_cutoff`). What `stats` returns as `historyVisits`.
async fn history_visits_in_retention(db: &PgPool, user_id: Uuid) -> AppResult<i64> {
    let history_cutoff = history_retention_cutoff(db, user_id).await?;
    history_visit_hours_sum(db, user_id, history_cutoff).await
}

/// Takes the per-user tag-1 advisory lock that serializes every
/// `sync_stats` / `history_visit_hours` writer: upload (`process_batch`),
/// compaction's recount, and `stats`' seeding. Held until `tx` ends.
pub(super) async fn lock_user_stats(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
) -> AppResult<()> {
    sqlx::query!(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 1))",
        user_id.to_string()
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

// Short cache so repeated dashboard polls hit the DB once. Keyed by user and
// never swept; its size is bounded by user count.
static STATS_CACHE: LazyLock<DashMap<Uuid, (Instant, SyncStats)>> = LazyLock::new(DashMap::new);
const STATS_CACHE_TTL: Duration = Duration::from_secs(30);

/// Item counts for the dashboard, read from `sync_stats`
/// (migrations/0007_sync_stats.sql) instead of rebuilding every object.
///
/// `process_batch` updates the counts and compaction recounts them. If
/// neither has run yet for this user, compute them once and save the row.
pub(super) async fn stats(
    user: AnyAuthenticatedUser,
    State(state): State<AppState>,
) -> AppResult<Json<SyncStats>> {
    if let Some(cached) = STATS_CACHE.get(&user.user_id) {
        if cached.0.elapsed() < STATS_CACHE_TTL {
            return Ok(Json(cached.1.clone()));
        }
    }

    enforce(&state.rate_limiter, SYNC_STATS_LIMIT, &user.rate_limit_key)?;

    let row = sqlx::query!(
        "SELECT bookmark_count, tab_count, history_hours_seed_before FROM sync_stats WHERE user_id = $1",
        user.user_id
    )
    .fetch_optional(&state.db)
    .await?;

    let stats = match row {
        Some(r) if r.history_hours_seed_before.is_none() => {
            // Fast path (docs/protocol.md §8.3.2): bookmark/tab counts still
            // come straight from `sync_stats`, but history now comes from
            // `history_visit_hours` — see `history_visit_hours_sum`'s doc
            // comment for why. No lock needed, same as the old fast path
            // this replaces: it's a plain read.
            let history_visits = history_visits_in_retention(&state.db, user.user_id).await?;
            SyncStats {
                bookmarks: r.bookmark_count,
                history_visits,
                tabs: r.tab_count,
            }
        }
        Some(r) => {
            // Legacy seed pending: `history_hours_seed_before` is set, so
            // this account's `sync_stats` row predates migration 0018 (every
            // row that existed at migration time was stamped with the
            // migration's own `now()`). Seed `history_visit_hours` once from
            // this account's currently-live `historyVisit` objects, then
            // clear the marker so every later call takes the fast path
            // above. Same tag-1 advisory lock as `process_batch`'s
            // incremental upsert and the `None` branch below, held for the
            // whole seed-and-clear transaction.
            let mut tx = state.db.begin().await?;
            lock_user_stats(&mut tx, user.user_id).await?;

            // Re-read under the lock: a concurrent request could have
            // already completed the seed (and cleared the marker) while
            // this one was waiting for the lock.
            let seed_before: Option<DateTime<Utc>> = sqlx::query_scalar!(
                "SELECT history_hours_seed_before FROM sync_stats WHERE user_id = $1",
                user.user_id
            )
            .fetch_one(&mut *tx)
            .await?;

            if let Some(seed_before) = seed_before {
                // Unfiltered (`None` history_cutoff): seeding is a one-time
                // catch-up from whatever hasn't already been compacted away,
                // not a retention decision — `history_visit_hours_sum` below
                // applies the account's actual retention cutoff at read
                // time, so an over-inclusive seed here is harmless (and
                // exactly bounded by `only_before` from ever double-counting
                // what `process_batch` already wrote post-migration).
                let (_, objects_map) = compute_objects(&mut tx, user.user_id, None, None).await?;
                seed_history_visit_hours(&mut tx, user.user_id, &objects_map, Some(seed_before))
                    .await?;
                sqlx::query!(
                    "UPDATE sync_stats SET history_hours_seed_before = NULL WHERE user_id = $1",
                    user.user_id
                )
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;

            let history_visits = history_visits_in_retention(&state.db, user.user_id).await?;
            SyncStats {
                bookmarks: r.bookmark_count,
                history_visits,
                tabs: r.tab_count,
            }
        }
        None => {
            // First-time backfill. Take the tag-1 stats lock first so no
            // upload can change things mid-count.
            //
            // Always overwrite the row (like compaction does), since another
            // request or an upload may have written a partial value already.
            let mut tx = state.db.begin().await?;
            lock_user_stats(&mut tx, user.user_id).await?;

            // Unfiltered (`None` history_cutoff), unlike the pre-Change-3
            // version of this branch: `stats.history_visits` computed below
            // now only feeds the legacy `sync_stats.history_visit_count`
            // column (kept but no longer read — see process_batch's comment
            // on that column), and `seed_history_visit_hours` below needs
            // every live object regardless of retention (the actual
            // retention filter is applied at read time, by
            // `history_visit_hours_sum`, not at seed time). Bookmark/tab
            // counts are unaffected either way — `history_cutoff` only ever
            // filters `historyVisit` rows (see `compute_objects`'s doc
            // comment).
            let (_, objects_map) = compute_objects(&mut tx, user.user_id, None, None).await?;

            let tombstones = load_active_tombstones(&mut *tx, user.user_id).await?;

            let mut stats = SyncStats {
                bookmarks: 0,
                history_visits: 0,
                tabs: 0,
            };
            // Count visits for bulk history objects (old objects count 1).
            // A tombstone only hides an object if its key is newer
            // (same rule as `filter_tombstoned`).
            for ((object_type, object_id), obj) in objects_map.iter() {
                if let Some(tombstone_key) = tombstones.get(&(object_type.clone(), *object_id)) {
                    if *tombstone_key >= obj.ordering_key() {
                        continue;
                    }
                }
                match object_type.as_str() {
                    "bookmark" | "bookmarkFolder" => stats.bookmarks += 1,
                    "historyVisit" => {
                        stats.history_visits += obj.visit_count.unwrap_or(1);
                    }
                    "tab" => stats.tabs += 1,
                    _ => {}
                }
            }

            sqlx::query!(
                r#"
                INSERT INTO sync_stats (user_id, bookmark_count, history_visit_count, tab_count)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (user_id) DO UPDATE SET
                    bookmark_count = EXCLUDED.bookmark_count,
                    history_visit_count = EXCLUDED.history_visit_count,
                    tab_count = EXCLUDED.tab_count,
                    updated_at = now()
                "#,
                user.user_id,
                stats.bookmarks,
                stats.history_visits,
                stats.tabs
            )
            .execute(&mut *tx)
            .await?;

            // Change 3: seed `history_visit_hours` from every live
            // historyVisit object this account has. Authoritative, like the
            // `sync_stats` overwrite just above — not a merge: normally no
            // `sync_stats` row also means nothing has ever been written to
            // `history_visit_hours` for this account (in production, any
            // accepted historyVisit op that writes a bucket also always
            // creates a `sync_stats` row in the same transaction — see
            // `process_batch`), but this branch is reached for a `sync_stats`
            // row that's missing for *any* reason (a lost/corrupted row,
            // manual intervention, a restored-from-backup database), and
            // must produce the right answer regardless of what — if
            // anything — is already sitting in `history_visit_hours`.
            // Deleting first, then seeding fresh from the current live
            // object set (`only_before: None` — seed everything), is what
            // makes this idempotent no matter how many times it runs.
            sqlx::query!(
                "DELETE FROM history_visit_hours WHERE user_id = $1",
                user.user_id
            )
            .execute(&mut *tx)
            .await?;
            seed_history_visit_hours(&mut tx, user.user_id, &objects_map, None).await?;

            tx.commit().await?;

            let history_visits = history_visits_in_retention(&state.db, user.user_id).await?;
            SyncStats {
                bookmarks: stats.bookmarks,
                history_visits,
                tabs: stats.tabs,
            }
        }
    };

    STATS_CACHE.insert(user.user_id, (Instant::now(), stats.clone()));

    Ok(Json(stats))
}
