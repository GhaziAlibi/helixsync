use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum_extra::extract::CookieJar;
use uuid::Uuid;

pub use crate::auth::model::{AuthenticatedDevice, AuthenticatedUser};
use crate::crypto::hash_token;
use crate::error::AppError;
use crate::state::{AppState, DeviceRevocationCache, WebSessionCache};

pub const SESSION_COOKIE_NAME: &str = "helixsync_session";
pub const CSRF_COOKIE_NAME: &str = "helixsync_csrf";
pub const CSRF_HEADER_NAME: &str = "x-csrf-token";

/// Kept short: a stale entry lets a revoked device through until it expires
/// (unless `revoke_device` updated the cache directly).
pub const DEVICE_REVOCATION_CACHE_TTL: Duration = Duration::from_secs(30);
pub const WEB_SESSION_CACHE_TTL: Duration = Duration::from_secs(30);

/// How often expired entries are swept from `web_session_cache`.
const WEB_SESSION_CACHE_SWEEP_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Removes entries older than `WEB_SESSION_CACHE_TTL`. Expired entries are
/// never read again, and the map grows by one entry per login, so without
/// this it would grow forever. Public so tests can run one pass.
pub fn sweep_web_session_cache(cache: &WebSessionCache) {
    cache.retain(|_, (cached_at, _)| cached_at.elapsed() < WEB_SESSION_CACHE_TTL);
}

/// Starts the background sweep. Call once from `main.rs`.
pub fn spawn_web_session_cache_sweeper(cache: Arc<WebSessionCache>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(WEB_SESSION_CACHE_SWEEP_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            sweep_web_session_cache(&cache);
        }
    });
}

/// Writes a cache entry, keeping whichever value has the later `as_of`.
/// All writers use this so a stale read can't overwrite a revocation.
pub fn write_web_session_cache_entry(
    cache: &WebSessionCache,
    session_hash: String,
    as_of: Instant,
    cached: Option<(Uuid, String)>,
) {
    cache
        .entry(session_hash)
        .and_modify(|entry| {
            if as_of > entry.0 {
                *entry = (as_of, cached.clone());
            }
        })
        .or_insert((as_of, cached));
}

/// The cached active flag for `device_id`, if cached within
/// `DEVICE_REVOCATION_CACHE_TTL`.
pub fn cached_device_active(cache: &DeviceRevocationCache, device_id: Uuid) -> Option<bool> {
    cache
        .get(&device_id)
        .filter(|entry| entry.0.elapsed() < DEVICE_REVOCATION_CACHE_TTL)
        .map(|entry| entry.1)
}

/// Same as `write_web_session_cache_entry`, for `device_revocation_cache`.
pub fn write_device_revocation_cache_entry(
    cache: &DeviceRevocationCache,
    device_id: Uuid,
    as_of: Instant,
    active: bool,
) {
    cache
        .entry(device_id)
        .and_modify(|entry| {
            if as_of > entry.0 {
                *entry = (as_of, active);
            }
        })
        .or_insert((as_of, active));
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AuthenticatedUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar
            .get(SESSION_COOKIE_NAME)
            .map(|c| c.value().to_string())
            .ok_or(AppError::Unauthorized)?;
        let session_hash = hash_token(&token);

        if let Some(entry) = state.web_session_cache.get(&session_hash) {
            if entry.0.elapsed() < WEB_SESSION_CACHE_TTL {
                return match &entry.1 {
                    Some((user_id, email)) => Ok(AuthenticatedUser {
                        user_id: *user_id,
                        email: email.clone(),
                    }),
                    // Tombstone: session was revoked or logged out.
                    None => Err(AppError::Unauthorized),
                };
            }
        }

        // Taken before the DB query so a racing revocation always wins.
        let read_started_at = Instant::now();

        let row = sqlx::query!(
            r#"
            SELECT u.id as "user_id!", u.email as "email!"
            FROM web_sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.session_hash = $1
              AND s.revoked_at IS NULL
              AND s.expires_at > now()
            "#,
            session_hash
        )
        .fetch_optional(&state.db)
        .await?;

        let row = match row {
            Some(row) => row,
            None => {
                write_web_session_cache_entry(
                    &state.web_session_cache,
                    session_hash,
                    read_started_at,
                    None,
                );
                return Err(AppError::Unauthorized);
            }
        };

        write_web_session_cache_entry(
            &state.web_session_cache,
            session_hash,
            read_started_at,
            Some((row.user_id, row.email.clone())),
        );

        Ok(AuthenticatedUser {
            user_id: row.user_id,
            email: row.email,
        })
    }
}

