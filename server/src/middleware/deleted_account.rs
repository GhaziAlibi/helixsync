// Answers 401, not 500, to a request that was already past authentication
// when its account was deleted.
//
// `DELETE /auth/account` commits the delete and then purges the auth caches.
// A request whose auth check passed before that (from the 30s cache, or from
// the database just before the commit) then reaches a handler whose query
// finds no row (`fetch_one`) or breaks a foreign key (an insert). Every
// handler has that window, so it is handled once here instead of in each one.
use std::sync::{Arc, OnceLock};

use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use uuid::Uuid;

use crate::error::AppError;
use crate::state::AppState;

/// The user the request authenticated as. Set by the auth extractors.
#[derive(Clone, Default)]
pub struct RequestUser(Arc<OnceLock<Uuid>>);

/// Put on a 500 by `AppError::into_response` when the database error could
/// come from a row deleted mid-request: a missing row or a foreign-key
/// violation. Carries the error text, which this middleware logs unless the
/// account turns out to be gone.
#[derive(Clone)]
pub struct MissingRowError(pub String);

/// Called by the auth extractors once a request is authenticated.
pub fn record_request_user(parts: &Parts, user_id: Uuid) {
    if let Some(slot) = parts.extensions.get::<RequestUser>() {
        let _ = slot.0.set(user_id);
    }
}

/// Whether a database error could mean the row was deleted mid-request.
pub fn is_missing_row_error(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::RowNotFound => true,
        sqlx::Error::Database(db) => db.is_foreign_key_violation(),
        _ => false,
    }
}

pub async fn deleted_account_guard(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let slot = RequestUser::default();
    request.extensions_mut().insert(slot.clone());

    let response = next.run(request).await;

    if response.status() != StatusCode::INTERNAL_SERVER_ERROR {
        return response;
    }
    let Some(MissingRowError(error)) = response.extensions().get::<MissingRowError>().cloned()
    else {
        return response;
    };

    if let Some(user_id) = slot.0.get().copied() {
        let exists =
            sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)")
                .bind(user_id)
                .fetch_one(&state.db)
                .await;
        if let Ok(false) = exists {
            tracing::info!(
                %user_id,
                error = %error,
                "request raced the deletion of its account; answering 401"
            );
            return AppError::Unauthorized.into_response();
        }
    }

    tracing::error!(error = %error, "database error");
    response
}
