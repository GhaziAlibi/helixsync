use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

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
    let shutdown_deadline = Duration::from_secs(config.shutdown_deadline_secs);

    let state = AppState {
        db,
        config: Arc::new(config),
        rate_limiter: Arc::new(RateLimiter::new()),
        ws_registry: Arc::new(ConnectionRegistry::new()),
        last_seen_cache: Arc::new(dashmap::DashMap::new()),
        device_revocation_cache: Arc::new(dashmap::DashMap::new()),
        web_session_cache: Arc::new(dashmap::DashMap::new()),
        upload_locks: Arc::new(dashmap::DashMap::new()),
        snapshot_semaphore: Arc::new(tokio::sync::Semaphore::new(
            helixsync_server::sync::routes::SNAPSHOT_CONCURRENCY_LIMIT,
        )),
        argon2_semaphore: Arc::new(tokio::sync::Semaphore::new(
            helixsync_server::crypto::ARGON2_CONCURRENCY_LIMIT,
        )),
    };

    helixsync_server::sync::compaction::spawn(state.clone());
    helixsync_server::housekeeping::spawn(state.clone());
    helixsync_server::middleware::rate_limit::spawn_sweeper(state.rate_limiter.clone());
    helixsync_server::auth::extractors::spawn_web_session_cache_sweeper(
        state.web_session_cache.clone(),
    );

    let router = app(state);

    let addr: SocketAddr = bind_addr.parse()?;
    tracing::info!(%addr, "starting HelixSync server");

    let listener = tokio::net::TcpListener::bind(addr).await?;

    // Graceful shutdown has no deadline of its own, so one open connection
    // could stall it for up to an hour. We race it against a deadline.
    // A `watch` channel is used because late listeners still see the signal.
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = shutdown_tx.send(true);
    });

    let mut graceful_rx = shutdown_rx.clone();
    let graceful_shutdown_future = async move {
        let _ = graceful_rx.changed().await;
    };

    let mut deadline_rx = shutdown_rx.clone();
    let deadline_future = async move {
        let _ = deadline_rx.changed().await;
        tokio::time::sleep(shutdown_deadline).await;
    };

    let serve_future = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(graceful_shutdown_future);

    tokio::select! {
        result = serve_future => {
            result?;
        }
        _ = deadline_future => {
            tracing::warn!(
                deadline_secs = shutdown_deadline.as_secs(),
                "graceful shutdown deadline exceeded, forcing process exit with connections still draining"
            );
        }
    }

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