/// A session user whose CSRF cookie matches the header (docs/security.md §2).
/// Use on every state-changing web route.
pub struct CsrfProtectedUser(pub AuthenticatedUser);

#[axum::async_trait]
impl FromRequestParts<AppState> for CsrfProtectedUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = AuthenticatedUser::from_request_parts(parts, state).await?;

        let jar = CookieJar::from_headers(&parts.headers);
        let cookie_value = jar
            .get(CSRF_COOKIE_NAME)
            .map(|c| c.value().to_string())
            .ok_or(AppError::Forbidden)?;
        let header_value = parts
            .headers
            .get(CSRF_HEADER_NAME)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Forbidden)?;

        if cookie_value.is_empty() || cookie_value != header_value {
            return Err(AppError::Forbidden);
        }

        Ok(CsrfProtectedUser(user))
    }
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AuthenticatedDevice {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let auth_header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;

        let token = auth_header
            .strip_prefix("Bearer ")
            .ok_or(AppError::Unauthorized)?;

        let claims =
            crate::auth::tokens::verify_device_access_token(&state.config.jwt_signing_key, token)
                .map_err(|_| AppError::Unauthorized)?;

        let active = match cached_device_active(&state.device_revocation_cache, claims.sub) {
            Some(active) => active,
            None => {
                // Taken before the DB query so a racing revocation always wins.
                let read_started_at = Instant::now();

                let active = sqlx::query_scalar!(
                    "SELECT revoked_at IS NULL FROM devices WHERE id = $1 AND user_id = $2",
                    claims.sub,
                    claims.user_id
                )
                .fetch_optional(&state.db)
                .await?
                .flatten()
                .unwrap_or(false);

                write_device_revocation_cache_entry(
                    &state.device_revocation_cache,
                    claims.sub,
                    read_started_at,
                    active,
                );

                active
            }
        };

        if !active {
            return Err(AppError::Unauthorized);
        }

        Ok(AuthenticatedDevice {
            device_id: claims.sub,
            user_id: claims.user_id,
        })
    }
}

/// Accepts a device token or a session cookie. For read endpoints used by
/// both the extension and the dashboard. For writes, use `AnyAuthorizedMutator`.
pub struct AnyAuthenticatedUser {
    pub user_id: uuid::Uuid,
    /// `device:<id>` for device tokens (one bucket per device) or
    /// `user:<id>` for session cookies.
    pub rate_limit_key: String,
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AnyAuthenticatedUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        match AuthenticatedDevice::from_request_parts(parts, state).await {
            Ok(device) => {
                return Ok(AnyAuthenticatedUser {
                    user_id: device.user_id,
                    rate_limit_key: format!("device:{}", device.device_id),
                });
            }
            Err(AppError::Unauthorized) => {}
            Err(err) => return Err(err),
        }
        let user = AuthenticatedUser::from_request_parts(parts, state).await?;
        Ok(AnyAuthenticatedUser {
            user_id: user.user_id,
            rate_limit_key: format!("user:{}", user.user_id),
        })
    }
}

/// Accepts a device token, or a session cookie with a valid CSRF token.
/// Only for writes both the extension and dashboard may make (e.g. settings);
/// otherwise use `CsrfProtectedUser`.
pub struct AnyAuthorizedMutator {
    pub user_id: uuid::Uuid,
    /// See `AnyAuthenticatedUser::rate_limit_key`.
    pub rate_limit_key: String,
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AnyAuthorizedMutator {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        match AuthenticatedDevice::from_request_parts(parts, state).await {
            Ok(device) => {
                return Ok(AnyAuthorizedMutator {
                    user_id: device.user_id,
                    rate_limit_key: format!("device:{}", device.device_id),
                });
            }
            Err(AppError::Unauthorized) => {}
            Err(err) => return Err(err),
        }
        let CsrfProtectedUser(user) = CsrfProtectedUser::from_request_parts(parts, state).await?;
        Ok(AnyAuthorizedMutator {
            user_id: user.user_id,
            rate_limit_key: format!("user:{}", user.user_id),
        })
    }
}
