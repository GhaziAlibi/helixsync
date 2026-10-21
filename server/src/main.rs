use std::io::Write;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use helixsync_server::auth::account::delete_user_by_email;
use helixsync_server::auth::normalize_email;
use helixsync_server::config::{Config, LogFormat};
use helixsync_server::middleware::rate_limit::RateLimiter;
use helixsync_server::state::AppState;
use helixsync_server::websocket::ConnectionRegistry;
use helixsync_server::{app, database};

/// How long shutdown waits for in-use database connections to be returned
/// before exiting anyway (e.g. a compaction pass still running).
const POOL_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();

    init_tracing(LogFormat::from_env()?);

    let config = Config::from_env()?;

    // Operator commands run once against the database and exit, without
    // starting the server.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        return run_command(&config, &args).await;
    }

    if !config.require_encryption {
        tracing::warn!(
            "HelixSync is running WITHOUT end-to-end encryption enforcement (REQUIRE_ENCRYPTION=false) — this deployment is NOT production-ready. See docs/encryption.md."
        );
    }

    let db = database::connect(&config).await?;
    database::run_migrations(&db).await?;
    tracing::info!("database migrations applied");

    let addr = config.bind_addr;
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

    let db = state.db.clone();
    let router = app(state);

    tracing::info!(%addr, version = env!("CARGO_PKG_VERSION"), "starting HelixSync server");

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
            // Hands connections back to Postgres cleanly instead of dropping
            // them mid-session. Not done after the deadline below: requests
            // still running there hold connections it would wait for.
            if tokio::time::timeout(POOL_CLOSE_TIMEOUT, db.close()).await.is_err() {
                tracing::warn!("database connections still in use at exit");
            }
            tracing::info!("shutdown complete");
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

/// `RUST_LOG` picks what is logged (default `info`); `LOG_FORMAT` how.
fn init_tracing(format: LogFormat) {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let subscriber = tracing_subscriber::fmt().with_env_filter(filter);
    match format {
        LogFormat::Text => subscriber.init(),
        LogFormat::Json => subscriber.json().init(),
    }
}

async fn run_command(config: &Config, args: &[String]) -> anyhow::Result<()> {
    match args {
        [command, email] if command == "delete-account" => {
            delete_account_command(config, email).await
        }
        _ => anyhow::bail!("usage: helixsync-server [delete-account <email>]"),
    }
}

/// `helixsync-server delete-account <email>`: removes an account whose owner
/// lost both the password and the recovery code, so the email can register
/// again (docs/security.md §11). The server never sends email, so the
/// operator is the one who checks who's asking. Asks for confirmation first.
async fn delete_account_command(config: &Config, email: &str) -> anyhow::Result<()> {
    let email = normalize_email(email);
    print!(
        "Permanently delete the account {email} and all of its synced data? Type \"delete\" to confirm: "
    );
    std::io::stdout().flush()?;
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer)?;
    if answer.trim() != "delete" {
        anyhow::bail!("not confirmed, nothing was deleted");
    }

    let db = database::connect(config).await?;
    let Some(deleted) = delete_user_by_email(&db, &email).await? else {
        anyhow::bail!("no account uses {email}");
    };
    println!(
        "Deleted {email}: {} device(s) and {} web session(s) stop working within 30 seconds.",
        deleted.device_ids.len(),
        deleted.session_hashes.len()
    );
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
