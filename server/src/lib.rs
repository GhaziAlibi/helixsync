pub mod audit;
pub mod auth;
pub mod config;
pub mod crypto;
pub mod database;
pub mod devices;
pub mod error;
pub mod middleware;
pub mod state;
pub mod sync;
pub mod websocket;

use std::net::SocketAddr;

use axum::http::{header, HeaderValue, Method};
use axum::routing::get;
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use state::AppState;

/// Build the full HelixSync HTTP application from a ready `AppState`. Shared
/// by the real binary (`main.rs`) and integration tests so route wiring is
/// never duplicated or allowed to drift between the two.
pub fn app(state: AppState) -> Router {
    let mut cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            "x-csrf-token".parse().unwrap(),
            "x-protocol-version".parse().unwrap(),
        ])
        .allow_credentials(true);

    for origin in &state.config.cors_allowed_origins {
        if let Ok(value) = HeaderValue::from_str(origin) {
            cors = cors.allow_origin(value);
        }
    }

    let api_v1 = Router::new()
        .nest("/auth", auth::routes::router())
        .nest("/devices", devices::routes::router())
        .nest("/sync", sync::routes::router())
        .route("/ws", get(websocket::ws_handler))
        .route("/version", get(version));

    Router::new()
        .nest("/api/v1", api_v1)
        .route("/healthz", get(healthz))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}

pub fn into_make_service(app: Router) -> axum::extract::connect_info::IntoMakeServiceWithConnectInfo<Router, SocketAddr> {
    app.into_make_service_with_connect_info::<SocketAddr>()
}

async fn healthz() -> &'static str {
    "ok"
}

async fn version(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "apiVersion": state.config.api_version,
        "protocolVersion": state.config.protocol_version,
        "minimumSupportedProtocolVersion": state.config.minimum_supported_protocol_version,
    }))
}
