use axum::extract::{ConnectInfo, Path, State};
use axum::http::HeaderMap;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use uuid::Uuid;

use crate::auth::extractors::CsrfProtectedUser;
use crate::crypto::{generate_opaque_token, hash_token, verify_password_async};
use crate::error::{AppError, AppResult};
use crate::middleware::client_ip::client_ip;
use crate::middleware::rate_limit::{enforce, DEVICE_REGISTER_LIMIT, TOKEN_REFRESH_LIMIT};
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
    // docs/encryption.md §2: lets the device derive the account's
    // encryption root key locally (Argon2id over the password), so no
    // device-to-device key-grant round trip is needed.
    encryption_salt: String,
}

/// Collapses docs/protocol.md §7 steps 1-6 into a single authenticated
/// transaction: the caller must already know the account password (this is
/// the extension's initial "log in to register this browser" step).
async fn register_device(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RegisterDeviceRequest>,
) -> AppResult<Json<RegisterDeviceResponse>> {
    // See middleware::client_ip for why the raw ConnectInfo address alone
    // isn't enough in the docker-compose (behind-nginx) deployment.
    let ip = client_ip(&headers, addr, state.config.behind_proxy);
    enforce(&state.rate_limiter, DEVICE_REGISTER_LIMIT, &ip.to_string())?;

    if req.name.trim().is_empty() || req.name.len() > 200 {
        return Err(AppError::Validation("invalid device name".into()));
    }

    let user = sqlx::query!(
        "SELECT id, password_hash, encryption_salt FROM users WHERE email = $1",
        req.email.to_lowercase()
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::Unauthorized)?;

    if !verify_password_async(req.password, user.password_hash).await {
        crate::audit::log(&state, Some(user.id), None, "device_registration_failed").await;
        return Err(AppError::Unauthorized);
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
    .fetch_one(&state.db)
    .await?;

    let (access_token, refresh_token, expires_at) =
        issue_credentials(&state, device_id, user.id).await?;

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

async fn issue_credentials(
    state: &AppState,
    device_id: Uuid,
    user_id: Uuid,
) -> AppResult<(String, String, chrono::DateTime<Utc>)> {
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
    .execute(&state.db)
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

/// Refresh token rotation per docs/security.md §1.2: the presented refresh
/// token is immediately revoked and replaced, whether or not the caller
/// goes on to use the new one, so a stolen-then-replayed old token is
/// detected (its hash will already be revoked) rather than silently reused.
///
/// Rate limiting happens in two layers, at two different points, keyed on
/// two different things, because they guard against two different costs
/// (mirrors websocket::ws_handler's two-layer comment for the same reason):
///
/// - Here, before the database is ever touched, `TOKEN_REFRESH_LIMIT` is
///   enforced by the presented token's hash rather than client IP. This
///   ties the limit to the actual credential being presented (so one
///   stolen/guessed token can't be hammered regardless of what IP it's
///   hammered from) and sidesteps the ConnectInfo-behind-nginx IP-masking
///   problem entirely (see middleware::client_ip) since no IP is used here
///   at all. It's cheap and runs before any DB lookup, so it's what bounds
///   raw request volume from garbage/replayed-same-token junk. But because
///   every successful refresh rotates the token (see above), the hash on a
///   *legitimately rotating* sequence of calls is different every time —
///   this check alone can never fire against that sequence, no matter how
///   fast it repeats, since each call lands in a fresh bucket.
/// - Below, after `cred` is looked up and confirmed not device-revoked but
///   *before* it's revoked/rotated, the same `TOKEN_REFRESH_LIMIT` is
///   enforced again, this time keyed by `cred.device_id` — the actual,
///   rotation-invariant identity being refreshed. `device_id` never changes
///   across rotations, so this is what actually bounds a rapid
///   successful-refresh loop against one real device's credentials,
///   regardless of how many times the token itself has rotated in between.
async fn refresh_credentials(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> AppResult<Json<RefreshResponse>> {
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

    enforce(&state.rate_limiter, TOKEN_REFRESH_LIMIT, &cred.device_id.to_string())?;

    sqlx::query!(
        "UPDATE device_credentials SET revoked_at = now(), last_used_at = now() WHERE id = $1",
        cred.cred_id
    )
    .execute(&state.db)
    .await?;

    let (access_token, refresh_token, expires_at) =
        issue_credentials(&state, cred.device_id, cred.user_id).await?;

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
    if req.name.trim().is_empty() || req.name.len() > 200 {
        return Err(AppError::Validation("invalid device name".into()));
    }

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

    // Overwrite the revocation cache directly instead of just letting it
    // expire — `AuthenticatedDevice::from_request_parts` (server/src/auth/extractors.rs)
    // would otherwise keep accepting this device's existing access token for
    // up to `DEVICE_REVOCATION_CACHE_TTL` after this handler returns.
    state
        .device_revocation_cache
        .insert(id, (std::time::Instant::now(), false));

    crate::audit::log(&state, Some(user.user_id), Some(id), "device_revoked").await;

    Ok(Json(device))
}

/// `last_seen_at` is purely informational (the web dashboard's device
/// list), so the `WHERE` clause below intentionally skips the write
/// entirely once it's already fresh within the last minute — during a
/// backfill drain, every sync route calls this on every request (up to
/// hundreds per minute per device), and without this guard each one was a
/// real row UPDATE (dead tuple, WAL entry, index maintenance) purely to
/// advance a timestamp nobody was reading at that resolution anyway.
///
/// This is the second layer of a two-layer guard: `touch_last_seen_background`
/// checks an in-memory cache first and only spawns a task that calls this
/// function when the cache says the device might be stale. This `WHERE`
/// clause remains as the backstop for what the in-memory cache can't catch
/// on its own — races between concurrent requests for the same device, and
/// the cache being empty after a process restart (see the note on
/// `touch_last_seen_background`) — so it stays even though the common case
/// is now filtered out before a connection is ever checked out.
pub async fn touch_last_seen(state: &AppState, device_id: Uuid) {
    let _ = sqlx::query!(
        "UPDATE devices SET last_seen_at = now() \
         WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - INTERVAL '1 minute')",
        device_id
    )
    .execute(&state.db)
    .await;
}

/// Matches the SQL `WHERE`-clause guard in `touch_last_seen`
/// (`INTERVAL '1 minute'`) — keep the two in sync. Letting them drift apart
/// would either reintroduce a wasted round trip (cache thinks a device is
/// stale sooner than the DB would've, so `touch_last_seen` runs a query that
/// just no-ops) or, worse, cause the cache to consider a device fresh for
/// longer than the DB does, which would mean the in-memory check alone can't
/// guarantee the write already landed — harmless today since the DB clause
/// is still the source of truth, but worth keeping equal so the two guards
/// describe the same window.
const LAST_SEEN_TOUCH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// Fire-and-forget counterpart to `touch_last_seen`: `last_seen_at` is
/// purely informational (surfaced on the web dashboard's device list) and
/// nothing in the request path ever depends on it having landed before the
/// response is sent, so every sync-route call site spawns this instead of
/// awaiting it directly — it was otherwise one full DB round trip serialized
/// into every request's latency for no reason the caller ever needed.
/// `AppState` is cheap to clone (an `Arc`'d config + a `PgPool`, itself a
/// handle around an `Arc`, per sqlx's docs).
///
/// Two-layer guard against pool pressure from this being called on every
/// `/operations`, `/changes`, and `/snapshot` request: this function first
/// checks `state.last_seen_cache`, an in-memory per-device "last touched"
/// instant, and returns without spawning anything at all when the device
/// was touched within `LAST_SEEN_TOUCH_INTERVAL` — no pool checkout, not
/// even for a guarded no-op query. Only when the cache says the device
/// might be stale (or has no entry yet) does this spawn a task that calls
/// `touch_last_seen`, whose own `WHERE`-clause guard is the remaining
/// backstop against races between concurrent requests for the same device
/// racing this check, and against server restarts.
///
/// Correctness note: `last_seen_cache` is per-process and starts empty on
/// every restart/redeploy, so the first touch for any given device after a
/// restart always falls through to the DB regardless of how recently it was
/// actually touched before the restart. That's a bounded, one-time-per-
/// device-per-restart cost, not a correctness issue — but it does mean the
/// SQL guard in `touch_last_seen` is still load-bearing and not safe to
/// remove just because this cache exists.
pub fn touch_last_seen_background(state: &AppState, device_id: Uuid) {
    if let Some(last) = state.last_seen_cache.get(&device_id) {
        if last.elapsed() < LAST_SEEN_TOUCH_INTERVAL {
            return;
        }
    }
    state.last_seen_cache.insert(device_id, std::time::Instant::now());
    let state = state.clone();
    tokio::spawn(async move {
        touch_last_seen(&state, device_id).await;
    });
}
