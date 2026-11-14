// `GET /api/v1/backups`: the read-only view behind the dashboard's Backups page.
mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::http::StatusCode;
use axum_test::{TestServer, TestServerConfig, Transport};
use chrono::{DateTime, Duration, TimeZone, Utc};
use helixsync_server::backup::files::{self, Kind};
use helixsync_server::config::{BackupConfig, Config};
use helixsync_server::middleware::rate_limit::RateLimiter;
use helixsync_server::state::AppState;
use helixsync_server::websocket::ConnectionRegistry;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

const KEY: &str = "k3Yb0ardCat-9fQ2xVzLmW7pRtN1uHsJ4aEoXyC6dGq8";

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("helixsync-status-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn t(minutes: i64) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 13, 0, 0, 0).unwrap() + Duration::minutes(minutes)
}

fn server_with(pool: PgPool, backup: BackupConfig) -> TestServer {
    let config = Config {
        database_url: String::new(),
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        jwt_signing_key: b"test-signing-key-at-least-32-bytes-long".to_vec(),
        access_token_ttl_secs: 900,
        refresh_token_ttl_secs: 60 * 60 * 24 * 30,
        web_session_ttl_secs: 60 * 60 * 24 * 14,
        require_encryption: false,
        allow_registration: true,
        behind_proxy: false,
        cors_allowed_origins: vec![],
        protocol_version: 1,
        minimum_supported_protocol_version: 1,
        api_version: "v1".to_string(),
        tombstone_retention_secs: 60 * 60 * 24 * 30,
        compaction_interval_secs: 60 * 60,
        inactive_device_compaction_grace_period_secs: 60 * 60 * 24 * 30,
        never_synced_device_compaction_grace_period_secs: 60 * 60 * 24 * 30,
        housekeeping_interval_secs: 60 * 60 * 24,
        device_credential_retention_secs: 60 * 60 * 24 * 7,
        audit_log_retention_secs: 60 * 60 * 24 * 90,
        ephemeral_tombstone_retention_secs: 60 * 60 * 24 * 30,
        database_max_connections: 5,
        websocket_ping_interval_secs: 30,
        max_devices_per_account: 25,
        max_account_storage_bytes: 2 * 1024 * 1024 * 1024,
        request_timeout_secs: 30,
        websocket_send_timeout_secs: 10,
        upload_semaphore_acquire_timeout_secs: 20,
        shutdown_deadline_secs: 30,
        restore_points: Default::default(),
        backup,
    };
    let state = AppState {
        db: pool,
        config: Arc::new(config),
        rate_limiter: Arc::new(RateLimiter::new()),
        ws_registry: Arc::new(ConnectionRegistry::new()),
        last_seen_cache: Arc::new(dashmap::DashMap::new()),
        device_revocation_cache: Arc::new(dashmap::DashMap::new()),
        web_session_cache: Arc::new(dashmap::DashMap::new()),
        upload_locks: Arc::new(dashmap::DashMap::new()),
        snapshot_semaphore: Arc::new(tokio::sync::Semaphore::new(
            helixsync_server::sync::routes::SNAPSHOT_CONCURRENCY_LIMIT,
        )),
        argon2_semaphore: Arc::new(tokio::sync::Semaphore::new(
            helixsync_server::crypto::ARGON2_CONCURRENCY_LIMIT,
        )),
    };
    TestServer::new_with_config(
        helixsync_server::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
        TestServerConfig {
            transport: Some(Transport::HttpRandomPort),
            save_cookies: true,
            ..Default::default()
        },
    )
}

async fn sign_up(server: &TestServer, email: &str) {
    server
        .post("/api/v1/auth/register")
        .json(&json!({
            "email": email,
            "authKey": common::test_auth_key("pw"),
            "kdfSalt": common::test_kdf_salt(),
            "kdfParams": common::test_kdf_params(),
            "wrappedAk": common::test_wrapped_ak(),
            "recoveryAuthKey": common::test_recovery_auth_key(),
            "recoveryWrappedAk": common::test_recovery_wrapped_ak(),
        }))
        .await
        .assert_status_ok();
}

#[sqlx::test(migrations = "./migrations")]
async fn it_needs_a_signed_in_account(pool: PgPool) {
    let dir = TempDir::new();
    let server = server_with(
        pool,
        BackupConfig::new(true, Some(KEY.into()), "0 3 * * *", dir.path(), 7),
    );
    server
        .get("/api/v1/backups")
        .await
        .assert_status(StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrations = "./migrations")]
