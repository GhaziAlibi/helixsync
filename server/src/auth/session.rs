use axum_extra::extract::cookie::{Cookie, SameSite};
use chrono::{Duration, Utc};
use rand::RngCore;
use uuid::Uuid;

use crate::crypto::hash_token;
use crate::state::AppState;

use super::extractors::{CSRF_COOKIE_NAME, SESSION_COOKIE_NAME};

/// Create a new web session for `user_id`, persist its hash, and return the
/// (session_cookie, csrf_cookie) pair to attach to the login response.
pub async fn create_session(
    state: &AppState,
    user_id: Uuid,
    user_agent: Option<String>,
    ip_address: Option<String>,
) -> anyhow::Result<(Cookie<'static>, Cookie<'static>)> {
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let session_token = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, raw);
    let session_hash = hash_token(&session_token);

    let expires_at = Utc::now() + Duration::seconds(state.config.web_session_ttl_secs);

    sqlx::query!(
        r#"
        INSERT INTO web_sessions (user_id, session_hash, expires_at, user_agent, ip_address)
        VALUES ($1, $2, $3, $4, $5)
        "#,
        user_id,
        session_hash,
        expires_at,
        user_agent,
        ip_address
    )
    .execute(&state.db)
    .await?;

    let mut csrf_bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut csrf_bytes);
    let csrf_token = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, csrf_bytes);

    let session_cookie = Cookie::build((SESSION_COOKIE_NAME, session_token))
        .http_only(true)
        .secure(true)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time::Duration::seconds(state.config.web_session_ttl_secs))
        .build()
        .into_owned();

    // The CSRF cookie is intentionally NOT HttpOnly: the web app's JS reads
    // it and echoes it back in the X-CSRF-Token header (double-submit
    // pattern, docs/security.md §2).
    let csrf_cookie = Cookie::build((CSRF_COOKIE_NAME, csrf_token))
        .http_only(false)
        .secure(true)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time::Duration::seconds(state.config.web_session_ttl_secs))
        .build()
        .into_owned();

    Ok((session_cookie, csrf_cookie))
}

pub async fn revoke_session(state: &AppState, raw_token: &str) -> anyhow::Result<()> {
    let session_hash = hash_token(raw_token);
    state.web_session_cache.remove(&session_hash);
    sqlx::query!(
        "UPDATE web_sessions SET revoked_at = now() WHERE session_hash = $1",
        session_hash
    )
    .execute(&state.db)
    .await?;
    state.web_session_cache.remove(&session_hash);
    Ok(())
}

pub fn expired_cookie(name: &'static str) -> Cookie<'static> {
    Cookie::build((name, ""))
        .path("/")
        .max_age(time::Duration::seconds(0))
        .build()
        .into_owned()
}
