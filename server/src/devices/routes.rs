use axum::extract::{ConnectInfo, Path, State};
use axum::http::HeaderMap;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use uuid::Uuid;

use crate::auth::extractors::{write_device_revocation_cache_entry, CsrfProtectedUser};
use crate::auth::normalize_email;
use crate::crypto::{
    generate_opaque_token, hash_password_async, hash_token, verify_password_async,
};
use crate::error::{AppError, AppResult};
use crate::middleware::client_ip::{client_ip, rate_limit_ip_key};
use crate::middleware::rate_limit::{
    enforce, DEVICE_REGISTER_EMAIL_LIMIT, DEVICE_REGISTER_LIMIT, TOKEN_REFRESH_AUTHENTICATED_LIMIT,
    TOKEN_REFRESH_IP_LIMIT, TOKEN_REFRESH_LIMIT,
};
use crate::state::AppState;

use super::model::DevicePublic;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/register", post(register_device))
        .route("/credentials/refresh", post(refresh_credentials))
        .route("/", get(list_devices))
        .route("/:id", patch(rename_device))
        .route("/:id/revoke", post(revoke_device))
}

/// Longest device name accepted, in bytes.
const MAX_DEVICE_NAME_LEN: usize = 200;

fn validate_device_name(name: &str) -> AppResult<()> {
    if name.trim().is_empty() || name.len() > MAX_DEVICE_NAME_LEN {
        return Err(AppError::Validation("invalid device name".into()));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterDeviceRequest {
    email: String,
    password: String,
    name: String,
    browser: Option<String>,
    browser_version: Option<String>,
    platform: Option<String>,
    extension_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterDeviceResponse {
    device_id: Uuid,
    access_token: String,
    refresh_token: String,
    access_token_expires_at: chrono::DateTime<Utc>,
    api_version: &'static str,
    protocol_version: u32,
    minimum_supported_protocol_version: u32,
    // Lets the device derive the encryption key locally (docs/encryption.md §2).
    encryption_salt: String,
}

/// Registers a device in one step (docs/protocol.md §7, steps 1-6).
/// The caller must know the account password.
async fn register_device(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RegisterDeviceRequest>,
) -> AppResult<Json<RegisterDeviceResponse>> {
    // Real client IP, even behind nginx (see middleware::client_ip).
    let ip = client_ip(&headers, addr, state.config.behind_proxy);
    enforce(
        &state.rate_limiter,
        DEVICE_REGISTER_LIMIT,
        &rate_limit_ip_key(ip),
    )?;

    validate_device_name(&req.name)?;

    // Per-account limit, like `auth::routes::login`. Checked before the DB
    // lookup and Argon2.
    let email = normalize_email(&req.email);
    enforce(&state.rate_limiter, DEVICE_REGISTER_EMAIL_LIMIT, &email)?;

    let user = sqlx::query!(
        "SELECT id, password_hash, encryption_salt FROM users WHERE email = $1",
        email
    )
    .fetch_optional(&state.db)
    .await?;

    let Some(user) = user else {
        // Hash anyway so timing doesn't reveal whether the email exists.
        let _ = hash_password_async(
            "dummy-to-equalize-timing".to_string(),
            &state.argon2_semaphore,
        )
        .await;
        crate::audit::log(&state, None, None, "device_registration_failed").await;
        return Err(AppError::Unauthorized);
    };

    if !verify_password_async(req.password, user.password_hash, &state.argon2_semaphore).await {
        crate::audit::log(&state, Some(user.id), None, "device_registration_failed").await;
        return Err(AppError::Unauthorized);
    }

    // Count and insert in one transaction under a per-user advisory lock
    // (tag 2), so concurrent registrations can't exceed the device cap.
    // A failed insert also rolls back the device row.
    let mut tx = state.db.begin().await?;

    sqlx::query!(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 2))",
        user.id.to_string()
    )
    .execute(&mut *tx)
    .await?;

    // Only active devices count, so revoking old ones frees up slots.
    let active_device_count = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM devices WHERE user_id = $1 AND revoked_at IS NULL",
        user.id
    )
    .fetch_one(&mut *tx)
    .await?
    .unwrap_or(0);

    if active_device_count >= state.config.max_devices_per_account {
        // Nothing written yet; roll back explicitly since we exit early.
        tx.rollback().await?;
        crate::audit::log(
            &state,
            Some(user.id),
            None,
            "device_registration_limit_reached",
        )
        .await;
        return Err(AppError::Conflict("device_limit_reached".into()));
    }

    let device_id = sqlx::query_scalar!(
        r#"
        INSERT INTO devices (user_id, name, browser, browser_version, platform, extension_version)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
        user.id,
        req.name,
        req.browser,
        req.browser_version,
        req.platform,
        req.extension_version,
    )
    .fetch_one(&mut *tx)
    .await?;

    let (access_token, refresh_token, expires_at) =
        issue_credentials(&state, &mut *tx, device_id, user.id).await?;

    tx.commit().await?;

    crate::audit::log(&state, Some(user.id), Some(device_id), "device_registered").await;

    Ok(Json(RegisterDeviceResponse {
        device_id,
        access_token,
        refresh_token,
        access_token_expires_at: expires_at,
        api_version: "v1",
        protocol_version: state.config.protocol_version,
        minimum_supported_protocol_version: state.config.minimum_supported_protocol_version,
        encryption_salt: user.encryption_salt,
    }))
}

