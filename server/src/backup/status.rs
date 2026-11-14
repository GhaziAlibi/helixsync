// `GET /api/v1/backups`: what the dashboard's Backups page shows. Read-only.
//
// HelixSync has no admin role, so every signed-in account sees the same
// thing: whether backups are on, the schedule, the files in the folder and
// the recent outcomes. It carries no secret and no file content, and nothing
// here can start, change or restore a backup; that stays a command on the
// host.
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::FromRow;

use crate::auth::extractors::AuthenticatedUser;
use crate::backup::files;
use crate::backup::scheduler;
use crate::error::{AppError, AppResult};
use crate::middleware::rate_limit::{enforce, BACKUP_STATUS_LIMIT};
use crate::state::AppState;

/// Outcomes returned, newest first.
const HISTORY_LIMIT: i64 = 50;

pub fn router() -> Router<AppState> {
    Router::new().route("/", get(status))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    /// The five-field cron expression, UTC. Only when enabled.
    pub cron: Option<String>,
    pub keep_last: Option<usize>,
    /// The next scheduled run. Only when enabled.
    pub next_run_at: Option<DateTime<Utc>>,
    /// Files in the backup folder, newest first.
    pub files: Vec<FileEntry>,
    /// Recent outcomes, newest first.
    pub history: Vec<HistoryEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    /// `scheduled`, `manual` or `prerestore`.
    pub kind: &'static str,
    pub created_at: DateTime<Utc>,
    pub size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// `completed`, `failed` or `restored`.
    pub event: String,
    pub at: DateTime<Utc>,
    /// `scheduled` or `manual`, when known.
    pub kind: Option<String>,
    pub file: Option<String>,
    pub bytes: Option<i64>,
    pub rows: Option<i64>,
}

#[derive(FromRow)]
struct AuditRow {
    event_type: String,
    metadata: serde_json::Value,
    created_at: DateTime<Utc>,
}

impl From<AuditRow> for HistoryEntry {
    fn from(row: AuditRow) -> Self {
        let text = |key: &str| {
            row.metadata
                .get(key)
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        };
        let number = |key: &str| row.metadata.get(key).and_then(|v| v.as_i64());
        HistoryEntry {
            event: row
                .event_type
                .strip_prefix("backup_")
                .unwrap_or(&row.event_type)
                .to_string(),
            at: row.created_at,
            kind: text("kind"),
            file: text("file"),
            bytes: number("bytes"),
            rows: number("rows"),
        }
    }
}

async fn status(user: AuthenticatedUser, State(state): State<AppState>) -> AppResult<Json<Status>> {
    enforce(
        &state.rate_limiter,
        BACKUP_STATUS_LIMIT,
        &user.user_id.to_string(),
    )?;

    let config = &state.config.backup;
    if !config.enabled {
        return Ok(Json(Status {
            enabled: false,
            cron: None,
            keep_last: None,
            next_run_at: None,
            files: Vec::new(),
            history: Vec::new(),
        }));
    }

    let dir = config.dir.clone();
    let listed = tokio::task::spawn_blocking(move || files::list(&dir))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("backup listing stopped: {e}")))?;
    let mut entries: Vec<FileEntry> = match listed {
        Ok(files) => files
            .into_iter()
            .map(|f| FileEntry {
                name: f.name,
                kind: f.kind.label(),
                created_at: f.created_at,
                size_bytes: f.size,
            })
            .collect(),
        Err(e) => {
            // A folder that cannot be read is something the page can show as
            // an empty list; the scheduler logs the real problem.
            tracing::warn!(error = %e, "backups: could not list the backup folder");
            Vec::new()
        }
    };
    entries.reverse();

    let history = sqlx::query_as::<_, AuditRow>(
        "SELECT event_type, metadata, created_at FROM audit_logs
         WHERE user_id IS NULL
           AND event_type IN ('backup_completed', 'backup_failed', 'backup_restored')
         ORDER BY created_at DESC, id DESC
         LIMIT $1",
    )
    .bind(HISTORY_LIMIT)
    .fetch_all(&state.db)
    .await?
    .into_iter()
    .map(HistoryEntry::from)
    .collect();

    let next_run_at = scheduler::parse_cron(&config.cron)
        .ok()
        .and_then(|cron| scheduler::next_run(&cron, Utc::now()).ok());

    Ok(Json(Status {
        enabled: true,
        cron: Some(config.cron.clone()),
        keep_last: Some(config.keep_last),
        next_run_at,
        files: entries,
        history,
    }))
}
