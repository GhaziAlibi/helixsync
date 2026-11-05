use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::value::RawValue;
use tower::limit::ConcurrencyLimitLayer;
use uuid::Uuid;

use crate::auth::extractors::{AnyAuthenticatedUser, AnyAuthorizedMutator};
use crate::auth::model::AuthenticatedDevice;
use crate::error::{AppError, AppResult};
use crate::middleware::rate_limit::{
    enforce, RESTORE_POINT_DOWNLOAD_LIMIT, RESTORE_POINT_READ_LIMIT, RESTORE_POINT_UPLOAD_LIMIT,
    RESTORE_POINT_WRITE_LIMIT,
};
use crate::state::AppState;
use crate::sync::routes::reject_if_protocol_too_old;
use crate::sync::stats::{invalidate_stats_cache, lock_user_stats};

use super::model::{
    AppliedRequest, DownloadResponse, ListResponse, PinRequest, RestorePointMeta, UploadRequest,
    CODEC_DEFLATE_RAW, KINDS, MAX_BOOKMARK_COUNT,
};

/// Slack on top of the per-point cap for the JSON wrapper around the envelope.
const BODY_OVERHEAD_BYTES: usize = 64 * 1024;

/// Max uploads read at once across all users, like `/sync/operations`.
const MAX_CONCURRENT_UPLOADS: usize = 4;

pub fn router(max_point_bytes: i64) -> Router<AppState> {
    let body_limit = usize::try_from(max_point_bytes)
        .unwrap_or(usize::MAX - BODY_OVERHEAD_BYTES)
        .saturating_add(BODY_OVERHEAD_BYTES);
    // Only the upload route gets the large body limit; the rest keep 2MB.
    let upload_route = Router::new()
        .route("/", post(upload))
        .layer(DefaultBodyLimit::max(body_limit))
        // Added last so it runs first, before any body bytes are read.
        .layer(ConcurrencyLimitLayer::new(MAX_CONCURRENT_UPLOADS));

    Router::new()
        .merge(upload_route)
        .route("/", get(list))
        .route(
            "/{id}",
            get(download).patch(set_pinned).delete(delete_point),
        )
        .route("/{id}/applied", post(applied))
}

const META_SELECT: &str = r#"
    SELECT p.id, p.kind, p.bookmark_count, p.encryption_version, p.codec, p.size_bytes,
           p.pinned, p.created_at, p.last_restored_at, p.device_id, d.name AS device_name
    FROM bookmark_restore_points p
    LEFT JOIN devices d ON d.id = p.device_id
"#;

async fn fetch_meta<'e, E>(
    executor: E,
    user_id: Uuid,
    id: Uuid,
) -> AppResult<Option<RestorePointMeta>>
where
    E: sqlx::PgExecutor<'e>,
{
    let sql = format!("{META_SELECT} WHERE p.user_id = $1 AND p.id = $2");
    Ok(sqlx::query_as::<_, RestorePointMeta>(&sql)
        .bind(user_id)
        .bind(id)
        .fetch_optional(executor)
        .await?)
}

