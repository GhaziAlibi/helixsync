use std::time::Duration;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::config::Config;

/// How long a request waits for a free connection before giving up.
/// Previously set to 3s, which was too aggressive under burst traffic and
/// concurrent background compaction sweeps (e.g. snapshot downloads and multi-device
/// sync batches), causing transient checkout timeouts and 500 errors. 15s provides
/// sufficient resilience to ride out temporary pool contention while still failing fast
/// well before reverse proxy timeouts (typically 30-60s).
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(15);

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
