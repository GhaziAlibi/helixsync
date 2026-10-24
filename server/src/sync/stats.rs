// `/stats`: per-account item counts for the dashboard.
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

use super::snapshot::history_retention_cutoff;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SyncStats {
    bookmarks: i64,
    history_visits: i64,
    tabs: i64,
    /// Bytes of `sync_operations.payload` currently on disk for this
    /// account (F-04). See `Config::max_account_storage_bytes`.
    storage_bytes: i64,
    /// The account's storage cap, so the dashboard can render usage
    /// relative to it without hardcoding the default.
    storage_limit_bytes: i64,
}

/// Sums `history_visit_hours` buckets at or after `cutoff`'s hour (`None` —
/// unlimited retention or no settings row, matching
/// `history_retention_cutoff`'s own convention — sums every bucket). This
/// is what `stats` below returns as `historyVisits` — see docs/protocol.md §8.3.2 for why: it follows real
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
/// `sync_stats` / `history_visit_hours` writer: upload (`process_batch`)
/// and compaction's recount. Held until `tx` ends.
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
/// (the `sync_stats` table in migrations/0001_init.sql) instead of rebuilding every object.
///
/// `process_batch` updates the counts and compaction recounts them.
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
        "SELECT bookmark_count, tab_count, storage_bytes FROM sync_stats WHERE user_id = $1",
        user.user_id
    )
    .fetch_optional(&state.db)
    .await?;

    let storage_limit_bytes = state.config.max_account_storage_bytes;

    // No `sync_stats` row means no upload has ever changed a count or charged
    // storage for this account, so everything is zero.
    let (bookmarks, tabs, storage_bytes) = match row {
        Some(r) => (r.bookmark_count, r.tab_count, r.storage_bytes),
        None => (0, 0, 0),
    };
    let history_visits = history_visits_in_retention(&state.db, user.user_id).await?;
    let stats = SyncStats {
        bookmarks,
        history_visits,
        tabs,
        storage_bytes,
        storage_limit_bytes,
    };

    STATS_CACHE.insert(user.user_id, (Instant::now(), stats.clone()));

    Ok(Json(stats))
}
