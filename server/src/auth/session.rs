use axum_extra::extract::cookie::{Cookie, SameSite};
use chrono::{Duration, Utc};
use uuid::Uuid;

use crate::crypto::{generate_opaque_token, hash_token, random_urlsafe_token};
use crate::state::AppState;

use super::extractors::{write_web_session_cache_entry, CSRF_COOKIE_NAME, SESSION_COOKIE_NAME};

/// Create a new web session for `user_id`, persist its hash, and return the
/// (session_cookie, csrf_cookie) pair to attach to the login response.
pub async fn create_session(
    state: &AppState,
    user_id: Uuid,
    user_agent: Option<String>,
    ip_address: Option<String>,
) -> anyhow::Result<(Cookie<'static>, Cookie<'static>)> {
    let (session_token, session_hash) = generate_opaque_token();

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

    let csrf_token = random_urlsafe_token::<24>();

    let session_cookie = Cookie::build((SESSION_COOKIE_NAME, session_token))
        .http_only(true)
        .secure(true)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time::Duration::seconds(state.config.web_session_ttl_secs))
        .build()
        .into_owned();

    // Not HttpOnly: the web app reads it and sends it back in X-CSRF-Token
    // (double-submit, docs/security.md §2).
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
    sqlx::query!(
        "UPDATE web_sessions SET revoked_at = now() WHERE session_hash = $1",
        session_hash
    )
    .execute(&state.db)
    .await?;
    // Write a tombstone instead of removing the entry. A slower in-flight
    // auth check could otherwise re-cache the revoked session.
    write_web_session_cache_entry(
        &state.web_session_cache,
        session_hash,
        std::time::Instant::now(),
        None,
    );
    Ok(())
}

pub fn expired_cookie(name: &'static str) -> Cookie<'static> {
    Cookie::build((name, ""))
        .path("/")
        .max_age(time::Duration::seconds(0))
        .build()
        .into_owned()
}
