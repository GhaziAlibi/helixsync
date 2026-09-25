use std::time::Duration;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::config::Config;

/// How long a request waits for a free connection. Long enough to ride out
/// bursts, short enough to fail before the reverse proxy times out.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(15);

/// Close idle connections so the pool shrinks after a burst.
const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Replace connections after this long, even busy ones.
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
