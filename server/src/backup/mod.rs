// Scheduled, encrypted backups of the whole database, written into a folder
// on the host (the `helix-backup` volume). Copying the files elsewhere is the
// operator's business; the server talks to no storage provider.
//
//   dump       one consistent snapshot → script → zstd → age → file
//   scheduler  the cron schedule, missed-run catch-up, retry
//   restore    the operator command that loads a file back
//   cli        the `backup-now` / `list-backups` / `restore-backup` commands
//   status     the read-only `GET /api/v1/backups` for the dashboard
//
// See docs/deployment.md, "Backups".
use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::config::BackupConfig;

pub mod catalog;
pub mod cli;
pub mod dump;
pub mod files;
pub mod pipeline;
pub mod restore;
pub mod scheduler;
pub mod script;
pub mod status;

/// Startup check when backups are enabled: the folder exists and the server
/// can write to it. Fails with what to fix instead of letting the first
/// scheduled run find out at 03:00.
pub fn check_dir_writable(dir: &Path) -> anyhow::Result<()> {
    let probe = dir.join(format!(".helixsync-write-test-{}", std::process::id()));
    let result = fs::write(&probe, b"ok").and_then(|()| fs::remove_file(&probe));
    result.map_err(|e| {
        anyhow::anyhow!(
            "BACKUP_DIR {} is not writable ({e}). Mount a volume there that the server user (uid 10001) can write to, or set BACKUP_ENABLED=false",
            dir.display()
        )
    })
}

/// Writes a backup, records the outcome (log and `audit_logs`) and, on
/// success, prunes old files beyond `BACKUP_KEEP_LAST`.
pub async fn run_audited(
    pool: &PgPool,
    config: &BackupConfig,
    kind: files::Kind,
    now: DateTime<Utc>,
) -> anyhow::Result<dump::Outcome> {
    let started = std::time::Instant::now();
    match dump::run(pool, config, kind, now).await {
        Ok(outcome) => {
            let name = outcome
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            tracing::info!(
                file = %name,
                bytes = outcome.size,
                tables = outcome.tables,
                rows = outcome.rows,
                elapsed_ms = started.elapsed().as_millis() as u64,
                "backup completed"
            );
            crate::audit::record(
                pool,
                "backup_completed",
                serde_json::json!({
                    "file": name,
                    "kind": kind.label(),
                    "bytes": outcome.size,
                    "rows": outcome.rows,
                }),
            )
            .await;
            match files::prune(&config.dir, config.keep_last) {
                Ok(removed) if !removed.is_empty() => {
                    tracing::info!(count = removed.len(), "backup: removed old backups");
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "backup: could not remove old backups"),
            }
            Ok(outcome)
        }
        Err(e) => {
            tracing::error!(error = %format!("{e:#}"), "backup failed");
            // Two runs at once is not a failure of the data; the other one
            // reports its own outcome.
            if e.downcast_ref::<dump::AlreadyRunning>().is_none() {
                crate::audit::record(
                    pool,
                    "backup_failed",
                    serde_json::json!({ "kind": kind.label() }),
                )
                .await;
            }
            Err(e)
        }
    }
}
