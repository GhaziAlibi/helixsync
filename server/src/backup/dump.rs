// Writes one backup: the whole database as a data script, compressed and
// encrypted, straight to a file.
//
// Every table is read inside one REPEATABLE READ, READ ONLY transaction, so
// the file is a single consistent snapshot while sync keeps running. The
// bytes stream from Postgres through a small channel into a blocking thread
// that compresses, encrypts and writes them: memory use stays small however
// large the database is.
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context};
use chrono::{DateTime, SubsecRound, Utc};
use futures::TryStreamExt;
use sqlx::{PgConnection, PgPool};
use tokio::sync::mpsc;

use crate::backup::catalog::{self, Catalog};
use crate::backup::files::{self, Kind};
use crate::backup::pipeline;
use crate::backup::script::{self, Header, FORMAT_VERSION};
use crate::config::BackupConfig;

/// Postgres advisory lock held by the transaction of a running backup, so
/// two never run at once, whether they come from the scheduler, `backup-now`
/// or a second server process.
pub const BACKUP_LOCK_KEY: i64 = 0x4845_4C49_5842_4B50; // "HELIXBKP"

/// Chunks queued between the database reader and the file writer.
const CHANNEL_DEPTH: usize = 8;

/// Another backup holds the lock.
#[derive(Debug)]
pub struct AlreadyRunning;

impl fmt::Display for AlreadyRunning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "another backup is already running")
    }
}

impl std::error::Error for AlreadyRunning {}

#[derive(Debug, Clone)]
pub struct Outcome {
    pub path: PathBuf,
    pub size: u64,
    pub tables: usize,
    pub rows: u64,
    pub migration_version: i64,
}

enum Message {
    Data(Vec<u8>),
    Finish,
}

/// Writes a backup of kind `kind` into `config.dir`. The caller decides what
/// to do with the result (log, audit, prune); see [`crate::backup::run_audited`].
pub async fn run(
    pool: &PgPool,
    config: &BackupConfig,
    kind: Kind,
    now: DateTime<Utc>,
) -> anyhow::Result<Outcome> {
    let key = config.key()?.to_owned();
    let dir = config.dir.clone();
    let created_at = now.trunc_subsecs(0);
    let final_path = dir.join(files::file_name(created_at, kind));
    let partial_path = PathBuf::from(format!("{}{}", final_path.display(), files::PARTIAL_SUFFIX));

    let mut tx = pool
        .begin()
        .await
        .context("could not start a transaction")?;
    // Must be the first statement of the transaction.
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock($1)")
        .bind(BACKUP_LOCK_KEY)
        .fetch_one(&mut *tx)
        .await?;
    if !locked {
        return Err(AlreadyRunning.into());
    }

    // The lock is ours, so any `.partial` file is from a run that died.
    let leftovers = files::remove_partials(&dir)
        .with_context(|| format!("could not clean up {}", dir.display()))?;
    if leftovers > 0 {
        tracing::warn!(
            count = leftovers,
            "backup: removed unfinished files from an earlier run"
        );
    }
    if final_path.exists() {
        bail!("{} already exists", final_path.display());
    }

    let (sender, receiver) = mpsc::channel::<Message>(CHANNEL_DEPTH);
    let writer = tokio::task::spawn_blocking({
        let partial = partial_path.clone();
        let target = final_path.clone();
        move || write_file(receiver, &partial, &target, &key)
    });

    let produced = produce(&mut tx, &sender, created_at).await;
    drop(sender);
    // A read-only transaction has nothing to commit.
    let _ = tx.rollback().await;

    let written = writer
        .await
        .map_err(|e| anyhow!("backup writer stopped unexpectedly: {e}"))?;
    // Prefer the writer's error: when the disk fails, the reader only sees a
    // closed channel.
    let size = written?;
    let produced = produced?;

    Ok(Outcome {
        path: final_path,
        size,
        tables: produced.tables,
        rows: produced.rows,
        migration_version: produced.migration_version,
    })
}

struct Produced {
    tables: usize,
    rows: u64,
    migration_version: i64,
}

async fn send(sender: &mpsc::Sender<Message>, message: Message) -> anyhow::Result<()> {
    sender
        .send(message)
        .await
        .map_err(|_| anyhow!("the backup file could not be written"))
}

async fn send_text(sender: &mpsc::Sender<Message>, text: String) -> anyhow::Result<()> {
    send(sender, Message::Data(text.into_bytes())).await
}

