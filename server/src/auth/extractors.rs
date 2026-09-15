use std::time::{Duration, Instant};

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum_extra::extract::CookieJar;

pub use crate::auth::model::{AuthenticatedDevice, AuthenticatedUser};
use crate::crypto::hash_token;
use crate::error::AppError;
use crate::state::AppState;

pub const SESSION_COOKIE_NAME: &str = "helixsync_session";
pub const CSRF_COOKIE_NAME: &str = "helixsync_csrf";
pub const CSRF_HEADER_NAME: &str = "x-csrf-token";

/// Matches `sync::routes::STATS_CACHE_TTL`'s tradeoff, but for a
/// security-sensitive value rather than a purely informational one: kept
/// short because a stale "active" entry means a revoked device keeps being
/// accepted for up to this long on any path that revokes a device without
/// going through `devices::routes::revoke_device` (which proactively
/// overwrites the cache entry instead of waiting on the TTL).
pub const DEVICE_REVOCATION_CACHE_TTL: Duration = Duration::from_secs(30);

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
        .await?
        .ok_or(AppError::Unauthorized)?;

        Ok(AuthenticatedUser {
            user_id: row.user_id,
            email: row.email,
        })
    }
}

/// Requires a valid session (via `AuthenticatedUser`) AND a matching
/// double-submit CSRF token (cookie value == header value) per
/// docs/security.md §2. Use this extractor (instead of `AuthenticatedUser`
/// directly) on any state-changing web-session-authenticated route.
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
            .ok_or(AppError::Unauthorized)
            .map_err(|_| AppError::Unauthorized)?;

        let claims = crate::auth::tokens::verify_device_access_token(
            &state.config.jwt_signing_key,
            token,
        )
        .map_err(|_| AppError::Unauthorized)?;

        let cached = state
            .device_revocation_cache
            .get(&claims.sub)
            .filter(|entry| entry.0.elapsed() < DEVICE_REVOCATION_CACHE_TTL)
            .map(|entry| entry.1);

        let active = match cached {
            Some(active) => active,
            None => {
                let active = sqlx::query_scalar!(
                    "SELECT revoked_at IS NULL FROM devices WHERE id = $1 AND user_id = $2",
                    claims.sub,
                    claims.user_id
                )
                .fetch_optional(&state.db)
                .await?
                .flatten()
                .unwrap_or(false);

                state
                    .device_revocation_cache
                    .insert(claims.sub, (Instant::now(), active));

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

/// Accepts either a device bearer token or a web session cookie, resolving
/// to just the owning `user_id`. Used for read endpoints (e.g. sync
/// settings) that both the extension (device credential) and the web
/// dashboard (session cookie) need to call. For mutating endpoints reachable
/// from both, use `AnyAuthorizedMutator` instead — it applies the CSRF
/// check only on the cookie path, per docs/security.md §2 (bearer-token
/// requests aren't cookie-driven, so CSRF doesn't apply to them).
pub struct AnyAuthenticatedUser {
    pub user_id: uuid::Uuid,
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AnyAuthenticatedUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if let Ok(device) = AuthenticatedDevice::from_request_parts(parts, state).await {
            return Ok(AnyAuthenticatedUser {
                user_id: device.user_id,
            });
        }
        let user = AuthenticatedUser::from_request_parts(parts, state).await?;
        Ok(AnyAuthenticatedUser {
            user_id: user.user_id,
        })
    }
}

/// Authorizes a mutating request from either the extension (device bearer
/// token — no CSRF check applies) or the web dashboard (session cookie —
/// CSRF check enforced, docs/security.md §2). Prefer `CsrfProtectedUser`
/// directly for endpoints the extension should never reach (e.g. device
/// revocation from the dashboard); use this only where both callers are
/// legitimate, such as sync settings (the dashboard and the extension's
/// options both expose the same toggles).
pub struct AnyAuthorizedMutator {
    pub user_id: uuid::Uuid,
}

#[axum::async_trait]
impl FromRequestParts<AppState> for AnyAuthorizedMutator {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if let Ok(device) = AuthenticatedDevice::from_request_parts(parts, state).await {
            return Ok(AnyAuthorizedMutator {
                user_id: device.user_id,
            });
        }
        let CsrfProtectedUser(user) = CsrfProtectedUser::from_request_parts(parts, state).await?;
        Ok(AnyAuthorizedMutator {
            user_id: user.user_id,
        })
    }
}