async fn version_advertises_the_page(pool: PgPool) {
    let server = server_with(pool, BackupConfig::default());
    let version: serde_json::Value = server.get("/api/v1/version").await.json();
    assert_eq!(version["backups"], json!(true));
}

#[sqlx::test(migrations = "./migrations")]
async fn when_backups_are_off_it_says_so_and_lists_nothing(pool: PgPool) {
    let dir = TempDir::new();
    // A file in the folder is not shown: backups are off.
    std::fs::write(dir.path().join(files::file_name(t(0), Kind::Manual)), b"x").unwrap();
    let server = server_with(
        pool,
        BackupConfig::new(false, None, "0 3 * * *", dir.path(), 7),
    );
    sign_up(&server, "off@example.com").await;

    let body: serde_json::Value = server.get("/api/v1/backups").await.json();
    assert_eq!(body["enabled"], json!(false));
    assert_eq!(body["files"], json!([]));
    assert_eq!(body["history"], json!([]));
    assert!(body["cron"].is_null());
    assert!(body["nextRunAt"].is_null());
}

#[sqlx::test(migrations = "./migrations")]
async fn it_lists_files_and_outcomes_newest_first(pool: PgPool) {
    let dir = TempDir::new();
    let config = BackupConfig::new(true, Some(KEY.into()), "30 2 * * *", dir.path(), 7);
    let server = server_with(pool.clone(), config.clone());
    sign_up(&server, "on@example.com").await;

    helixsync_server::backup::run_audited(&pool, &config, Kind::Scheduled, t(10))
        .await
        .unwrap();
    helixsync_server::backup::run_audited(&pool, &config, Kind::Manual, t(20))
        .await
        .unwrap();
    // A run that cannot write: its file name is taken by a folder.
    std::fs::create_dir(dir.path().join(files::file_name(t(30), Kind::Manual))).unwrap();
    helixsync_server::backup::run_audited(&pool, &config, Kind::Manual, t(30))
        .await
        .unwrap_err();

    let body: serde_json::Value = server.get("/api/v1/backups").await.json();
    assert_eq!(body["enabled"], json!(true));
    assert_eq!(body["cron"], json!("30 2 * * *"));
    assert_eq!(body["keepLast"], json!(7));
    let next: DateTime<Utc> = body["nextRunAt"].as_str().unwrap().parse().unwrap();
    assert!(next > Utc::now());

    let listed: Vec<(&str, &str)> = body["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["kind"].as_str().unwrap(), f["name"].as_str().unwrap()))
        .collect();
    assert_eq!(
        listed,
        vec![
            ("manual", files::file_name(t(20), Kind::Manual).as_str()),
            (
                "scheduled",
                files::file_name(t(10), Kind::Scheduled).as_str()
            ),
        ]
    );
    assert!(body["files"][0]["sizeBytes"].as_u64().unwrap() > 0);

    let history = body["history"].as_array().unwrap();
    let events: Vec<&str> = history
        .iter()
        .map(|h| h["event"].as_str().unwrap())
        .collect();
    assert_eq!(events, vec!["failed", "completed", "completed"]);
    assert_eq!(history[1]["kind"], json!("manual"));
    assert_eq!(
        history[1]["file"],
        json!(files::file_name(t(20), Kind::Manual))
    );
    assert!(history[1]["bytes"].as_i64().unwrap() > 0);
    assert_eq!(history[2]["kind"], json!("scheduled"));
    // A failure carries no error text, so nothing about the host leaks.
    assert!(history[0]["file"].is_null());
}

#[sqlx::test(migrations = "./migrations")]
async fn other_audit_events_are_not_shown(pool: PgPool) {
    let dir = TempDir::new();
    let server = server_with(
        pool.clone(),
        BackupConfig::new(true, Some(KEY.into()), "0 3 * * *", dir.path(), 7),
    );
    sign_up(&server, "audit@example.com").await;
    // Registering and logging in wrote audit rows of their own.
    let others: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_logs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(others > 0);

    let body: serde_json::Value = server.get("/api/v1/backups").await.json();
    assert_eq!(body["history"], json!([]));
}
