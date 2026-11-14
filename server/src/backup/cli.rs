// The operator commands:
//   helixsync-server backup-now
//   helixsync-server list-backups
//   helixsync-server restore-backup [<file>]
use std::io::Write;

use anyhow::Context;
use chrono::Utc;
use sqlx::ConnectOptions;

use crate::backup::{self, files, restore};
use crate::config::Config;
use crate::database;

/// `helixsync-server backup-now`: writes one backup immediately.
pub async fn backup_now(config: &Config) -> anyhow::Result<()> {
    let backup = &config.backup;
    backup.key()?;
    backup::check_dir_writable(&backup.dir)?;
    let db = database::connect(config).await?;
    let outcome = backup::run_audited(&db, backup, files::Kind::Manual, Utc::now()).await?;
    println!(
        "Wrote {} ({}, {} rows in {} tables).",
        outcome.path.display(),
        human_size(outcome.size),
        outcome.rows,
        outcome.tables
    );
    Ok(())
}

/// `helixsync-server list-backups`: lists the backup files. Needs no key and
/// no database.
pub fn list_backups(config: &Config) -> anyhow::Result<()> {
    let dir = &config.backup.dir;
    let all = files::list(dir).with_context(|| format!("could not read {}", dir.display()))?;
    if all.is_empty() {
        println!("No backups in {}.", dir.display());
        return Ok(());
    }
    println!("{:<58} {:<19} {:>10}  KIND", "NAME", "TIME (UTC)", "SIZE");
    for file in &all {
        println!(
            "{:<58} {:<19} {:>10}  {}",
            file.name,
            file.created_at.format("%Y-%m-%d %H:%M:%S"),
            human_size(file.size),
            file.kind.label()
        );
    }
    Ok(())
}

/// `helixsync-server restore-backup [<file>]`: replaces the data with a
/// backup. Refuses while the server is connected; asks for a typed
/// confirmation when it would replace data.
pub async fn restore_backup(config: &Config, file: Option<&str>) -> anyhow::Result<()> {
    let backup = &config.backup;
    backup.key()?;
    // The safety backup goes into this folder, so it has to work before we
    // start.
    backup::check_dir_writable(&backup.dir)?;

    let options: sqlx::postgres::PgConnectOptions = config
        .database_url
        .parse()
        .context("DATABASE_URL is not a valid Postgres address")?;
    let options = options.log_statements(tracing::log::LevelFilter::Off);
    restore::ensure_no_other_sessions(&options).await?;

    let db = database::connect(config).await?;
    let report = restore::run(&db, backup, file, Utc::now(), |preview| {
        println!("Backup:  {}", preview.file.display());
        println!(
            "         taken {} by server {}, schema version {}, {} rows",
            preview
                .summary
                .header
                .created_at
                .format("%Y-%m-%d %H:%M:%S UTC"),
            preview.summary.header.server_version,
            preview.summary.header.migration_version,
            preview.summary.total_rows()
        );
        println!("This replaces the data now in the database:");
        for (table, rows) in preview.current.iter().filter(|(_, rows)| *rows > 0) {
            println!("  {table}: {rows} rows");
        }
        println!("A safety backup of this data is written first.");
        print!("Type \"restore\" to confirm: ");
        std::io::stdout().flush()?;
        let mut answer = String::new();
        std::io::stdin().read_line(&mut answer)?;
        Ok(answer.trim() == "restore")
    })
    .await?;

    println!(
        "Restored {} rows in {} tables from {}.",
        report.summary.total_rows(),
        report.summary.tables.len(),
        report.file.display()
    );
    if let Some(safety) = &report.safety_backup {
        println!("The data it replaced is saved in {}.", safety.display());
    }
    println!(
        "Start the server again. Devices resync on their own; sessions and passwords are those of the backup."
    );
    db.close().await;
    Ok(())
}

fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{size:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::human_size;

    #[test]
    fn sizes_are_readable() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(1023), "1023 B");
        assert_eq!(human_size(1536), "1.5 KiB");
        assert_eq!(human_size(5 * 1024 * 1024), "5.0 MiB");
    }
}
