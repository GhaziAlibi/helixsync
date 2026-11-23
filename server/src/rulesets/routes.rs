//! Selective-sync rulesets (docs/protocol.md §17).
//!
//! The dashboard creates and edits rulesets and assigns devices to them; a
//! device reads the ones assigned to it and enforces them itself. The server
//! stores each ruleset's encrypted `envelope` and the assignments, and never
//! reads the ciphertext.
use std::collections::{HashMap, HashSet};

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, put};
use axum::{Json, Router};
use uuid::Uuid;

use crate::auth::extractors::{AuthenticatedUser, CsrfProtectedUser};
use crate::auth::model::AuthenticatedDevice;
use crate::error::{AppError, AppResult};
use crate::middleware::rate_limit::{
    enforce, RULESET_DEVICE_READ_LIMIT, RULESET_READ_LIMIT, RULESET_WRITE_LIMIT,
};
use crate::state::AppState;

use super::model::{
    validate_envelope, AssignRequest, AssignResponse, CreateRequest, DeviceRuleset, ListResponse,
    RulesetEntry, RulesetMeta, SelfResponse, UpdateRequest, MAX_ASSIGNED_DEVICES,
    MAX_RULESETS_PER_ACCOUNT,
};

/// Raw body cap: the biggest body is an envelope (64 KB) or a few thousand
/// device ids.
const MAX_BODY_BYTES: usize = 512 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        // Static segment: wins over `/{id}`, so "self" is never a ruleset id.
        .route("/self", get(self_rulesets))
        .route("/{id}", put(update).delete(delete_ruleset))
        .route("/{id}/devices", put(assign_devices))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

