// Restores a backup file over the database. An operator command only: the
// server has no endpoint for it, and it refuses to run while the server is
// connected.
//
// The order is what keeps data safe:
//   1. the whole file is read and checked (decryption, zstd checksum, header,
//      row counts) before anything is touched;
//   2. if the database has data, the operator confirms and a safety backup
//      of it is written; if that fails, nothing is changed;
//   3. the data is loaded. Same schema version: one transaction, so any
//      failure leaves the current data as it was. Older backup: the schema
//      is rebuilt first, which is not atomic; the safety backup covers it.
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context};
use chrono::{DateTime, Utc};
use sqlx::postgres::PgConnectOptions;
use sqlx::{Connection, PgConnection, PgPool, Postgres, Transaction};
use tokio::sync::mpsc;

use crate::backup::catalog::{self, Catalog, MIGRATIONS_TABLE};
use crate::backup::dump;
use crate::backup::files::{self, Kind};
use crate::backup::pipeline;
use crate::backup::script::{self, Item, Summary};
use crate::config::BackupConfig;
use crate::database;

/// Chunks queued between the file reader and the database.
const CHANNEL_DEPTH: usize = 8;

/// What the operator is shown before confirming.
#[derive(Debug)]
pub struct Preview {
    pub file: PathBuf,
    pub summary: Summary,
    /// Rows now in the database, per table: what the restore replaces.
    pub current: Vec<(String, i64)>,
}

#[derive(Debug)]
pub struct Report {
    pub file: PathBuf,
    pub summary: Summary,
    /// The copy of the replaced data, when there was any.
    pub safety_backup: Option<PathBuf>,
    /// True when the schema was rebuilt (a backup of an older version, or an
    /// empty database), false for the all-or-nothing path.
    pub rebuilt_schema: bool,
}

/// Fails if any other client is connected to the database, i.e. the server
/// is still running. `options` opens its own connection, so this is not
/// confused by connections of the caller's pool.
pub async fn ensure_no_other_sessions(options: &PgConnectOptions) -> anyhow::Result<()> {
    let mut conn = PgConnection::connect_with(options)
        .await
        .context("could not connect to the database")?;
    let others: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND backend_type = 'client backend'",
    )
    .fetch_one(&mut conn)
    .await
    .context("could not look for other connections")?;
    let _ = conn.close().await;
    if others > 0 {
        bail!(
            "{others} other connection(s) to the database are open: stop the HelixSync server first (for example `docker compose stop server`), then run this again"
        );
    }
    Ok(())
}

/// Reads a backup completely and returns what it holds. Touches nothing.
pub async fn inspect(path: &Path, key: &str) -> anyhow::Result<Summary> {
    let path = path.to_owned();
    let key = key.to_owned();
    tokio::task::spawn_blocking(move || {
        let reader = pipeline::open_file(&path, &key)?;
        script::parse(reader, |_| Ok(()))
            .with_context(|| format!("{} is not a usable backup", path.display()))
    })
    .await
    .map_err(|e| anyhow!("reading the backup stopped unexpectedly: {e}"))?
}

fn resolve_file(config: &BackupConfig, file: Option<&str>) -> anyhow::Result<PathBuf> {
    match file {
        Some(argument) => Ok(files::resolve_argument(&config.dir, argument)),
        None => {
            let all = files::list(&config.dir)
                .with_context(|| format!("could not read {}", config.dir.display()))?;
            files::newest_restorable(&all)
                .map(|f| f.path.clone())
                .ok_or_else(|| {
                    anyhow!(
                        "no backup found in {} (a prerestore copy is only used when named)",
                        config.dir.display()
                    )
                })
        }
    }
}

async fn count_rows(conn: &mut PgConnection, table: &str) -> anyhow::Result<i64> {
    let sql = format!("SELECT count(*) FROM public.{}", script::quote_ident(table));
    Ok(sqlx::query_scalar(&sql).fetch_one(&mut *conn).await?)
}

async fn current_counts(
    conn: &mut PgConnection,
    catalog: &Catalog,
) -> anyhow::Result<Vec<(String, i64)>> {
    let mut counts = Vec::with_capacity(catalog.tables.len());
    for table in &catalog.tables {
        counts.push((table.name.clone(), count_rows(conn, &table.name).await?));
    }
    Ok(counts)
}