async fn issue_credentials<'e, E>(
    state: &AppState,
    executor: E,
    device_id: Uuid,
    user_id: Uuid,
) -> AppResult<(String, String, chrono::DateTime<Utc>)>
where
    E: sqlx::PgExecutor<'e>,
{
    let (refresh_token, refresh_hash) = generate_opaque_token();
    let credential_expires_at = Utc::now() + Duration::seconds(state.config.refresh_token_ttl_secs);

    sqlx::query!(
        r#"
        INSERT INTO device_credentials (device_id, credential_hash, expires_at)
        VALUES ($1, $2, $3)
        "#,
        device_id,
        refresh_hash,
        credential_expires_at
    )
    .execute(executor)
    .await?;

    let access_token = crate::auth::tokens::issue_device_access_token(
        &state.config.jwt_signing_key,
        device_id,
        user_id,
        state.config.access_token_ttl_secs,
    )
    .map_err(AppError::Internal)?;

    let access_expires_at = Utc::now() + Duration::seconds(state.config.access_token_ttl_secs);

    Ok((access_token, refresh_token, access_expires_at))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshRequest {
    refresh_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshResponse {
    access_token: String,
    refresh_token: String,
    access_token_expires_at: chrono::DateTime<Utc>,
}

/// Rotates a refresh token (docs/security.md §1.2). The old token is revoked
/// right away, so a replayed stolen token is detected.
///
/// Three rate limits:
/// - per IP, before any DB work;
/// - per token hash, so one token can't be hammered from many IPs;
/// - per device, after lookup, since the device id stays the same across rotations.
async fn refresh_credentials(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RefreshRequest>,
) -> AppResult<Json<RefreshResponse>> {
    let ip = client_ip(&headers, addr, state.config.behind_proxy);
    enforce(&state.rate_limiter, TOKEN_REFRESH_IP_LIMIT, &ip.to_string())?;

    let hash = hash_token(&req.refresh_token);

    enforce(&state.rate_limiter, TOKEN_REFRESH_LIMIT, &hash)?;

    let cred = sqlx::query!(
        r#"
        SELECT dc.id as cred_id, dc.device_id, d.user_id, d.revoked_at as device_revoked_at
        FROM device_credentials dc
        JOIN devices d ON d.id = dc.device_id
        WHERE dc.credential_hash = $1
          AND dc.revoked_at IS NULL
          AND dc.expires_at > now()
        "#,
        hash
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::Unauthorized)?;

    if cred.device_revoked_at.is_some() {
        return Err(AppError::Unauthorized);
    }

    enforce(
        &state.rate_limiter,
        TOKEN_REFRESH_AUTHENTICATED_LIMIT,
        &cred.device_id.to_string(),
    )?;

    let mut tx = state.db.begin().await?;

    // Only update if not already revoked, so two racing refreshes can't
    // both succeed.
    let rotated = sqlx::query!(
        r#"
        UPDATE device_credentials
        SET revoked_at = now(), last_used_at = now()
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING id
        "#,
        cred.cred_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    if rotated.is_none() {
        return Err(AppError::Unauthorized);
    }

    let (access_token, refresh_token, expires_at) =
        issue_credentials(&state, &mut *tx, cred.device_id, cred.user_id).await?;

    tx.commit().await?;

    Ok(Json(RefreshResponse {
        access_token,
        refresh_token,
        access_token_expires_at: expires_at,
    }))
}

async fn list_devices(
    user: crate::auth::extractors::AnyAuthenticatedUser,
    State(state): State<AppState>,
) -> AppResult<Json<Vec<DevicePublic>>> {
    let devices = sqlx::query_as!(
        DevicePublic,
        r#"
        SELECT id, name, browser, browser_version, platform, extension_version, last_seen_at, created_at, revoked_at
        FROM devices
        WHERE user_id = $1
        ORDER BY created_at ASC
        "#,
        user.user_id
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(devices))
}

#[derive(Deserialize)]
struct RenameRequest {
    name: String,
}

async fn rename_device(
    CsrfProtectedUser(user): CsrfProtectedUser,
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
    Json(req): Json<RenameRequest>,
) -> AppResult<Json<DevicePublic>> {
    validate_device_name(&req.name)?;

    let device = sqlx::query_as!(
        DevicePublic,
        r#"
        UPDATE devices SET name = $1
        WHERE id = $2 AND user_id = $3
        RETURNING id, name, browser, browser_version, platform, extension_version, last_seen_at, created_at, revoked_at
        "#,
        req.name,
        id,
        user.user_id
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(device))
}

async fn revoke_device(
    CsrfProtectedUser(user): CsrfProtectedUser,
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
) -> AppResult<Json<DevicePublic>> {
    let device = sqlx::query_as!(
        DevicePublic,
        r#"
        UPDATE devices SET revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id, name, browser, browser_version, platform, extension_version, last_seen_at, created_at, revoked_at
        "#,
        id,
        user.user_id
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    sqlx::query!(
        "UPDATE device_credentials SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL",
        id
    )
    .execute(&state.db)
    .await?;

    // Update the revocation cache now so the old access token stops working
    // immediately. Uses the shared writer so a stale read can't undo it.
    write_device_revocation_cache_entry(
        &state.device_revocation_cache,
        id,
        std::time::Instant::now(),
        false,
    );

    // Close any open websocket for this device too.
    state.ws_registry.disconnect_device(user.user_id, id);

    crate::audit::log(&state, Some(user.user_id), Some(id), "device_revoked").await;

    Ok(Json(device))
}

/// Updates `last_seen_at`, skipping the write if it's under a minute old.
/// Sync routes call this on every request, so this avoids many useless
/// updates. Also covers races and restarts that the in-memory cache misses.
async fn touch_last_seen(state: &AppState, device_id: Uuid) {
    let _ = sqlx::query!(
        "UPDATE devices SET last_seen_at = now() \
         WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - INTERVAL '1 minute')",
        device_id
    )
    .execute(&state.db)
    .await;
}

/// Must match the `INTERVAL '1 minute'` in `touch_last_seen`.
const LAST_SEEN_TOUCH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// Fire-and-forget `touch_last_seen`. Nothing waits on `last_seen_at`, so
/// requests don't pay for it.
///
/// Skips entirely if `last_seen_cache` says the device was touched recently.
/// The cache is empty after a restart, so the SQL guard is still needed.
pub fn touch_last_seen_background(state: &AppState, device_id: Uuid) {
    if let Some(last) = state.last_seen_cache.get(&device_id) {
        if last.elapsed() < LAST_SEEN_TOUCH_INTERVAL {
            return;
        }
    }
    state
        .last_seen_cache
        .insert(device_id, std::time::Instant::now());
    let state = state.clone();
    tokio::spawn(async move {
        touch_last_seen(&state, device_id).await;
    });
}
