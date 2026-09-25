use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use uuid::Uuid;

use crate::auth::normalize_email;
use crate::crypto::{
    fake_kdf_salt_for_unknown_email, hash_password_async, validate_auth_key, verify_password_async,
};
use crate::error::{AppError, AppResult};
use crate::middleware::client_ip::{client_ip, rate_limit_ip_key};
use crate::middleware::rate_limit::{
    enforce, ACCOUNT_DELETE_LIMIT, LOGIN_EMAIL_LIMIT, LOGIN_LIMIT, PRELOGIN_EMAIL_LIMIT,
    PRELOGIN_LIMIT, REGISTER_LIMIT,
};
use crate::state::AppState;

use super::extractors::{
    write_device_revocation_cache_entry, write_web_session_cache_entry, AuthenticatedUser,
    CsrfProtectedUser, CSRF_COOKIE_NAME, SESSION_COOKIE_NAME,
};
use super::model::UserPublic;
use super::session::{create_session, expired_cookie, revoke_session};

/// Routes that are safe to compress. See [`sensitive_router`] for the others.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/logout", post(logout))
        .route("/me", axum::routing::get(me))
        // Documented as PATCH (docs/encryption.md §4); POST kept for old clients.
        .route("/password", post(change_password).patch(change_password))
        .route("/sessions", axum::routing::get(list_sessions))
        .route("/sessions/{id}/revoke", post(revoke_session_route))
        .route("/account", axum::routing::delete(delete_account))
}

/// Routes whose response contains the CSRF token. `crate::app` mounts them
/// outside `CompressionLayer` to avoid BREACH-style attacks.
pub fn sensitive_router() -> Router<AppState> {
    Router::new()
        .route("/register", post(register))
        .route("/login", post(login))
        .route("/prelogin", post(prelogin))
}

/// Default Argon2id cost for a fresh `kdfParams`, returned for prelogin's
/// enumeration-resistant fake response (docs/encryption.md §2). Real
/// accounts store their own `kdf_params`, generated client-side at
/// register time — the server never chooses or validates the real ones
/// beyond storing whatever JSON the client sent.
fn default_kdf_params() -> serde_json::Value {
    serde_json::json!({ "m": 19456, "t": 2, "p": 1 })
}

/// `authKey` replaces the password on every route that used to receive one
/// (SEC-01): it's what's left after the client derives
/// `M = Argon2id(password, kdfSalt, kdfParams)` and splits it into
/// `authKey` (sent here) and `KEK` (never leaves the client). Rejects
/// anything that isn't exactly 32 bytes of base64url — in particular, a
/// raw password by mistake.
fn validate_request_auth_key(auth_key: &str) -> AppResult<()> {
    validate_auth_key(auth_key).map_err(|e| AppError::Validation(e.to_string()))
}