/// Reads the snapshot and sends the script to the writer, then tells it to
/// finish.
async fn produce(
    conn: &mut PgConnection,
    sender: &mpsc::Sender<Message>,
    created_at: DateTime<Utc>,
) -> anyhow::Result<Produced> {
    let catalog: Catalog = catalog::discover(conn).await?;
    let migration_version = catalog::migration_version(conn)
        .await?
        .ok_or_else(|| anyhow!("the database has no migrations applied; nothing to back up"))?;

    send_text(
        sender,
        script::header_text(&Header {
            format: FORMAT_VERSION,
            server_version: env!("CARGO_PKG_VERSION").to_string(),
            migration_version,
            created_at,
        }),
    )
    .await?;

    let mut counts: Vec<(String, u64)> = Vec::with_capacity(catalog.tables.len());
    for table in &catalog.tables {
        send_text(
            sender,
            format!(
                "{}\n",
                script::copy_in_statement(&table.name, &table.columns)
            ),
        )
        .await?;

        let statement = script::copy_out_statement(&table.name, &table.columns);
        let mut rows = 0u64;
        {
            let mut stream = conn
                .copy_out_raw(&statement)
                .await
                .with_context(|| format!("could not read table {}", table.name))?;
            while let Some(chunk) = stream
                .try_next()
                .await
                .with_context(|| format!("could not read table {}", table.name))?
            {
                // COPY text escapes newlines inside values, so one newline
                // is exactly one row.
                rows += chunk.iter().filter(|b| **b == b'\n').count() as u64;
                send(sender, Message::Data(chunk.to_vec())).await?;
            }
        }
        send_text(sender, "\\.\n\n".to_string()).await?;
        counts.push((table.name.clone(), rows));
    }

    // Sequences are read after the tables: a sequence is never behind the
    // rows already in the snapshot, so ids handed out after a restore cannot
    // collide with restored ones.
    let sequence_values: Vec<(String, Option<i64>)> = sqlx::query_as(
        "SELECT sequencename::text, last_value FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename",
    )
    .fetch_all(&mut *conn)
    .await
    .context("could not read the sequences")?;
    for (name, last_value) in sequence_values {
        let statement = match last_value {
            Some(value) => script::setval_statement(&name, value, true)?,
            None => script::setval_statement(&name, 1, false)?,
        };
        send_text(sender, format!("{statement}\n")).await?;
    }

    send_text(sender, "\n".to_string()).await?;
    for (table, rows) in &counts {
        send_text(sender, script::rows_line(table, *rows)).await?;
    }
    send_text(sender, script::END_LINE.to_string()).await?;
    send(sender, Message::Finish).await?;

    Ok(Produced {
        tables: counts.len(),
        rows: counts.iter().map(|(_, rows)| rows).sum(),
        migration_version,
    })
}

/// The blocking half: compress, encrypt and write into `<name>.partial`,
/// fsync it, then rename it to its final name. Anything short of a clean
/// finish removes the partial file, so a final name is never half-written.
fn write_file(
    mut receiver: mpsc::Receiver<Message>,
    partial: &Path,
    target: &Path,
    key: &str,
) -> anyhow::Result<u64> {
    let result = write_file_inner(&mut receiver, partial, target, key);
    if result.is_err() {
        let _ = fs::remove_file(partial);
    }
    result
}

fn write_file_inner(
    receiver: &mut mpsc::Receiver<Message>,
    partial: &Path,
    target: &Path,
    key: &str,
) -> anyhow::Result<u64> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(partial)
        .with_context(|| format!("could not create {}", partial.display()))?;

    let mut sealed = pipeline::seal(BufWriter::with_capacity(256 * 1024, file), key)
        .context("could not start encrypting the backup")?;
    loop {
        match receiver.blocking_recv() {
            Some(Message::Data(bytes)) => sealed
                .write_all(&bytes)
                .with_context(|| format!("could not write {}", partial.display()))?,
            Some(Message::Finish) => break,
            None => bail!("backup was aborted before it was complete"),
        }
    }
    let buffered = pipeline::finish_seal(sealed)
        .with_context(|| format!("could not write {}", partial.display()))?;
    let file: File = buffered
        .into_inner()
        .map_err(|e| e.into_error())
        .with_context(|| format!("could not write {}", partial.display()))?;
    file.sync_all()
        .with_context(|| format!("could not sync {}", partial.display()))?;
    let size = file.metadata()?.len();
    drop(file);

    fs::rename(partial, target)
        .with_context(|| format!("could not move the backup to {}", target.display()))?;
    // Make the rename itself durable.
    if let Some(dir) = target.parent() {
        if let Ok(dir) = File::open(dir) {
            let _ = dir.sync_all();
        }
    }
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "k3Yb0ardCat-9fQ2xVzLmW7pRtN1uHsJ4aEoXyC6dGq8";

    struct Dir(PathBuf);

    impl Dir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("helixsync-dump-test-{}", uuid::Uuid::now_v7()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn entries(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.0)
                .unwrap()
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn a_finished_stream_appears_under_its_final_name_only() {
        let dir = Dir::new();
        let (sender, receiver) = mpsc::channel(4);
        let partial = dir.0.join("b.sql.zst.age.partial");
        let target = dir.0.join("b.sql.zst.age");
        let writer = tokio::task::spawn_blocking({
            let (partial, target) = (partial.clone(), target.clone());
            move || write_file(receiver, &partial, &target, KEY)
        });

        sender
            .send(Message::Data(b"some script\n".to_vec()))
            .await
            .unwrap();
        sender.send(Message::Finish).await.unwrap();
        let size = writer.await.unwrap().unwrap();

        assert_eq!(dir.entries(), vec!["b.sql.zst.age"]);
        assert_eq!(size, fs::metadata(&target).unwrap().len());
    }

    #[tokio::test]
    async fn an_aborted_stream_leaves_no_file_at_all() {
        let dir = Dir::new();
        let (sender, receiver) = mpsc::channel(4);
        let partial = dir.0.join("b.sql.zst.age.partial");
        let target = dir.0.join("b.sql.zst.age");
        let writer = tokio::task::spawn_blocking({
            let (partial, target) = (partial.clone(), target.clone());
            move || write_file(receiver, &partial, &target, KEY)
        });

        sender
            .send(Message::Data(b"half a script".to_vec()))
            .await
            .unwrap();
        // The database side failed: the sender goes away without `Finish`.
        drop(sender);

        assert!(writer.await.unwrap().is_err());
        assert!(dir.entries().is_empty(), "{:?}", dir.entries());
    }

    #[test]
    fn an_unwritable_folder_fails_the_startup_check() {
        let dir = Dir::new();
        assert!(crate::backup::check_dir_writable(&dir.0).is_ok());
        assert!(dir.entries().is_empty(), "the probe file is removed");
        let missing = dir.0.join("missing");
        let err = crate::backup::check_dir_writable(&missing).unwrap_err();
        assert!(err.to_string().contains("BACKUP_DIR"), "{err}");
    }
}
