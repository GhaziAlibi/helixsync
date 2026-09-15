use std::net::SocketAddr;
use std::sync::Arc;

use helixsync_server::config::Config;
use helixsync_server::middleware::rate_limit::RateLimiter;
use helixsync_server::state::AppState;
use helixsync_server::websocket::ConnectionRegistry;
use helixsync_server::{app, database};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env()?;

    if !config.require_encryption {
        tracing::warn!(
            "HelixSync is running WITHOUT end-to-end encryption enforcement (REQUIRE_ENCRYPTION=false) — this deployment is NOT production-ready. See docs/encryption.md."
        );
    }

    let db = database::connect(&config).await?;
    database::run_migrations(&db).await?;
    tracing::info!("database migrations applied");

    let bind_addr = config.bind_addr.clone();

    let state = AppState {
        db,
        config: Arc::new(config),
        rate_limiter: Arc::new(RateLimiter::new()),
        ws_registry: Arc::new(ConnectionRegistry::new()),
        last_seen_cache: Arc::new(dashmap::DashMap::new()),
        device_revocation_cache: Arc::new(dashmap::DashMap::new()),
        web_session_cache: Arc::new(dashmap::DashMap::new()),
    };

    helixsync_server::sync::compaction::spawn(state.clone());
    helixsync_server::housekeeping::spawn(state.clone());
    helixsync_server::middleware::rate_limit::spawn_sweeper(state.rate_limiter.clone());

    let router = app(state);

    let addr: SocketAddr = bind_addr.parse()?;
    tracing::info!(%addr, "starting HelixSync server");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("shutdown signal received, draining connections");
}