/// Creates the account's Default ruleset (empty: no envelope), if it has none.
/// Called at registration, inside the same transaction as the user row.
pub async fn create_default(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
) -> AppResult<()> {
    sqlx::query!(
        "INSERT INTO sync_rulesets (user_id, is_default) VALUES ($1, true)
         ON CONFLICT (user_id) WHERE is_default DO NOTHING",
        user_id
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Assigns a new device to its account's Default ruleset. Called by
/// `devices::routes::insert_device`, so every way a device gets created is
/// covered. Creates the Default first if the account somehow has none.
pub async fn assign_to_default(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    device_id: Uuid,
) -> AppResult<()> {
    create_default(tx, user_id).await?;
    sqlx::query!(
        "INSERT INTO sync_ruleset_assignments (ruleset_id, device_id)
         SELECT id, $2 FROM sync_rulesets WHERE user_id = $1 AND is_default
         ON CONFLICT DO NOTHING",
        user_id,
        device_id
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Drops every assignment of a revoked device. A revoked row is never deleted,
/// so the `ON DELETE CASCADE` doesn't cover it.
pub async fn unassign_device<'e, E>(executor: E, device_id: Uuid) -> AppResult<()>
where
    E: sqlx::PgExecutor<'e>,
{
    sqlx::query!(
        "DELETE FROM sync_ruleset_assignments WHERE device_id = $1",
        device_id
    )
    .execute(executor)
    .await?;
    Ok(())
}

async fn list(
    user: AuthenticatedUser,
    State(state): State<AppState>,
) -> AppResult<Json<ListResponse>> {
    enforce(
        &state.rate_limiter,
        RULESET_READ_LIMIT,
        &format!("user:{}", user.user_id),
    )?;

    let rows = sqlx::query!(
        "SELECT id, revision, is_default, envelope, created_at, updated_at
         FROM sync_rulesets WHERE user_id = $1
         ORDER BY is_default DESC, created_at ASC, id ASC",
        user.user_id
    )
    .fetch_all(&state.db)
    .await?;

    let assignments = sqlx::query!(
        "SELECT a.ruleset_id, a.device_id
         FROM sync_ruleset_assignments a
         JOIN sync_rulesets r ON r.id = a.ruleset_id
         JOIN devices d ON d.id = a.device_id
         WHERE r.user_id = $1 AND d.revoked_at IS NULL
         ORDER BY a.assigned_at ASC, a.device_id ASC",
        user.user_id
    )
    .fetch_all(&state.db)
    .await?;

    let mut by_ruleset: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for a in assignments {
        by_ruleset
            .entry(a.ruleset_id)
            .or_default()
            .push(a.device_id);
    }

    let rulesets = rows
        .into_iter()
        .map(|r| RulesetEntry {
            device_ids: by_ruleset.remove(&r.id).unwrap_or_default(),
            id: r.id,
            revision: r.revision,
            is_default: r.is_default,
            envelope: r.envelope,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
        .collect();
    Ok(Json(ListResponse { rulesets }))
}

async fn create(
    CsrfProtectedUser(user): CsrfProtectedUser,
    State(state): State<AppState>,
    Json(req): Json<CreateRequest>,
) -> AppResult<(StatusCode, Json<RulesetMeta>)> {
    enforce(
        &state.rate_limiter,
        RULESET_WRITE_LIMIT,
        &format!("user:{}", user.user_id),
    )?;
    validate_envelope(&req.envelope)?;

    let mut tx = state.db.begin().await?;
    // Count and insert under a per-user advisory lock (tag 3), so concurrent
    // creates can't exceed the cap.
    sqlx::query!(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 3))",
        user.user_id.to_string()
    )
    .execute(&mut *tx)
    .await?;
    let count = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "count!" FROM sync_rulesets WHERE user_id = $1"#,
        user.user_id
    )
    .fetch_one(&mut *tx)
    .await?;
    if count >= MAX_RULESETS_PER_ACCOUNT {
        return Err(AppError::Conflict("ruleset_limit_reached".into()));
    }

    // Same answer whether the id is taken by this account or another one.
    let inserted = sqlx::query_as!(
        RulesetMeta,
        "INSERT INTO sync_rulesets (id, user_id, envelope) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, revision, is_default, envelope, created_at, updated_at",
        req.id,
        user.user_id,
        req.envelope
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::Conflict("ruleset_exists".into()))?;
    tx.commit().await?;

    crate::audit::log(&state, Some(user.user_id), None, "ruleset_created").await;
    Ok((StatusCode::CREATED, Json(inserted)))
}

/// Parses `If-Match`: the revision the client last saw, bare or quoted.
fn if_match_revision(headers: &HeaderMap) -> AppResult<i64> {
    headers
        .get(axum::http::header::IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().trim_matches('"'))
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or_else(|| AppError::Validation("If-Match revision is required".into()))
}

/// Active devices assigned to `ruleset_id`.
async fn assigned_devices<'e, E>(executor: E, ruleset_id: Uuid) -> AppResult<Vec<Uuid>>
where
    E: sqlx::PgExecutor<'e>,
{
    Ok(sqlx::query_scalar!(
        "SELECT a.device_id FROM sync_ruleset_assignments a
         JOIN devices d ON d.id = a.device_id
         WHERE a.ruleset_id = $1 AND d.revoked_at IS NULL",
        ruleset_id
    )
    .fetch_all(executor)
    .await?)
}

async fn update(
    CsrfProtectedUser(user): CsrfProtectedUser,
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateRequest>,
) -> AppResult<Json<RulesetMeta>> {
    enforce(
        &state.rate_limiter,
        RULESET_WRITE_LIMIT,
        &format!("user:{}", user.user_id),
    )?;
    let expected = if_match_revision(&headers)?;
    validate_envelope(&req.envelope)?;

    // The `revision = $4` guard makes this a compare-and-swap: of two
    // concurrent saves from the same base revision, exactly one wins.
    let updated = sqlx::query_as!(
        RulesetMeta,
        "UPDATE sync_rulesets
         SET envelope = $3, revision = revision + 1, updated_at = now()
         WHERE id = $1 AND user_id = $2 AND revision = $4
         RETURNING id, revision, is_default, envelope, created_at, updated_at",
        id,
        user.user_id,
        req.envelope,
        expected
    )
    .fetch_optional(&state.db)
    .await?;

    let Some(updated) = updated else {
        let exists = sqlx::query_scalar!(
            r#"SELECT EXISTS(SELECT 1 FROM sync_rulesets WHERE id = $1 AND user_id = $2) AS "exists!""#,
            id,
            user.user_id
        )
        .fetch_one(&state.db)
        .await?;
        return Err(if exists {
            AppError::Conflict("revision_conflict".into())
        } else {
            AppError::NotFound
        });
    };

    let devices = assigned_devices(&state.db, id).await?;
    state
        .ws_registry
        .notify_ruleset_changed(user.user_id, &devices);

    crate::audit::log(&state, Some(user.user_id), None, "ruleset_updated").await;
    Ok(Json(updated))
}

async fn delete_ruleset(
    CsrfProtectedUser(user): CsrfProtectedUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    enforce(
        &state.rate_limiter,
        RULESET_WRITE_LIMIT,
        &format!("user:{}", user.user_id),
    )?;

    let mut tx = state.db.begin().await?;
    let is_default = sqlx::query_scalar!(
        "SELECT is_default FROM sync_rulesets WHERE id = $1 AND user_id = $2 FOR UPDATE",
        id,
        user.user_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    if is_default {
        return Err(AppError::Conflict("default_ruleset_protected".into()));
    }

    let devices = assigned_devices(&mut *tx, id).await?;
    sqlx::query!(
        "DELETE FROM sync_rulesets WHERE id = $1 AND user_id = $2",
        id,
        user.user_id
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    state
        .ws_registry
        .notify_ruleset_changed(user.user_id, &devices);
    crate::audit::log(&state, Some(user.user_id), None, "ruleset_deleted").await;
    Ok(StatusCode::NO_CONTENT)
}

/// Replaces a ruleset's device list with exactly `deviceIds`.
async fn assign_devices(
    CsrfProtectedUser(user): CsrfProtectedUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<AssignRequest>,
) -> AppResult<Json<AssignResponse>> {
    enforce(
        &state.rate_limiter,
        RULESET_WRITE_LIMIT,
        &format!("user:{}", user.user_id),
    )?;
    if req.device_ids.len() > MAX_ASSIGNED_DEVICES {
        return Err(AppError::Validation("too many devices".into()));
    }
    let mut seen = HashSet::new();
    let wanted: Vec<Uuid> = req
        .device_ids
        .into_iter()
        .filter(|d| seen.insert(*d))
        .collect();

    let mut tx = state.db.begin().await?;
    sqlx::query_scalar!(
        "SELECT id FROM sync_rulesets WHERE id = $1 AND user_id = $2 FOR UPDATE",
        id,
        user.user_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;

    // Every id must be an active device of this account. Same answer for
    // another account's device and an unknown one.
    let valid = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "count!" FROM devices
           WHERE user_id = $1 AND revoked_at IS NULL AND id = ANY($2)"#,
        user.user_id,
        &wanted
    )
    .fetch_one(&mut *tx)
    .await?;
    if valid != wanted.len() as i64 {
        return Err(AppError::Validation("unknown device".into()));
    }

    let before: HashSet<Uuid> = assigned_devices(&mut *tx, id).await?.into_iter().collect();

    sqlx::query!(
        "DELETE FROM sync_ruleset_assignments
         WHERE ruleset_id = $1 AND device_id <> ALL($2)",
        id,
        &wanted
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "INSERT INTO sync_ruleset_assignments (ruleset_id, device_id)
         SELECT $1, UNNEST($2::uuid[])
         ON CONFLICT DO NOTHING",
        id,
        &wanted
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let after: HashSet<Uuid> = wanted.iter().copied().collect();
    let changed: Vec<Uuid> = before.symmetric_difference(&after).copied().collect();
    if !changed.is_empty() {
        state
            .ws_registry
            .notify_ruleset_changed(user.user_id, &changed);
        crate::audit::log(&state, Some(user.user_id), None, "ruleset_assigned").await;
    }
    Ok(Json(AssignResponse { device_ids: wanted }))
}

/// The rulesets assigned to the calling device. Possibly none.
async fn self_rulesets(
    device: AuthenticatedDevice,
    State(state): State<AppState>,
) -> AppResult<Json<SelfResponse>> {
    enforce(
        &state.rate_limiter,
        RULESET_DEVICE_READ_LIMIT,
        &device.device_id.to_string(),
    )?;
    let rulesets = sqlx::query_as!(
        DeviceRuleset,
        "SELECT r.id, r.revision, r.is_default, r.envelope
         FROM sync_rulesets r
         JOIN sync_ruleset_assignments a ON a.ruleset_id = r.id
         WHERE a.device_id = $1 AND r.user_id = $2
         ORDER BY r.is_default DESC, r.created_at ASC, r.id ASC",
        device.device_id,
        device.user_id
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(SelfResponse { rulesets }))
}