#[derive(Deserialize)]
struct PreloginRequest {
    email: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreloginResponse {
    kdf_salt: String,
    kdf_params: serde_json::Value,
}

/// Returns the KDF material a client needs to derive `M`/`authKey`/`KEK`
/// for `email`, without ever confirming whether that email has an account
/// (docs/encryption.md §2) — an unknown email gets a deterministic fake
/// salt instead of an error, indistinguishable from a real one to the
/// caller.
async fn prelogin(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<PreloginRequest>,
) -> AppResult<Json<PreloginResponse>> {
    let ip = client_ip(&headers, addr, state.config.behind_proxy);
    enforce(&state.rate_limiter, PRELOGIN_LIMIT, &rate_limit_ip_key(ip))?;

    let email = normalize_email(&req.email);
    enforce(&state.rate_limiter, PRELOGIN_EMAIL_LIMIT, &email)?;

    let user = sqlx::query!(
        "SELECT kdf_salt, kdf_params FROM users WHERE email = $1",
        email
    )
    .fetch_optional(&state.db)
    .await?;

    let (kdf_salt, kdf_params) = match user {
        Some(user) => (user.kdf_salt, user.kdf_params),
        None => (
            fake_kdf_salt_for_unknown_email(&state.config.jwt_signing_key, &email),
            default_kdf_params(),
        ),
    };

    Ok(Json(PreloginResponse {
        kdf_salt,
        kdf_params,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterRequest {
    email: String,
    auth_key: String,
    kdf_salt: String,
    kdf_params: serde_json::Value,
    wrapped_ak: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthResponse {
    user: UserPublic,
    csrf_token: String,
    wrapped_ak: String,
    kdf_salt: String,
    kdf_params: serde_json::Value,
    account_key_version: i32,
}

async fn register(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(req): Json<RegisterRequest>,
) -> AppResult<(CookieJar, Json<AuthResponse>)> {
    // Real client IP, even behind nginx (see middleware::client_ip).
    let ip = client_ip(&headers, addr, state.config.behind_proxy);
    enforce(&state.rate_limiter, REGISTER_LIMIT, &rate_limit_ip_key(ip))?;

    // After the rate limit, before any validation or Argon2 work, so a closed
    // instance can't be made to burn CPU by registration attempts.
    if !state.config.allow_registration {
        return Err(AppError::RegistrationDisabled);
    }

    if !req.email.contains('@') || req.email.len() > 320 {
        return Err(AppError::Validation("invalid email".into()));
    }
    validate_request_auth_key(&req.auth_key)?;

    let email = normalize_email(&req.email);

    let password_hash = hash_password_async(req.auth_key.clone(), &state.argon2_semaphore)
        .await
        .map_err(AppError::Internal)?;

    let mut tx = state.db.begin().await?;

    let insert_result = sqlx::query!(
        r#"
        INSERT INTO users (email, password_hash, kdf_salt, kdf_params, wrapped_account_key)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, email, kdf_salt, kdf_params, wrapped_account_key, account_key_version
        "#,
        email.clone(),
        password_hash,
        req.kdf_salt,
        req.kdf_params,
        req.wrapped_ak,
    )
    .fetch_one(&mut *tx)
    .await;

    let user = match insert_result {
        Ok(user) => user,
        Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => {
            // Same status/message shape as any other registration
            // failure: don't confirm that the email is already
            // registered (SEC-11). The attempt is still audited
            // server-side, keyed to the existing account when we can
            // find it, so the operator can see enumeration/lockout
            // attempts even though the client response stays generic.
            let existing = sqlx::query!("SELECT id FROM users WHERE email = $1", email)
                .fetch_optional(&state.db)
                .await?;
            crate::audit::log(
                &state,
                existing.map(|u| u.id),
                None,
                "registration_duplicate_attempt",
            )
            .await;
            return Err(AppError::Validation("registration failed".into()));
        }
        Err(other) => return Err(AppError::Database(other)),
    };

    sqlx::query!("INSERT INTO user_settings (user_id) VALUES ($1)", user.id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    crate::audit::log(&state, Some(user.id), None, "account_registered").await;

    finish_login(
        &state,
        jar,
        headers,
        user.id,
        user.email,
        user.wrapped_account_key,
        user.kdf_salt,
        user.kdf_params,
        user.account_key_version,
        ip,
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginRequest {
    email: String,
    auth_key: String,
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(req): Json<LoginRequest>,
) -> AppResult<(CookieJar, Json<AuthResponse>)> {
    let ip = client_ip(&headers, addr, state.config.behind_proxy);
    enforce(&state.rate_limiter, LOGIN_LIMIT, &rate_limit_ip_key(ip))?;

    // Per-account limit, so guesses spread across many IPs are still
    // throttled. Checked before the DB lookup and Argon2 to save CPU.
    let email = normalize_email(&req.email);
    enforce(&state.rate_limiter, LOGIN_EMAIL_LIMIT, &email)?;

    validate_request_auth_key(&req.auth_key)?;

    let user = sqlx::query!(
        "SELECT id, email, password_hash, wrapped_account_key, kdf_salt, kdf_params, account_key_version FROM users WHERE email = $1",
        email
    )
    .fetch_optional(&state.db)
    .await?;

    let Some(user) = user else {
        // Constant-shape response: don't leak whether the email exists.
        let _ = hash_password_async(
            "dummy-to-equalize-timing".to_string(),
            &state.argon2_semaphore,
        )
        .await;
        crate::audit::log(&state, None, None, "login_failed").await;
        return Err(AppError::Unauthorized);
    };

    if !verify_password_async(req.auth_key, user.password_hash, &state.argon2_semaphore).await {
        crate::audit::log(&state, Some(user.id), None, "login_failed").await;
        return Err(AppError::Unauthorized);
    }

    crate::audit::log(&state, Some(user.id), None, "login_succeeded").await;

    finish_login(
        &state,
        jar,
        headers,
        user.id,
        user.email,
        user.wrapped_account_key,
        user.kdf_salt,
        user.kdf_params,
        user.account_key_version,
        ip,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn finish_login(
    state: &AppState,
    jar: CookieJar,
    headers: HeaderMap,
    user_id: uuid::Uuid,
    email: String,
    wrapped_ak: String,
    kdf_salt: String,
    kdf_params: serde_json::Value,
    account_key_version: i32,
    ip: std::net::IpAddr,
) -> AppResult<(CookieJar, Json<AuthResponse>)> {
    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let (session_cookie, csrf_cookie) =
        create_session(state, user_id, user_agent, Some(ip.to_string()))
            .await
            .map_err(AppError::Internal)?;

    let csrf_value = csrf_cookie.value().to_string();
    let jar = jar.add(session_cookie).add(csrf_cookie);

    Ok((
        jar,
        Json(AuthResponse {
            user: UserPublic { id: user_id, email },
            csrf_token: csrf_value,
            wrapped_ak,
            kdf_salt,
            kdf_params,
            account_key_version,
        }),
    ))
}

async fn logout(
    State(state): State<AppState>,
    CsrfProtectedUser(_user): CsrfProtectedUser,
    jar: CookieJar,
) -> AppResult<(axum::http::StatusCode, CookieJar)> {
    if let Some(cookie) = jar.get(SESSION_COOKIE_NAME) {
        // `revoke_session` updates the cache. Don't `.remove()` here first,
        // or a stale in-flight read could re-add the session.
        revoke_session(&state, cookie.value()).await?;
    }
    let jar = jar
        .add(expired_cookie(SESSION_COOKIE_NAME))
        .add(expired_cookie(CSRF_COOKIE_NAME));
    // 204, so clients don't try to parse an empty JSON body.
    Ok((StatusCode::NO_CONTENT, jar))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteAccountRequest {
    auth_key: String,
}

/// Permanently deletes the account and everything under it.
///
/// Needs a session with a valid CSRF token *and* the current `authKey`: a
/// stolen session cookie alone must not be enough to destroy the account.
/// Every other table references `users` with `ON DELETE CASCADE` (audit rows
/// are `SET NULL`, so the event trail survives without the user id), so
/// deleting the one row is the whole database cleanup. What the cascade can't
/// reach is process memory, which is purged afterwards so no cached session
/// or device token keeps working for up to its cache TTL.
async fn delete_account(
    CsrfProtectedUser(user): CsrfProtectedUser,
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<DeleteAccountRequest>,
) -> AppResult<(StatusCode, CookieJar)> {
    enforce(
        &state.rate_limiter,
        ACCOUNT_DELETE_LIMIT,
        &user.user_id.to_string(),
    )?;

    validate_request_auth_key(&req.auth_key)?;

    let row = sqlx::query!(
        "SELECT password_hash FROM users WHERE id = $1",
        user.user_id
    )
    .fetch_one(&state.db)
    .await?;

    if !verify_password_async(req.auth_key, row.password_hash, &state.argon2_semaphore).await {
        crate::audit::log(&state, Some(user.user_id), None, "account_delete_failed").await;
        return Err(AppError::Unauthorized);
    }

    let mut tx = state.db.begin().await?;

    // Lock the user row first. Inserting a session or device takes a
    // FOR KEY SHARE lock on it through the foreign key, so a login or device
    // registration racing with this delete either lands before the lock (and
    // shows up in the lists below) or waits and then fails its foreign key.
    // Without it, the lists could miss a row that the cascade then deletes.
    let locked = sqlx::query!(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        user.user_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if locked.is_none() {
        // A concurrent delete of this same account won the race.
        return Err(AppError::Unauthorized);
    }

    let session_hashes = sqlx::query_scalar!(
        "SELECT session_hash FROM web_sessions WHERE user_id = $1",
        user.user_id
    )
    .fetch_all(&mut *tx)
    .await?;

    let device_ids = sqlx::query_scalar!("SELECT id FROM devices WHERE user_id = $1", user.user_id)
        .fetch_all(&mut *tx)
        .await?;

    // Written in the same transaction as the delete, so the event exists
    // exactly when the account is gone. The cascade nulls its `user_id`.
    sqlx::query!(
        "INSERT INTO audit_logs (user_id, device_id, event_type) VALUES ($1, NULL, 'account_deleted')",
        user.user_id
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!("DELETE FROM users WHERE id = $1", user.user_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    // Tombstones, not removals, with an `as_of` taken after the commit: a
    // slower in-flight auth check that read the rows before the delete must
    // not be able to re-cache them as valid (same rule as `revoke_session`).
    let purged_at = std::time::Instant::now();
    for session_hash in session_hashes {
        write_web_session_cache_entry(&state.web_session_cache, session_hash, purged_at, None);
    }
    for device_id in device_ids {
        write_device_revocation_cache_entry(
            &state.device_revocation_cache,
            device_id,
            purged_at,
            false,
        );
        state.ws_registry.disconnect_device(user.user_id, device_id);
        // These two maps are never swept and are otherwise bounded by the
        // number of devices, so dropped devices must leave them.
        state.upload_locks.remove(&device_id);
        state.last_seen_cache.remove(&device_id);
    }

    let jar = jar
        .add(expired_cookie(SESSION_COOKIE_NAME))
        .add(expired_cookie(CSRF_COOKIE_NAME));
    Ok((StatusCode::NO_CONTENT, jar))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse {
    #[serde(flatten)]
    user: UserPublic,
    wrapped_ak: String,
    kdf_salt: String,
    kdf_params: serde_json::Value,
    account_key_version: i32,
}

/// Also returns the account's wrapped-key material (docs/encryption.md §2):
/// the web dashboard needs it to re-derive/rewrap the account key for a
/// password change after a page reload, when nothing from the original
/// login response is still held in memory. Safe to hand back to the
/// account's own authenticated session — it's exactly what login/register
/// already return, and it's meaningless without the password to unwrap it.
async fn me(user: AuthenticatedUser, State(state): State<AppState>) -> AppResult<Json<MeResponse>> {
    let row = sqlx::query!(
        "SELECT wrapped_account_key, kdf_salt, kdf_params, account_key_version FROM users WHERE id = $1",
        user.user_id
    )
    .fetch_one(&state.db)
    .await?;

    Ok(Json(MeResponse {
        user: UserPublic {
            id: user.user_id,
            email: user.email,
        },
        wrapped_ak: row.wrapped_account_key,
        kdf_salt: row.kdf_salt,
        kdf_params: row.kdf_params,
        account_key_version: row.account_key_version,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordRequest {
    current_auth_key: String,
    new_auth_key: String,
    new_kdf_salt: String,
    new_kdf_params: serde_json::Value,
    new_wrapped_ak: String,
}

/// Rewraps the account key under a fresh `authKey`/`KEK` derived from the
/// new password (`account_key_version`, and therefore the account key
/// itself, is untouched — see docs/encryption.md §4) and revokes every
/// other web session for the account in the same transaction (SEC-10: a
/// stolen session cookie must not keep working after the password changes).
/// Device credentials are unaffected — a device only loses access once it's
/// explicitly revoked or reconnects with the old `authKey` and fails.
async fn change_password(
    CsrfProtectedUser(user): CsrfProtectedUser,
    State(state): State<AppState>,
    jar: CookieJar,
    Json(req): Json<ChangePasswordRequest>,
) -> AppResult<Json<serde_json::Value>> {
    validate_request_auth_key(&req.new_auth_key)?;

    let row = sqlx::query!(
        "SELECT password_hash FROM users WHERE id = $1",
        user.user_id
    )
    .fetch_one(&state.db)
    .await?;

    if !verify_password_async(
        req.current_auth_key,
        row.password_hash,
        &state.argon2_semaphore,
    )
    .await
    {
        crate::audit::log(&state, Some(user.user_id), None, "password_change_failed").await;
        return Err(AppError::Unauthorized);
    }

    let new_hash = hash_password_async(req.new_auth_key, &state.argon2_semaphore)
        .await
        .map_err(AppError::Internal)?;

    // The current session must stay valid — everything *else* gets revoked.
    let current_session_hash = jar
        .get(SESSION_COOKIE_NAME)
        .map(|c| crate::crypto::hash_token(c.value()));

    let mut tx = state.db.begin().await?;

    sqlx::query!(
        r#"
        UPDATE users
        SET password_hash = $1, kdf_salt = $2, kdf_params = $3, wrapped_account_key = $4, updated_at = now()
        WHERE id = $5
        "#,
        new_hash,
        req.new_kdf_salt,
        req.new_kdf_params,
        req.new_wrapped_ak,
        user.user_id
    )
    .execute(&mut *tx)
    .await?;

    let revoked_sessions = sqlx::query!(
        r#"
        UPDATE web_sessions
        SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL AND session_hash IS DISTINCT FROM $2
        RETURNING session_hash
        "#,
        user.user_id,
        current_session_hash
    )
    .fetch_all(&mut *tx)
    .await?;

    tx.commit().await?;

    let revoked_at = std::time::Instant::now();
    for row in revoked_sessions {
        super::extractors::write_web_session_cache_entry(
            &state.web_session_cache,
            row.session_hash,
            revoked_at,
            None,
        );
    }

    crate::audit::log(&state, Some(user.user_id), None, "password_changed").await;

    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WebSessionPublic {
    id: Uuid,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    user_agent: Option<String>,
    ip_address: Option<String>,
    current: bool,
}

async fn list_sessions(
    user: AuthenticatedUser,
    jar: CookieJar,
    State(state): State<AppState>,
) -> AppResult<Json<Vec<WebSessionPublic>>> {
    let current_hash = jar
        .get(SESSION_COOKIE_NAME)
        .map(|c| crate::crypto::hash_token(c.value()));

    let rows = sqlx::query!(
        r#"
        SELECT id, session_hash, created_at, expires_at, user_agent, ip_address
        FROM web_sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC
        "#,
        user.user_id
    )
    .fetch_all(&state.db)
    .await?;

    let sessions = rows
        .into_iter()
        .map(|r| WebSessionPublic {
            id: r.id,
            created_at: r.created_at,
            expires_at: r.expires_at,
            user_agent: r.user_agent,
            ip_address: r.ip_address,
            current: current_hash.as_deref() == Some(r.session_hash.as_str()),
        })
        .collect();

    Ok(Json(sessions))
}

async fn revoke_session_route(
    CsrfProtectedUser(user): CsrfProtectedUser,
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
) -> AppResult<Json<serde_json::Value>> {
    let row = sqlx::query!(
        "UPDATE web_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING session_hash",
        id,
        user.user_id
    )
    .fetch_optional(&state.db)
    .await?;

    let row = row.ok_or(AppError::NotFound)?;

    // Tombstone, not `.remove()`; see `revoke_session`.
    super::extractors::write_web_session_cache_entry(
        &state.web_session_cache,
        row.session_hash,
        std::time::Instant::now(),
        None,
    );

    crate::audit::log(&state, Some(user.user_id), None, "web_session_revoked").await;

    Ok(Json(serde_json::json!({ "ok": true })))
}