/// Restores `file` (the newest scheduled or manual one when `None`).
/// `confirm` is asked once, only when the database holds data; returning
/// `Ok(false)` stops with nothing changed.
pub async fn run(
    pool: &PgPool,
    config: &BackupConfig,
    file: Option<&str>,
    now: DateTime<Utc>,
    confirm: impl FnOnce(&Preview) -> anyhow::Result<bool>,
) -> anyhow::Result<Report> {
    let key = config.key()?.to_owned();
    let path = resolve_file(config, file)?;

    // 1. Check the file completely before touching anything.
    let summary = inspect(&path, &key).await?;
    let backup_version = summary.header.migration_version;
    let known = database::known_migration_versions();
    let latest = known.iter().copied().max().unwrap_or(0);
    if backup_version > latest {
        bail!(
            "this backup has schema version {backup_version} but this server only knows up to {latest}: restore it with the same or a newer HelixSync server"
        );
    }
    if !known.contains(&backup_version) {
        bail!("this backup has schema version {backup_version}, which this server has no migration for");
    }

    // 2. Look at what is there now.
    let (db_version, current_catalog, current) = {
        let mut conn = pool.acquire().await?;
        let version = catalog::migration_version(&mut conn).await?;
        let catalog = catalog::discover(&mut conn).await?;
        let counts = current_counts(&mut conn, &catalog).await?;
        (version, catalog, counts)
    };
    match db_version {
        Some(v) if !known.contains(&v) => bail!(
            "the database is at schema version {v}, which this server does not know: run the restore with a newer HelixSync server"
        ),
        None if !current_catalog.tables.is_empty() => bail!(
            "the database has tables but no migration history; refusing to replace it"
        ),
        _ => {}
    }
    let has_data = current.iter().any(|(_, rows)| *rows > 0);

    if has_data {
        let preview = Preview {
            file: path.clone(),
            summary: summary.clone(),
            current,
        };
        if !confirm(&preview)? {
            bail!("not confirmed, nothing was restored");
        }
    }

    // 3. A copy of what is about to be replaced. If it cannot be written,
    //    stop: the restore has not changed anything yet.
    let safety_backup = if has_data {
        let outcome = dump::run(pool, config, Kind::PreRestore, now)
            .await
            .context(
                "could not write the safety backup of the current data; nothing was changed",
            )?;
        Some(outcome.path)
    } else {
        None
    };

    // 4. Load.
    let rebuilt_schema = db_version != Some(backup_version);
    if rebuilt_schema {
        drop_everything(pool, &current_catalog).await?;
        database::run_migrations_up_to(pool, backup_version)
            .await
            .context("could not rebuild the schema the backup was taken with")?;
    }
    load(pool, &path, &key, !rebuilt_schema).await?;
    // Bring a backup of an older version up to this server's schema.
    database::run_migrations(pool)
        .await
        .context("the data was restored, but the newer migrations could not be applied")?;

    crate::audit::record(
        pool,
        "backup_restored",
        serde_json::json!({
            "file": path.file_name().and_then(|n| n.to_str()).unwrap_or_default(),
            "rows": summary.total_rows(),
        }),
    )
    .await;

    Ok(Report {
        file: path,
        summary,
        safety_backup,
        rebuilt_schema,
    })
}

/// Drops every table (and the migration history), so the schema can be
/// rebuilt from migrations.
async fn drop_everything(pool: &PgPool, catalog: &Catalog) -> anyhow::Result<()> {
    let mut names: Vec<String> = catalog
        .tables
        .iter()
        .map(|t| format!("public.{}", script::quote_ident(&t.name)))
        .collect();
    names.push(format!("public.{}", script::quote_ident(MIGRATIONS_TABLE)));
    let sql = format!("DROP TABLE IF EXISTS {} CASCADE", names.join(", "));
    sqlx::query(&sql)
        .execute(pool)
        .await
        .context("could not drop the old tables")?;
    Ok(())
}

