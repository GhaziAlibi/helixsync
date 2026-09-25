pub mod audit;
pub mod auth;
pub mod config;
pub mod crypto;
pub mod database;
pub mod devices;
pub mod error;
pub mod housekeeping;
pub mod middleware;
pub mod state;
pub mod sync;
pub mod websocket;

use std::time::Duration;

use axum::extract::State;
use axum::http::{header, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use state::AppState;

/// Builds the HTTP app. Shared by `main.rs` and the integration tests.
pub fn app(state: AppState) -> Router {
    let allowed_origins: Vec<HeaderValue> = state
        .config
        .cors_allowed_origins
        .iter()
        .filter_map(|origin| HeaderValue::from_str(origin).ok())
        .collect();

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            HeaderName::from_static(auth::extractors::CSRF_HEADER_NAME),
            HeaderName::from_static(sync::routes::PROTOCOL_VERSION_HEADER),
        ])
        .allow_credentials(true)
        .allow_origin(AllowOrigin::list(allowed_origins));

    // Register and login responses carry the CSRF token, so they must not be
    // compressed (BREACH). Compression is layered before the merge so it only
    // wraps the routes above.
    let compressible_api_v1 = Router::new()
        .nest("/auth", auth::routes::router())
        .nest("/devices", devices::routes::router())
        .nest("/sync", sync::routes::router())
        .route("/ws", get(websocket::ws_handler))
        .route("/version", get(version))
        // Snapshots can be 20-60MB of JSON.
        .layer(CompressionLayer::new());

    let uncompressed_api_v1 = Router::new().nest("/auth", auth::routes::sensitive_router());

    let api_v1 = compressible_api_v1.merge(uncompressed_api_v1);

    // Caps how long a request may run. This layer returns a plain 408
    // response, so no `HandleErrorLayer` is needed.
    let timeout_layer = TimeoutLayer::with_status_code(
        StatusCode::REQUEST_TIMEOUT,
        Duration::from_secs(state.config.request_timeout_secs),
    );

    Router::new()
        .nest("/api/v1", api_v1)
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .layer(timeout_layer)
        .with_state(state)
}

/// Liveness check. Has no dependencies on purpose; see `readyz` for the DB check.
async fn healthz() -> &'static str {
    "ok"
}

/// How long `readyz` waits for the DB. Short so health checks fail fast.
const READYZ_DB_TIMEOUT: Duration = Duration::from_secs(2);

/// Readiness check: runs `SELECT 1` so a load balancer can skip an instance
/// whose database is unreachable.
async fn readyz(State(state): State<AppState>) -> Response {
    let pool = json!({ "size": state.db.size(), "idle": state.db.num_idle() });
    let query = sqlx::query("SELECT 1").execute(&state.db);

    match tokio::time::timeout(READYZ_DB_TIMEOUT, query).await {
        Ok(Ok(_)) => (
            StatusCode::OK,
            Json(json!({ "status": "ok", "pool": pool })),
        )
            .into_response(),
        Ok(Err(err)) => {
            tracing::error!(error = %err, "readyz: database query failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "error", "pool": pool })),
            )
                .into_response()
        }
        Err(_) => {
            tracing::error!(timeout = ?READYZ_DB_TIMEOUT, "readyz: database query timed out");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "timeout", "pool": pool })),
            )
                .into_response()
        }
    }
}

async fn version(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "apiVersion": state.config.api_version,
        "protocolVersion": state.config.protocol_version,
        "minimumSupportedProtocolVersion": state.config.minimum_supported_protocol_version,
    }))
}
