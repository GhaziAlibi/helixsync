use std::time::Duration;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::config::Config;

/// How long a request waits for a free connection before giving up. Short
/// and fixed (rather than sqlx's 30s default) so pool contention under load
/// surfaces as a fast, explicit error instead of a request hanging near — or
/// past — a reverse proxy's own timeout.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(3);

/// Recycle connections that have sat idle this long, so the pool shrinks
/// back down after a burst of background work instead of holding open
/// connections Postgres has to keep resources for.
const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Force even continuously-busy connections to be replaced after this long,
/// as a safety net against long-lived connections accumulating state or
/// outliving a load balancer/Postgres-side connection recycle.
const MAX_LIFETIME: Duration = Duration::from_secs(30 * 60);

pub async fn connect(config: &Config) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(config.database_max_connections)
        .acquire_timeout(ACQUIRE_TIMEOUT)
        .idle_timeout(IDLE_TIMEOUT)
        .max_lifetime(MAX_LIFETIME)
        .connect(&config.database_url)
        .await?;
    Ok(pool)
}

pub async fn run_migrations(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}
