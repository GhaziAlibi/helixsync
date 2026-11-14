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

/// Versions of every migration this binary ships, oldest first.
pub fn known_migration_versions() -> Vec<i64> {
    sqlx::migrate!("./migrations")
        .iter()
        .map(|m| m.version)
        .collect()
}

/// A fixed list of migrations, so a database can be brought to an older
/// schema than this binary's latest.
#[derive(Debug)]
struct MigrationList(Vec<sqlx::migrate::Migration>);

impl<'s> sqlx::migrate::MigrationSource<'s> for MigrationList {
    fn resolve(
        self,
    ) -> futures::future::BoxFuture<
        's,
        Result<Vec<sqlx::migrate::Migration>, sqlx::error::BoxDynError>,
    > {
        Box::pin(async move { Ok(self.0) })
    }
}

/// Applies the migrations up to and including `version`, and no later one.
/// Used by `restore-backup` to rebuild the schema a backup was taken with.
pub async fn run_migrations_up_to(pool: &PgPool, version: i64) -> anyhow::Result<()> {
    let upto: Vec<_> = sqlx::migrate!("./migrations")
        .iter()
        .filter(|m| m.version <= version)
        .cloned()
        .collect();
    sqlx::migrate::Migrator::new(MigrationList(upto))
        .await?
        .run(pool)
        .await?;
    Ok(())
}
