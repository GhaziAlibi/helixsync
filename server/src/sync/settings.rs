use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::auth::extractors::AnyAuthenticatedUser;
use crate::error::{AppError, AppResult};
use crate::middleware::rate_limit::{enforce, SYNC_SETTINGS_LIMIT};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/", get(get_settings).patch(update_settings))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct UserSettings {
    pub sync_bookmarks: bool,
    pub sync_history: bool,
    pub sync_tabs: bool,
    pub sync_tab_groups: bool,
    pub sync_extensions: bool,
    pub tab_restore_policy: String,
    pub history_retention: String,
    pub require_encryption: bool,
    pub extension_storage_allowlist: serde_json::Value,
    pub extension_storage_denylist: serde_json::Value,
}

async fn get_settings(
    user: AnyAuthenticatedUser,
    State(state): State<AppState>,
) -> AppResult<Json<UserSettings>> {
    enforce(&state.rate_limiter, SYNC_SETTINGS_LIMIT, &user.rate_limit_key)?;

    let settings = sqlx::query_as!(
        UserSettings,
        r#"
        SELECT sync_bookmarks, sync_history, sync_tabs, sync_tab_groups, sync_extensions,
               tab_restore_policy, history_retention, require_encryption,
               extension_storage_allowlist, extension_storage_denylist
        FROM user_settings WHERE user_id = $1
        "#,
        user.user_id
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(settings))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsRequest {
    pub sync_bookmarks: Option<bool>,
    pub sync_history: Option<bool>,
    pub sync_tabs: Option<bool>,
    pub sync_tab_groups: Option<bool>,
    pub sync_extensions: Option<bool>,
    pub tab_restore_policy: Option<String>,
    pub history_retention: Option<String>,
}

const VALID_RESTORE_POLICIES: &[&str] = &["disabled", "ask", "automatic"];
const VALID_RETENTIONS: &[&str] = &["7d", "30d", "90d", "1y", "unlimited"];

async fn update_settings(
    user: crate::auth::extractors::AnyAuthorizedMutator,
    State(state): State<AppState>,
    Json(req): Json<UpdateSettingsRequest>,
) -> AppResult<Json<UserSettings>> {
    enforce(&state.rate_limiter, SYNC_SETTINGS_LIMIT, &user.rate_limit_key)?;

    if let Some(ref p) = req.tab_restore_policy {
        if !VALID_RESTORE_POLICIES.contains(&p.as_str()) {
            return Err(AppError::Validation("invalid tab restore policy".into()));
        }
    }
    if let Some(ref r) = req.history_retention {
        if !VALID_RETENTIONS.contains(&r.as_str()) {
            return Err(AppError::Validation("invalid history retention".into()));
        }
    }

    let settings = sqlx::query_as!(
        UserSettings,
        r#"
        UPDATE user_settings SET
            sync_bookmarks = COALESCE($2, sync_bookmarks),
            sync_history = COALESCE($3, sync_history),
            sync_tabs = COALESCE($4, sync_tabs),
            sync_tab_groups = COALESCE($5, sync_tab_groups),
            sync_extensions = COALESCE($6, sync_extensions),
            tab_restore_policy = COALESCE($7, tab_restore_policy),
            history_retention = COALESCE($8, history_retention),
            updated_at = now()
        WHERE user_id = $1
        RETURNING sync_bookmarks, sync_history, sync_tabs, sync_tab_groups, sync_extensions,
                  tab_restore_policy, history_retention, require_encryption,
                  extension_storage_allowlist, extension_storage_denylist
        "#,
        user.user_id,
        req.sync_bookmarks,
        req.sync_history,
        req.sync_tabs,
        req.sync_tab_groups,
        req.sync_extensions,
        req.tab_restore_policy,
        req.history_retention,
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    crate::audit::log(&state, Some(user.user_id), None, "settings_updated").await;

    Ok(Json(settings))
}