/// Loads the script into the database in one transaction. With `truncate`,
/// the current rows are replaced.
async fn load(pool: &PgPool, path: &Path, key: &str, truncate: bool) -> anyhow::Result<()> {
    let (items, mut received) = mpsc::channel::<Item>(CHANNEL_DEPTH);
    let parser = tokio::task::spawn_blocking({
        let path = path.to_owned();
        let key = key.to_owned();
        move || -> anyhow::Result<Summary> {
            let reader = pipeline::open_file(&path, &key)?;
            script::parse(reader, |item| {
                items
                    .blocking_send(item)
                    .map_err(|_| anyhow!("the restore stopped"))
            })
        }
    });

    let applied = apply(pool, truncate, &mut received).await;
    drop(received);
    let parsed = parser
        .await
        .map_err(|e| anyhow!("reading the backup stopped unexpectedly: {e}"))?;

    // Commit only when the file also read through to its end marker; any
    // earlier return drops the transaction, which rolls it back.
    let tx = applied?;
    parsed?;
    tx.commit().await.context("could not commit the restore")?;
    Ok(())
}

async fn apply(
    pool: &PgPool,
    truncate: bool,
    received: &mut mpsc::Receiver<Item>,
) -> anyhow::Result<Transaction<'static, Postgres>> {
    let mut tx = pool.begin().await?;
    let catalog = catalog::discover(&mut tx).await?;

    if truncate && !catalog.tables.is_empty() {
        let tables: Vec<String> = catalog
            .tables
            .iter()
            .map(|t| format!("public.{}", script::quote_ident(&t.name)))
            .collect();
        sqlx::query(&format!("TRUNCATE TABLE {}", tables.join(", ")))
            .execute(&mut *tx)
            .await
            .context("could not empty the current tables")?;
    }

    let mut loaded: Vec<(String, u64)> = Vec::new();
    while let Some(item) = received.recv().await {
        match item {
            Item::Header(_) => {}
            Item::CopyStart { table, columns } => {
                let known = catalog.table(&table).ok_or_else(|| {
                    anyhow!("the backup has table {table:?}, which the database does not")
                })?;
                if let Some(unknown) = columns.iter().find(|c| !known.columns.contains(c)) {
                    bail!("the backup has column {unknown:?} in {table:?}, which the database does not");
                }
                let statement = script::copy_in_statement(&table, &columns);
                let rows = copy_table(&mut tx, received, &statement)
                    .await
                    .with_context(|| format!("could not load table {table}"))?;
                loaded.push((table, rows));
            }
            Item::Setval {
                sequence,
                value,
                is_called,
            } => {
                if !catalog.has_sequence(&sequence) {
                    bail!(
                        "the backup sets sequence {sequence:?}, which the database does not have"
                    );
                }
                sqlx::query("SELECT pg_catalog.setval($1::regclass, $2, $3)")
                    .bind(script::sequence_regclass(&sequence))
                    .bind(value)
                    .bind(is_called)
                    .execute(&mut *tx)
                    .await
                    .with_context(|| format!("could not set sequence {sequence}"))?;
            }
            Item::CopyData(_) | Item::CopyEnd => {
                bail!("the backup is out of order");
            }
        }
    }

    // Every table must have come from the backup: a table it lacks would
    // have been emptied by the TRUNCATE with nothing loaded back.
    let loaded_names: std::collections::BTreeSet<&str> =
        loaded.iter().map(|(t, _)| t.as_str()).collect();
    if let Some(missing) = catalog
        .tables
        .iter()
        .find(|t| !loaded_names.contains(t.name.as_str()))
    {
        bail!(
            "the database has table {:?}, which the backup does not hold",
            missing.name
        );
    }

    // What is in the tables now must be what the backup said it holds.
    for (table, rows) in &loaded {
        let present = count_rows(&mut tx, table).await?;
        if present as u64 != *rows {
            bail!("table {table} holds {present} rows after loading, but the backup has {rows}");
        }
    }
    Ok(tx)
}

/// Streams one table's rows into a COPY. The sender ends it with `CopyEnd`.
async fn copy_table(
    conn: &mut PgConnection,
    received: &mut mpsc::Receiver<Item>,
    statement: &str,
) -> anyhow::Result<u64> {
    let mut copy = conn.copy_in_raw(statement).await?;
    loop {
        match received.recv().await {
            Some(Item::CopyData(data)) => {
                copy.send(data).await?;
            }
            Some(Item::CopyEnd) => break,
            _ => {
                let _ = copy.abort("backup is out of order").await;
                bail!("the backup ended in the middle of a table");
            }
        }
    }
    Ok(copy.finish().await?)
}
