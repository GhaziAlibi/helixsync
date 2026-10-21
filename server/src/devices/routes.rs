use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::ops::RangeInclusive;
use uuid::Uuid;

use crate::auth::extractors::{
    write_device_revocation_cache_entry, AuthenticatedDevice, CsrfProtectedUser,
};
use crate::auth::normalize_email;
use crate::crypto::{
    generate_opaque_token, hash_password_async, hash_token, validate_auth_key,
    verify_password_async,
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
        .route("/{id}", patch(rename_device))
        .route("/{id}/revoke", post(revoke_device))
        // Static segments win over `/:id/...` in the router, so "self" is
        // never parsed as a device id.
        .route("/self/revoke", post(revoke_self))
        .route(
            "/auth-requests",
            get(crate::auth::requests::list_auth_requests),
        )
        .route(
            "/auth-requests/{id}/respond",
            post(crate::auth::requests::respond_auth_request),
        )
}

/// Longest device name accepted, in bytes.
const MAX_DEVICE_NAME_LEN: usize = 200;

pub(crate) fn validate_device_name(name: &str) -> AppResult<()> {
    if name.trim().is_empty() || name.len() > MAX_DEVICE_NAME_LEN {
        return Err(AppError::Validation("invalid device name".into()));
    }
    Ok(())
}

/// Longest browser, version or platform string accepted, in bytes.
const MAX_DEVICE_FIELD_LEN: usize = 100;
/// Longest stored User-Agent, in bytes. Longer ones are cut, not rejected.
const MAX_USER_AGENT_LEN: usize = 512;
/// Longest wrapped account key accepted, in bytes (a real one is under 300).
const MAX_WRAPPED_KEY_LEN: usize = 1024;

fn validate_field_len(field: &str, value: Option<&str>, max: usize) -> AppResult<()> {
    if value.is_some_and(|v| v.len() > max) {
        return Err(AppError::Validation(format!("{field} is too long")));
    }
    Ok(())
}

pub(crate) fn validate_device_info(
    browser: Option<&str>,
    browser_version: Option<&str>,
    platform: Option<&str>,
    extension_version: Option<&str>,
) -> AppResult<()> {
    validate_field_len("browser", browser, MAX_DEVICE_FIELD_LEN)?;
    validate_field_len("browserVersion", browser_version, MAX_DEVICE_FIELD_LEN)?;
    validate_field_len("platform", platform, MAX_DEVICE_FIELD_LEN)?;
    validate_field_len("extensionVersion", extension_version, MAX_DEVICE_FIELD_LEN)
}

pub(crate) fn validate_wrapped_key(field: &str, wrapped: &str) -> AppResult<()> {
    validate_field_len(field, Some(wrapped), MAX_WRAPPED_KEY_LEN)
}

/// Argon2id bounds the clients enforce (`assertSaneKdfParams` in
/// extension/src/crypto/index.ts and web/src/crypto/index.ts).
const KDF_M_RANGE: RangeInclusive<u64> = 19456..=262144;
const KDF_T_RANGE: RangeInclusive<u64> = 2..=10;
const KDF_P_RANGE: RangeInclusive<u64> = 1..=4;

