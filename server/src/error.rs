use std::time::Duration;

use axum::http::header::RETRY_AFTER;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// Snapshot URL returned on `cursor_too_old` / `cursor_invalid`
/// (docs/protocol.md §10.1, §10.3). Update this if the snapshot route moves.
const CURSOR_TOO_OLD_SNAPSHOT_URL: &str = "/api/v1/sync/snapshot";

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("validation error: {0}")]
    Validation(String),
    #[error("conflict: {0}")]
    Conflict(String),
    // How long to wait; sent as the `Retry-After` header.
    #[error("rate limited")]
    RateLimited(Duration),
    #[error("protocol version too old")]
    ProtocolTooOld,
    // Timed out waiting for a server-side resource (e.g. the upload lock).
    // 503, not 429: the client did nothing wrong and should just retry.
    #[error("server busy, try again shortly")]
    Busy,
    #[error("database error")]
    Database(#[from] sqlx::Error),
    #[error("internal error")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized", self.to_string()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden", self.to_string()),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not_found", self.to_string()),
            AppError::Validation(_) => (
                StatusCode::BAD_REQUEST,
                "validation_error",
                self.to_string(),
            ),
            AppError::Conflict(reason) => (StatusCode::CONFLICT, reason.as_str(), self.to_string()),
            AppError::RateLimited(_) => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                self.to_string(),
            ),
            AppError::ProtocolTooOld => (
                StatusCode::UPGRADE_REQUIRED,
                "protocol_too_old",
                self.to_string(),
            ),
            AppError::Busy => (StatusCode::SERVICE_UNAVAILABLE, "busy", self.to_string()),
            AppError::Database(e) => {
                tracing::error!(error = %e, "database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "internal error".to_string(),
                )
            }
            AppError::Internal(e) => {
                tracing::error!(error = %e, "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "internal error".to_string(),
                )
            }
        };

        // Cursor errors return `snapshotUrl` instead of `message` so the
        // client knows to resync from a snapshot (docs/protocol.md §10.1).
        let mut response = if matches!(code, "cursor_too_old" | "cursor_invalid") {
            (
                status,
                Json(json!({ "error": code, "snapshotUrl": CURSOR_TOO_OLD_SNAPSHOT_URL })),
            )
                .into_response()
        } else {
            (status, Json(json!({ "error": code, "message": message }))).into_response()
        };

        // Retry-After is in whole seconds; round up so clients don't retry early.
        if let AppError::RateLimited(retry_after) = &self {
            let seconds = (retry_after.as_millis() as u64).div_ceil(1000).max(1);
            if let Ok(value) = axum::http::HeaderValue::from_str(&seconds.to_string()) {
                response.headers_mut().insert(RETRY_AFTER, value);
            }
        }

        response
    }
}

pub type AppResult<T> = Result<T, AppError>;
