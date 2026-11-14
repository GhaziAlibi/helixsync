// Runs backups on the `BACKUP_CRON` schedule (UTC).
//
// The only state is the backup folder itself: after a restart, the newest
// scheduled file tells whether a run was missed, so no migration is needed.
use std::time::Duration;

use anyhow::{anyhow, bail};
use chrono::{DateTime, Utc};
use croner::Cron;

use crate::background::run_pass;
use crate::backup::files::{self, Kind};
use crate::state::AppState;

/// A failed run is tried again after this long.
pub const RETRY_DELAY: Duration = Duration::from_secs(60 * 60);

/// Longest single sleep, so a changed system clock is noticed.
const MAX_SLEEP: Duration = Duration::from_secs(60 * 60);

/// Parses a standard five-field cron expression. Seconds and `@nicknames`
/// are refused so a typo cannot turn into something that runs every second.
pub fn parse_cron(expression: &str) -> anyhow::Result<Cron> {
    let fields = expression.split_whitespace().count();
    if fields != 5 {
        bail!(
            "BACKUP_CRON must have five fields (minute hour day-of-month month day-of-week), got {fields} in {expression:?}"
        );
    }
    expression
        .trim()
        .parse::<Cron>()
        .map_err(|e| anyhow!("BACKUP_CRON {expression:?} is not a valid cron expression: {e}"))
}

/// The first scheduled time after `after`.
pub fn next_run(cron: &Cron, after: DateTime<Utc>) -> anyhow::Result<DateTime<Utc>> {
    cron.find_next_occurrence(&after, false)
        .map_err(|e| anyhow!("BACKUP_CRON has no upcoming time: {e}"))
}

/// The latest scheduled time at or before `at`.
pub fn previous_run(cron: &Cron, at: DateTime<Utc>) -> Option<DateTime<Utc>> {
    cron.find_previous_occurrence(&at, true).ok()
}

/// Whether a scheduled run was missed: the newest scheduled file is older
/// than the most recent scheduled time. With no scheduled file at all, a
/// first backup is due at once.
pub fn is_missed(
    newest_scheduled: Option<DateTime<Utc>>,
    previous_scheduled: Option<DateTime<Utc>>,
) -> bool {
    match (newest_scheduled, previous_scheduled) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(newest), Some(previous)) => newest < previous,
    }
}

/// Starts the scheduler. Call once from `main.rs`, only when backups are
/// enabled (the configuration was validated at startup).
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let cron = match parse_cron(&state.config.backup.cron) {
            Ok(cron) => cron,
            Err(e) => {
                tracing::error!(error = %e, "backup scheduler not started");
                return;
            }
        };

        let mut retry_at: Option<DateTime<Utc>> = None;
        run_pass("backup", async {
            if !catch_up(&state, &cron, Utc::now()).await {
                retry_at = Some(Utc::now() + chrono::Duration::from_std(RETRY_DELAY).unwrap());
            }
        })
        .await;

        loop {
            let slot = match next_run(&cron, Utc::now()) {
                Ok(slot) => slot,
                Err(e) => {
                    tracing::error!(error = %e, "backup scheduler stopped");
                    return;
                }
            };
            let wake = retry_at.map_or(slot, |retry| retry.min(slot));
            sleep_until(wake).await;

            let mut ok = true;
            run_pass("backup", async {
                ok = crate::backup::run_audited(
                    &state.db,
                    &state.config.backup,
                    Kind::Scheduled,
                    Utc::now(),
                )
                .await
                .is_ok();
            })
            .await;
            retry_at = if ok {
                None
            } else {
                Some(Utc::now() + chrono::Duration::from_std(RETRY_DELAY).unwrap())
            };
        }
    });
}

async fn sleep_until(target: DateTime<Utc>) {
    loop {
        let remaining = target - Utc::now();
        let Ok(remaining) = remaining.to_std() else {
            return;
        };
        if remaining.is_zero() {
            return;
        }
        tokio::time::sleep(remaining.min(MAX_SLEEP)).await;
    }
}

/// Runs one scheduled backup if the server was down at the last scheduled
/// time. Returns false only when a due run failed.
pub async fn catch_up(state: &AppState, cron: &Cron, now: DateTime<Utc>) -> bool {
    let config = &state.config.backup;
    let existing = match files::list(&config.dir) {
        Ok(existing) => existing,
        Err(e) => {
            tracing::error!(error = %e, dir = %config.dir.display(), "backup: could not read the backup folder");
            return false;
        }
    };
    let newest = files::newest_scheduled(&existing).map(|f| f.created_at);
    if !is_missed(newest, previous_run(cron, now)) {
        return true;
    }
    tracing::info!("backup: a scheduled run was missed, running one now");
    crate::backup::run_audited(&state.db, config, Kind::Scheduled, now)
        .await
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(day: u32, h: u32, m: u32, s: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, day, h, m, s).unwrap()
    }

    #[test]
    fn only_five_field_expressions_are_accepted() {
        assert!(parse_cron("0 3 * * *").is_ok());
        assert!(parse_cron("*/15 * * * *").is_ok());
        assert!(parse_cron("30 2 * * 1-5").is_ok());
        for bad in [
            "",
            "0 3 * *",
            "0 0 3 * * *",
            "@daily",
            "61 3 * * *",
            "0 25 * * *",
            "not a cron at all",
        ] {
            assert!(parse_cron(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn next_and_previous_runs_are_daily_at_three_utc() {
        let cron = parse_cron("0 3 * * *").unwrap();
        assert_eq!(next_run(&cron, at(13, 2, 59, 59)).unwrap(), at(13, 3, 0, 0));
        // Exactly on a slot, the next one is tomorrow's.
        assert_eq!(next_run(&cron, at(13, 3, 0, 0)).unwrap(), at(14, 3, 0, 0));
        assert_eq!(previous_run(&cron, at(13, 3, 0, 0)), Some(at(13, 3, 0, 0)));
        assert_eq!(previous_run(&cron, at(13, 2, 0, 0)), Some(at(12, 3, 0, 0)));
        assert_eq!(
            previous_run(&cron, at(13, 17, 30, 0)),
            Some(at(13, 3, 0, 0))
        );
    }

    #[test]
    fn a_run_is_missed_when_the_newest_file_predates_the_last_slot() {
        let slot = Some(at(13, 3, 0, 0));
        // Up to date: the run at 03:00 produced a file at 03:00:04.
        assert!(!is_missed(Some(at(13, 3, 0, 4)), slot));
        assert!(!is_missed(Some(at(13, 3, 0, 0)), slot));
        // Down at 03:00: the newest file is yesterday's.
        assert!(is_missed(Some(at(12, 3, 0, 4)), slot));
        // First start ever.
        assert!(is_missed(None, slot));
        assert!(!is_missed(None, None));
        assert!(!is_missed(Some(at(12, 3, 0, 4)), None));
    }
}