pub(crate) fn validate_kdf_salt(salt: &str) -> AppResult<()> {
    let decoded = base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, salt);
    if !matches!(decoded, Ok(bytes) if bytes.len() == 16) {
        return Err(AppError::Validation(
            "kdfSalt must be 16 bytes of base64url".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_kdf_params(params: &serde_json::Value) -> AppResult<()> {
    let invalid =
        || AppError::Validation("kdfParams must be { m, t, p } integers within bounds".into());
    let obj = params.as_object().ok_or_else(invalid)?;
    if obj.len() != 3 {
        return Err(invalid());
    }
    let within = |key: &str, range: &RangeInclusive<u64>| {
        obj.get(key)
            .and_then(|v| v.as_u64())
            .is_some_and(|v| range.contains(&v))
    };
    if within("m", &KDF_M_RANGE) && within("t", &KDF_T_RANGE) && within("p", &KDF_P_RANGE) {
        Ok(())
    } else {
        Err(invalid())
    }
}

/// The request's User-Agent, cut to `MAX_USER_AGENT_LEN` bytes on a char boundary.
pub(crate) fn user_agent_from_headers(headers: &HeaderMap) -> Option<String> {
    let ua = headers.get(header::USER_AGENT)?.to_str().ok()?;
    let mut end = ua.len().min(MAX_USER_AGENT_LEN);
    while !ua.is_char_boundary(end) {
        end -= 1;
    }
    Some(ua[..end].to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterDeviceRequest {
    email: String,
    auth_key: String,
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
    // Lets the device unwrap the account key locally with the KEK it
    // already derived via `POST /auth/prelogin` (docs/encryption.md §2).
    wrapped_account_key: String,
    account_key_version: i32,
}

/// Registers a device in one step (docs/protocol.md §7, steps 1-6). The
/// caller must have already called `POST /auth/prelogin` for this email and
/// derived `authKey` from the account password — never the password itself.
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
    validate_device_info(
        req.browser.as_deref(),
        req.browser_version.as_deref(),
        req.platform.as_deref(),
        req.extension_version.as_deref(),
    )?;
    validate_auth_key(&req.auth_key).map_err(|e| AppError::Validation(e.to_string()))?;

    // Per-account limit, like `auth::routes::login`. Checked before the DB
    // lookup and Argon2.
    let email = normalize_email(&req.email);
    enforce(&state.rate_limiter, DEVICE_REGISTER_EMAIL_LIMIT, &email)?;

    let user = sqlx::query!(
        "SELECT id, password_hash, wrapped_account_key, account_key_version FROM users WHERE email = $1",
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

    if !verify_password_async(req.auth_key, user.password_hash, &state.argon2_semaphore).await {
        crate::audit::log(&state, Some(user.id), None, "device_registration_failed").await;
        return Err(AppError::Unauthorized);
    }

    let mut tx = state.db.begin().await?;

    let new_device = NewDevice {
        name: req.name,
        browser: req.browser,
        browser_version: req.browser_version,
        platform: req.platform,
        extension_version: req.extension_version,
    };
    let Some(issued) = insert_device(&state, &mut tx, user.id, new_device).await? else {
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
    };

    tx.commit().await?;

    crate::audit::log(
        &state,
        Some(user.id),
        Some(issued.device_id),
        "device_registered",
    )
    .await;

    Ok(Json(RegisterDeviceResponse {
        device_id: issued.device_id,
        access_token: issued.access_token,
        refresh_token: issued.refresh_token,
        access_token_expires_at: issued.access_token_expires_at,
        api_version: "v1",
        protocol_version: state.config.protocol_version,
        minimum_supported_protocol_version: state.config.minimum_supported_protocol_version,
        wrapped_account_key: user.wrapped_account_key,
        account_key_version: user.account_key_version,
    }))
}

/// What a browser reports about itself when it registers.
pub(crate) struct NewDevice {
    pub name: String,
    pub browser: Option<String>,
    pub browser_version: Option<String>,
    pub platform: Option<String>,
    pub extension_version: Option<String>,
}

/// A freshly registered device's id and first credentials.
pub(crate) struct IssuedDevice {
    pub device_id: Uuid,
    pub access_token: String,
    pub refresh_token: String,
    pub access_token_expires_at: chrono::DateTime<Utc>,
}

/// Inserts a device for `user_id` and issues its first credentials inside
/// `tx`. Shared by `register_device` and an approved login-with-device
/// request (`auth::requests`). Returns `None`, with nothing written, when the
/// account already has `max_devices_per_account` active devices; the caller
/// rolls back.
pub(crate) async fn insert_device(
    state: &AppState,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    device: NewDevice,
) -> AppResult<Option<IssuedDevice>> {
    // Count and insert under a per-user advisory lock (tag 2), so concurrent
    // registrations can't exceed the device cap.
    sqlx::query!(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 2))",
        user_id.to_string()
    )
    .execute(&mut **tx)
    .await?;

    // Only active devices count, so revoking old ones frees up slots.
    let active_device_count = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM devices WHERE user_id = $1 AND revoked_at IS NULL",
        user_id
    )
    .fetch_one(&mut **tx)
    .await?
    .unwrap_or(0);

    if active_device_count >= state.config.max_devices_per_account {
        return Ok(None);
    }

    let device_id = sqlx::query_scalar!(
        r#"
        INSERT INTO devices (user_id, name, browser, browser_version, platform, extension_version)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
        user_id,
        device.name,
        device.browser,
        device.browser_version,
        device.platform,
        device.extension_version,
    )
    .fetch_one(&mut **tx)
    .await?;

    let (access_token, refresh_token, access_token_expires_at) =
        issue_credentials(state, &mut **tx, device_id, user_id).await?;

    Ok(Some(IssuedDevice {
        device_id,
        access_token,
        refresh_token,
        access_token_expires_at,
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

/// A token presented within this long of its own rotation is treated as a
/// lost-response retry rather than theft. Outside the window, reuse revokes
/// the whole device (SEC-09).
const REFRESH_TOKEN_REUSE_GRACE_SECS: i64 = 30;

/// Rotates a refresh token (docs/security.md §1.2). The old token is revoked
/// right away. Presenting it again outside `REFRESH_TOKEN_REUSE_GRACE_SECS`
/// of its rotation is treated as theft: the whole device is revoked and an
/// audit event is written (SEC-09).
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
    enforce(
        &state.rate_limiter,
        TOKEN_REFRESH_IP_LIMIT,
        &rate_limit_ip_key(ip),
    )?;

    let hash = hash_token(&req.refresh_token);

    enforce(&state.rate_limiter, TOKEN_REFRESH_LIMIT, &hash)?;

    let cred = sqlx::query!(
        r#"
        SELECT dc.id as cred_id, dc.device_id, dc.revoked_at as cred_revoked_at,
               d.user_id, d.revoked_at as device_revoked_at
        FROM device_credentials dc
        JOIN devices d ON d.id = dc.device_id
        WHERE dc.credential_hash = $1
          AND dc.expires_at > now()
        "#,
        hash
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::Unauthorized)?;

    if let Some(cred_revoked_at) = cred.cred_revoked_at {
        if cred.device_revoked_at.is_none()
            && Utc::now() - cred_revoked_at > Duration::seconds(REFRESH_TOKEN_REUSE_GRACE_SECS)
        {
            revoke_device_for_token_reuse(&state, cred.user_id, cred.device_id).await;
        }
        return Err(AppError::Unauthorized);
    }

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
    let mut tx = state.db.begin().await?;

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
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;

    sqlx::query!(
        "UPDATE device_credentials SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL",
        id
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

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

/// A device revokes itself (the extension's "Disconnect"), authenticated with
/// its own access token rather than a web session. Without this, disconnecting
/// only forgot the credentials locally: the device row and its refresh token
/// stayed valid, kept holding back compaction, and counted toward the device
/// cap until someone revoked it from the dashboard.
///
/// 204 on success. Afterwards the device's access token is rejected, so a
/// repeat call gets 401, like any other request from a revoked device.
async fn revoke_self(
    device: AuthenticatedDevice,
    State(state): State<AppState>,
) -> AppResult<StatusCode> {
    // One transaction so a failure can't leave a revoked device with live
    // refresh credentials.
    let mut tx = state.db.begin().await?;

    let revoked = sqlx::query!(
        "UPDATE devices SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id",
        device.device_id,
        device.user_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    if revoked.is_none() {
        // Revoked between the auth check (possibly served from the cache) and
        // here, e.g. from the dashboard. The device is already gone.
        return Err(AppError::Unauthorized);
    }

    sqlx::query!(
        "UPDATE device_credentials SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL",
        device.device_id
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // Same follow-up as `revoke_device`: make the access token stop working
    // now instead of when the cache entry expires, and close its websocket.
    write_device_revocation_cache_entry(
        &state.device_revocation_cache,
        device.device_id,
        std::time::Instant::now(),
        false,
    );
    state
        .ws_registry
        .disconnect_device(device.user_id, device.device_id);

    crate::audit::log(
        &state,
        Some(device.user_id),
        Some(device.device_id),
        "device_self_revoked",
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

/// Revokes a device after its refresh token was reused outside the grace
/// window (SEC-09). Mirrors `revoke_device`'s DB and cache updates, but is
/// triggered by the server, not the account owner, so it also writes an
/// audit event tying the revocation to the reuse.
async fn revoke_device_for_token_reuse(state: &AppState, user_id: Uuid, device_id: Uuid) {
    let revoked = sqlx::query!(
        "UPDATE devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
        device_id
    )
    .execute(&state.db)
    .await;

    if let Err(e) = revoked {
        tracing::error!(error = %e, %device_id, "SEC-09: failed to revoke device on refresh token reuse");
        return;
    }

    let _ = sqlx::query!(
        "UPDATE device_credentials SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL",
        device_id
    )
    .execute(&state.db)
    .await;

    write_device_revocation_cache_entry(
        &state.device_revocation_cache,
        device_id,
        std::time::Instant::now(),
        false,
    );

    state.ws_registry.disconnect_device(user_id, device_id);

    crate::audit::log(
        state,
        Some(user_id),
        Some(device_id),
        "refresh_token_reuse_detected",
    )
    .await;
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
