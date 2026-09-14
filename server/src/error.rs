use std::time::Duration;

use axum::http::header::RETRY_AFTER;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

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
    // Carries how long the client should wait before retrying, so
    // `into_response` can attach a `Retry-After` header instead of leaving
    // the client to guess/poll blindly (see rate_limit.rs::enforce).
    #[error("rate limited")]
    RateLimited(Duration),
    #[error("protocol version too old")]
    ProtocolTooOld,
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
            AppError::Validation(_) => (StatusCode::BAD_REQUEST, "validation_error", self.to_string()),
            AppError::Conflict(reason) => (StatusCode::CONFLICT, reason.as_str(), self.to_string()),
            AppError::RateLimited(_) => (StatusCode::TOO_MANY_REQUESTS, "rate_limited", self.to_string()),
            AppError::ProtocolTooOld => (StatusCode::UPGRADE_REQUIRED, "protocol_too_old", self.to_string()),
            AppError::Database(e) => {
                tracing::error!(error = %e, "database error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error", "internal error".to_string())
            }
            AppError::Internal(e) => {
                tracing::error!(error = %e, "internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error", "internal error".to_string())
            }
        };

        let mut response = (status, Json(json!({ "error": code, "message": message }))).into_response();

        // HTTP's Retry-After is specified in whole seconds (or an HTTP
        // date) — round up rather than truncate so a client never retries
        // a moment before a token has actually refilled.
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
