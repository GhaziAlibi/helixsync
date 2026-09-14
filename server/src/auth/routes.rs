use axum::extract::{ConnectInfo, Path, State};
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use uuid::Uuid;

use crate::crypto::{generate_encryption_salt, hash_password_async, verify_password_async};
use crate::error::{AppError, AppResult};
use crate::middleware::rate_limit::{enforce, LOGIN_LIMIT, REGISTER_LIMIT};
use crate::state::AppState;

use super::extractors::{AuthenticatedUser, CsrfProtectedUser, SESSION_COOKIE_NAME};
use super::model::UserPublic;
use super::session::{create_session, expired_cookie, revoke_session};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/register", post(register))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", axum::routing::get(me))
        .route("/password", post(change_password))
        .route("/sessions", axum::routing::get(list_sessions))
        .route("/sessions/:id/revoke", post(revoke_session_route))
}

#[derive(Deserialize)]
struct RegisterRequest {
    email: String,
    password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthResponse {
    user: UserPublic,
    csrf_token: String,
}

async fn register(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(req): Json<RegisterRequest>,
) -> AppResult<(CookieJar, Json<AuthResponse>)> {
    enforce(&state.rate_limiter, REGISTER_LIMIT, &addr.ip().to_string())?;

    if !req.email.contains('@') || req.email.len() > 320 {
        return Err(AppError::Validation("invalid email".into()));
    }
    if req.password.len() < 12 {
        return Err(AppError::Validation(
            "password must be at least 12 characters".into(),
        ));
    }

    let password_hash = hash_password_async(req.password)
        .await
        .map_err(AppError::Internal)?;
    let encryption_salt = generate_encryption_salt();

    let user = sqlx::query!(
        r#"
        INSERT INTO users (email, password_hash, encryption_salt) VALUES ($1, $2, $3)
        RETURNING id, email
        "#,
        req.email.to_lowercase(),
        password_hash,
        encryption_salt
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(db_err) if db_err.is_unique_violation() => {
            AppError::Validation("an account with this email already exists".into())
        }
        other => AppError::Database(other),
    })?;

    sqlx::query!(
        "INSERT INTO user_settings (user_id) VALUES ($1)",
        user.id
    )
    .execute(&state.db)
    .await?;

    crate::audit::log(&state, Some(user.id), None, "account_registered").await;

    finish_login(&state, jar, headers, user.id, user.email).await
}

#[derive(Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(req): Json<LoginRequest>,
) -> AppResult<(CookieJar, Json<AuthResponse>)> {
    enforce(&state.rate_limiter, LOGIN_LIMIT, &addr.ip().to_string())?;

    let user = sqlx::query!(
        "SELECT id, email, password_hash FROM users WHERE email = $1",
        req.email.to_lowercase()
    )
    .fetch_optional(&state.db)
    .await?;

    let Some(user) = user else {
        // Constant-shape response: don't leak whether the email exists.
        let _ = hash_password_async("dummy-to-equalize-timing".to_string()).await;
        crate::audit::log(&state, None, None, "login_failed").await;
        return Err(AppError::Unauthorized);
    };

    if !verify_password_async(req.password, user.password_hash).await {
        crate::audit::log(&state, Some(user.id), None, "login_failed").await;
        return Err(AppError::Unauthorized);
    }

    crate::audit::log(&state, Some(user.id), None, "login_succeeded").await;

    finish_login(&state, jar, headers, user.id, user.email).await
}

async fn finish_login(
    state: &AppState,
    jar: CookieJar,
    headers: HeaderMap,
    user_id: uuid::Uuid,
    email: String,
) -> AppResult<(CookieJar, Json<AuthResponse>)> {
    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let (session_cookie, csrf_cookie) =
        create_session(state, user_id, user_agent, None)
            .await
            .map_err(AppError::Internal)?;

    let csrf_value = csrf_cookie.value().to_string();
    let jar = jar.add(session_cookie).add(csrf_cookie);

    Ok((
        jar,
        Json(AuthResponse {
            user: UserPublic { id: user_id, email },
            csrf_token: csrf_value,
        }),
    ))
}

async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<(axum::http::StatusCode, CookieJar)> {
    if let Some(cookie) = jar.get(SESSION_COOKIE_NAME) {
        let _ = revoke_session(&state, cookie.value()).await;
    }
    let jar = jar
        .add(expired_cookie(SESSION_COOKIE_NAME))
        .add(expired_cookie(super::extractors::CSRF_COOKIE_NAME));
    // 204 (not 200 with an empty body): clients that always parse a JSON
    // body on non-204 responses would otherwise throw on this endpoint.
    Ok((axum::http::StatusCode::NO_CONTENT, jar))
}

async fn me(user: AuthenticatedUser) -> Json<UserPublic> {
    Json(UserPublic {
        id: user.user_id,
        email: user.email,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
}

/// Changing the password does not itself revoke other active web sessions
/// or device credentials — those are independent security boundaries
/// (docs/security.md §1) with their own revocation controls (device
/// revocation, session list), each revocable independently from the
/// account.
async fn change_password(
    CsrfProtectedUser(user): CsrfProtectedUser,
    State(state): State<AppState>,
    Json(req): Json<ChangePasswordRequest>,
) -> AppResult<Json<serde_json::Value>> {
    if req.new_password.len() < 12 {
        return Err(AppError::Validation(
            "password must be at least 12 characters".into(),
        ));
    }

    let row = sqlx::query!(
        "SELECT password_hash FROM users WHERE id = $1",
        user.user_id
    )
    .fetch_one(&state.db)
    .await?;

    if !verify_password_async(req.current_password, row.password_hash).await {
        crate::audit::log(&state, Some(user.user_id), None, "password_change_failed").await;
        return Err(AppError::Unauthorized);
    }

    let new_hash = hash_password_async(req.new_password)
        .await
        .map_err(AppError::Internal)?;
    sqlx::query!(
        "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2",
        new_hash,
        user.user_id
    )
    .execute(&state.db)
    .await?;

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
    let result = sqlx::query!(
        "UPDATE web_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
        id,
        user.user_id
    )
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    crate::audit::log(&state, Some(user.user_id), None, "web_session_revoked").await;

    Ok(Json(serde_json::json!({ "ok": true })))
}