async fn upload(
    device: AuthenticatedDevice,
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Json<RestorePointMeta>> {
    reject_if_protocol_too_old(&headers, &state)?;
    enforce(
        &state.rate_limiter,
        RESTORE_POINT_UPLOAD_LIMIT,
        &device.device_id.to_string(),
    )?;

    let req: UploadRequest = serde_json::from_slice(&body)
        .map_err(|e| AppError::Validation(format!("invalid request body: {e}")))?;
    let limits = &state.config.restore_points;

    if !KINDS.contains(&req.kind.as_str()) {
        return Err(AppError::Validation("unknown restore point kind".into()));
    }
    if !(0..=MAX_BOOKMARK_COUNT).contains(&req.bookmark_count) {
        return Err(AppError::Validation("invalid bookmarkCount".into()));
    }
    if req.encryption_version < 0 {
        return Err(AppError::Validation("invalid encryptionVersion".into()));
    }
    if let Some(codec) = &req.codec {
        if codec != CODEC_DEFLATE_RAW {
            return Err(AppError::Validation("unknown codec".into()));
        }
    }
    let envelope_text = req.envelope.get();
    if !envelope_text.starts_with('{') {
        return Err(AppError::Validation("envelope must be an object".into()));
    }
    let size = envelope_text.len() as i64;
    if size > limits.max_bytes {
        return Err(AppError::Validation("restore point too large".into()));
    }

    crate::devices::touch_last_seen_background(&state, device.device_id);

    let mut tx = state.db.begin().await?;
    lock_user_stats(&mut tx, device.user_id).await?;

    // The same id again is the same point (a retried upload).
    if let Some(existing) = fetch_meta(&mut *tx, device.user_id, req.id).await? {
        return Ok(Json(existing));
    }

    let settings = sqlx::query!(
        "SELECT require_encryption, restore_points_automatic FROM user_settings WHERE user_id = $1",
        device.user_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;

    if req.encryption_version == 0
        && (state.config.require_encryption || settings.require_encryption)
    {
        return Err(AppError::Validation("encryption required".into()));
    }
    if req.kind != "manual" && !settings.restore_points_automatic {
        return Err(AppError::Conflict("restore_points_disabled".into()));
    }
    if req.kind == "scheduled" {
        let recent = sqlx::query_scalar!(
            r#"SELECT EXISTS(
                SELECT 1 FROM bookmark_restore_points
                WHERE user_id = $1 AND kind = 'scheduled'
                  AND created_at > now() - make_interval(secs => $2::double precision)
            ) AS "exists!""#,
            device.user_id,
            limits.scheduled_min_interval_secs as f64
        )
        .fetch_one(&mut *tx)
        .await?;
        if recent {
            return Err(AppError::Conflict("restore_point_recent".into()));
        }
    }

    sqlx::query!(
        r#"INSERT INTO bookmark_restore_points
            (id, user_id, device_id, kind, bookmark_count, encryption_version, codec, envelope, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)"#,
        req.id,
        device.user_id,
        device.device_id,
        req.kind,
        req.bookmark_count as i32,
        req.encryption_version,
        req.codec,
        envelope_text.as_bytes(),
        size as i32
    )
    .execute(&mut *tx)
    .await?;

    let mut delta = size;
    // A victim may vanish to a concurrent prune; re-count once before giving up.
    let mut retried = false;
    loop {
        let usage = sqlx::query!(
            r#"SELECT COUNT(*) AS "count!", COALESCE(SUM(size_bytes), 0)::bigint AS "bytes!"
               FROM bookmark_restore_points WHERE user_id = $1"#,
            device.user_id
        )
        .fetch_one(&mut *tx)
        .await?;
        if usage.count <= limits.max_per_account && usage.bytes <= limits.max_account_bytes {
            break;
        }
        // Oldest unpinned first, automatic kinds before manual ones. The new
        // point is never its own victim.
        let evicted = sqlx::query_scalar!(
            r#"DELETE FROM bookmark_restore_points
               WHERE (user_id, id) = (
                   SELECT user_id, id FROM bookmark_restore_points
                   WHERE user_id = $1 AND NOT pinned AND id <> $2
                   ORDER BY (kind = 'manual') ASC, created_at ASC, id ASC
                   LIMIT 1
               )
               RETURNING size_bytes"#,
            device.user_id,
            req.id
        )
        .fetch_optional(&mut *tx)
        .await?;
        match evicted {
            Some(evicted_size) => {
                delta -= i64::from(evicted_size);
                retried = false;
            }
            None if !retried => retried = true,
            // Only pinned points (and the new one) are left. Dropping `tx`
            // rolls the insert back.
            None => return Err(AppError::Conflict("restore_point_limit".into())),
        }
    }

    adjust_restore_point_bytes(&mut tx, device.user_id, delta).await?;
    let meta = fetch_meta(&mut *tx, device.user_id, req.id)
        .await?
        .ok_or(AppError::NotFound)?;
    tx.commit().await?;
    invalidate_stats_cache(device.user_id);
    Ok(Json(meta))
}

/// Adds `delta` (may be negative) to `sync_stats.restore_point_bytes`,
/// creating the row if the account has none yet.
pub(crate) async fn adjust_restore_point_bytes(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    delta: i64,
) -> AppResult<()> {
    sqlx::query!(
        r#"INSERT INTO sync_stats (user_id, restore_point_bytes) VALUES ($1, GREATEST($2::bigint, 0))
           ON CONFLICT (user_id) DO UPDATE
           SET restore_point_bytes = GREATEST(sync_stats.restore_point_bytes + $2::bigint, 0),
               updated_at = now()"#,
        user_id,
        delta
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn list(
    user: AnyAuthenticatedUser,
    State(state): State<AppState>,
) -> AppResult<Json<ListResponse>> {
    enforce(
        &state.rate_limiter,
        RESTORE_POINT_READ_LIMIT,
        &user.rate_limit_key,
    )?;
    let sql = format!("{META_SELECT} WHERE p.user_id = $1 ORDER BY p.created_at DESC, p.id DESC");
    let points = sqlx::query_as::<_, RestorePointMeta>(&sql)
        .bind(user.user_id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(ListResponse { points }))
}

async fn download(
    device: AuthenticatedDevice,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<DownloadResponse>> {
    enforce(
        &state.rate_limiter,
        RESTORE_POINT_DOWNLOAD_LIMIT,
        &device.device_id.to_string(),
    )?;
    let meta = fetch_meta(&state.db, device.user_id, id)
        .await?
        .ok_or(AppError::NotFound)?;
    let bytes = sqlx::query_scalar!(
        "SELECT envelope FROM bookmark_restore_points WHERE user_id = $1 AND id = $2",
        device.user_id,
        id
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let text = String::from_utf8(bytes)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("stored envelope is not UTF-8: {e}")))?;
    let envelope = RawValue::from_string(text)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("stored envelope is not JSON: {e}")))?;
    Ok(Json(DownloadResponse { meta, envelope }))
}

async fn set_pinned(
    user: AnyAuthorizedMutator,
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<PinRequest>,
) -> AppResult<Json<RestorePointMeta>> {
    reject_if_protocol_too_old(&headers, &state)?;
    enforce(
        &state.rate_limiter,
        RESTORE_POINT_WRITE_LIMIT,
        &user.rate_limit_key,
    )?;

    let mut tx = state.db.begin().await?;
    lock_user_stats(&mut tx, user.user_id).await?;
    let current = fetch_meta(&mut *tx, user.user_id, id)
        .await?
        .ok_or(AppError::NotFound)?;

    if req.pinned == current.pinned {
        return Ok(Json(current));
    }
    if req.pinned {
        let pinned = sqlx::query_scalar!(
            r#"SELECT COUNT(*) AS "count!" FROM bookmark_restore_points WHERE user_id = $1 AND pinned"#,
            user.user_id
        )
        .fetch_one(&mut *tx)
        .await?;
        if pinned >= state.config.restore_points.max_pinned {
            return Err(AppError::Conflict("restore_point_pin_limit".into()));
        }
    }
    sqlx::query!(
        "UPDATE bookmark_restore_points SET pinned = $3 WHERE user_id = $1 AND id = $2",
        user.user_id,
        id,
        req.pinned
    )
    .execute(&mut *tx)
    .await?;
    let meta = fetch_meta(&mut *tx, user.user_id, id)
        .await?
        .ok_or(AppError::NotFound)?;
    tx.commit().await?;

    let event = if req.pinned {
        "restore_point_pinned"
    } else {
        "restore_point_unpinned"
    };
    crate::audit::log(&state, Some(user.user_id), None, event).await;
    Ok(Json(meta))
}

async fn delete_point(
    user: AnyAuthorizedMutator,
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    reject_if_protocol_too_old(&headers, &state)?;
    enforce(
        &state.rate_limiter,
        RESTORE_POINT_WRITE_LIMIT,
        &user.rate_limit_key,
    )?;

    let mut tx = state.db.begin().await?;
    lock_user_stats(&mut tx, user.user_id).await?;
    let size = sqlx::query_scalar!(
        "DELETE FROM bookmark_restore_points WHERE user_id = $1 AND id = $2 RETURNING size_bytes",
        user.user_id,
        id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    adjust_restore_point_bytes(&mut tx, user.user_id, -i64::from(size)).await?;
    tx.commit().await?;
    invalidate_stats_cache(user.user_id);

    crate::audit::log(&state, Some(user.user_id), None, "restore_point_deleted").await;
    Ok(StatusCode::NO_CONTENT)
}

async fn applied(
    device: AuthenticatedDevice,
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(req): Json<AppliedRequest>,
) -> AppResult<StatusCode> {
    reject_if_protocol_too_old(&headers, &state)?;
    enforce(
        &state.rate_limiter,
        RESTORE_POINT_WRITE_LIMIT,
        &device.device_id.to_string(),
    )?;
    if !matches!(req.mode.as_str(), "merge" | "exact") {
        return Err(AppError::Validation("invalid restore mode".into()));
    }

    let updated = sqlx::query!(
        "UPDATE bookmark_restore_points SET last_restored_at = now() WHERE user_id = $1 AND id = $2",
        device.user_id,
        id
    )
    .execute(&state.db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    crate::audit::log(
        &state,
        Some(device.user_id),
        Some(device.device_id),
        "restore_point_applied",
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
