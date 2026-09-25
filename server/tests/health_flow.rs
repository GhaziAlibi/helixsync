use std::sync::Arc;

use axum_test::{TestServer, TestServerConfig, Transport};
use helixsync_server::config::Config;
use helixsync_server::middleware::rate_limit::RateLimiter;
use helixsync_server::state::AppState;
use helixsync_server::websocket::ConnectionRegistry;
use sqlx::PgPool;

fn test_config() -> Config {
    Config {
        database_url: String::new(),
        bind_addr: "127.0.0.1:0".into(),
        jwt_signing_key: b"test-signing-key-at-least-32-bytes-long".to_vec(),
        access_token_ttl_secs: 900,
        refresh_token_ttl_secs: 60 * 60 * 24 * 30,
        web_session_ttl_secs: 60 * 60 * 24 * 14,
        require_encryption: false,
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
        request_timeout_secs: 30,
        websocket_send_timeout_secs: 10,
        upload_semaphore_acquire_timeout_secs: 20,
        shutdown_deadline_secs: 30,
    }
}

fn server_for(pool: PgPool) -> TestServer {
    let state = AppState {
        db: pool,
        config: Arc::new(test_config()),
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
    let test_server_config = TestServerConfig {
        transport: Some(Transport::HttpRandomPort),
        save_cookies: true,
        ..Default::default()
    };
    let make_service =
        helixsync_server::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    TestServer::new_with_config(make_service, test_server_config).unwrap()
}

#[sqlx::test(migrations = "./migrations")]
async fn healthz_reports_ok_regardless_of_the_database(pool: PgPool) {
    pool.close().await;
    let server = server_for(pool);

    let res = server.get("/healthz").await;

    res.assert_status_ok();
    res.assert_text("ok");
}

#[sqlx::test(migrations = "./migrations")]
async fn readyz_reports_ok_when_the_database_is_reachable(pool: PgPool) {
    let server = server_for(pool);

    let res = server.get("/readyz").await;

    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["status"], "ok");
    assert!(body["pool"]["size"].is_number());
}

/// `/readyz` must fail when the database is unreachable.
#[sqlx::test(migrations = "./migrations")]
async fn readyz_reports_service_unavailable_when_the_database_is_unreachable(pool: PgPool) {
    pool.close().await;
    let server = server_for(pool);

    let res = server.get("/readyz").await;

    res.assert_status_service_unavailable();
    let body: serde_json::Value = res.json();
    assert_eq!(body["status"], "error");
}
