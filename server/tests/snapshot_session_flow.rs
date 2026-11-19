mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use axum_test::{TestServer, TestServerConfig, Transport};
use helixsync_server::config::Config;
use helixsync_server::middleware::rate_limit::RateLimiter;
use helixsync_server::state::AppState;
use helixsync_server::websocket::ConnectionRegistry;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

fn test_config() -> Config {
    Config {
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
        backup: Default::default(),
    }
}

fn state_for(pool: PgPool, config: Config) -> AppState {
    AppState {
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
    }
}

fn server_for(state: AppState) -> TestServer {
    let config = TestServerConfig {
        transport: Some(Transport::HttpRandomPort),
        save_cookies: true,
        ..Default::default()
    };
    let make_service =
        helixsync_server::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    TestServer::new_with_config(make_service, config)
}

/// Registers an account (leaving its web session on `server`), returns the
/// CSRF token.
async fn register(server: &TestServer, email: &str) -> String {
    let res = server
        .post("/api/v1/auth/register")
        .json(&json!({
            "email": email,
            "authKey": common::test_auth_key("correct horse battery staple"),
            "kdfSalt": common::test_kdf_salt(),
            "kdfParams": common::test_kdf_params(),
            "wrappedAk": common::test_wrapped_ak(),
            "recoveryAuthKey": common::test_recovery_auth_key(),
            "recoveryWrappedAk": common::test_recovery_wrapped_ak(),
        }))
        .await;
    res.assert_status_ok();
    let body: Value = res.json();
    body["csrfToken"].as_str().unwrap().to_string()
}

async fn register_device(server: &TestServer, email: &str, name: &str) -> (Uuid, String) {
    let res = server
        .post("/api/v1/devices/register")
        .json(&json!({
            "email": email,
            "authKey": common::test_auth_key("correct horse battery staple"),
            "name": name
        }))
        .await;
    res.assert_status_ok();
    let body: Value = res.json();
    (
        body["deviceId"].as_str().unwrap().parse().unwrap(),
        body["accessToken"].as_str().unwrap().to_string(),
    )
}

fn bookmark_op(object_id: Uuid) -> Value {
    json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 1,
        "lamportTimestamp": 1,
        "objectType": "bookmark",
        "objectId": object_id,
        "operationType": "create",
        "encryptionVersion": 1,
        "payload": { "v": 2, "keyVersion": 1, "alg": "xchacha20poly1305", "nonce": "AAAA", "ciphertext": "BBBB" }
    })
}

async fn upload_bookmark(server: &TestServer, token: &str) -> Uuid {
    let object_id = Uuid::now_v7();
    server
        .post("/api/v1/sync/operations")
        .add_header("x-protocol-version", "1")
        .authorization_bearer(token)
        .json(&json!({ "operations": [bookmark_op(object_id)] }))
        .await
        .assert_status_ok();
    object_id
}

async fn last_seen_is_null(pool: &PgPool, device_id: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT last_seen_at IS NULL FROM devices WHERE id = $1")
        .bind(device_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrations = "./migrations")]
async fn session_cookie_reads_snapshot(pool: PgPool) {
    let server = server_for(state_for(pool, test_config()));
    register(&server, "snap-session@example.com").await;
    let (_device_id, token) = register_device(&server, "snap-session@example.com", "Laptop").await;
    let object_id = upload_bookmark(&server, &token).await;

    // `server` holds the web session cookie from `register`, and this call
    // carries no bearer token.
    let res = server.get("/api/v1/sync/snapshot").await;
    res.assert_status_ok();
    let body: Value = res.json();
    let objects = body["objects"].as_array().unwrap();
    assert_eq!(objects.len(), 1);
    assert_eq!(objects[0]["objectId"], json!(object_id));
}

#[sqlx::test(migrations = "./migrations")]
async fn device_token_still_reads_snapshot(pool: PgPool) {
    let server = server_for(state_for(pool, test_config()));
    register(&server, "snap-device@example.com").await;
    let (_device_id, token) = register_device(&server, "snap-device@example.com", "Laptop").await;
    upload_bookmark(&server, &token).await;

    let res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&token)
        .await;
    res.assert_status_ok();
    let body: Value = res.json();
    assert_eq!(body["objects"].as_array().unwrap().len(), 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn no_credentials_is_unauthorized(pool: PgPool) {
    let server = server_for(state_for(pool, test_config()));
    server
        .get("/api/v1/sync/snapshot")
        .await
        .assert_status(StatusCode::UNAUTHORIZED);
}

/// The session is read-only: `/sync/changes` writes a device cursor and
/// `/sync/operations` writes data, and neither accepts a session even with a
/// valid CSRF token.
#[sqlx::test(migrations = "./migrations")]
async fn session_cookie_cannot_use_changes_or_operations(pool: PgPool) {
    let server = server_for(state_for(pool, test_config()));
    let csrf = register(&server, "snap-readonly@example.com").await;

    server
        .get("/api/v1/sync/changes")
        .await
        .assert_status(StatusCode::UNAUTHORIZED);

    server
        .post("/api/v1/sync/operations")
        .add_header("x-protocol-version", "1")
        .add_header("x-csrf-token", &csrf)
        .json(&json!({ "operations": [bookmark_op(Uuid::now_v7())] }))
        .await
        .assert_status(StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrations = "./migrations")]
async fn logged_out_session_is_unauthorized(pool: PgPool) {
    let server = server_for(state_for(pool, test_config()));
    let csrf = register(&server, "snap-logout@example.com").await;
    server.get("/api/v1/sync/snapshot").await.assert_status_ok();

    server
        .post("/api/v1/auth/logout")
        .add_header("x-csrf-token", &csrf)
        .await
        .assert_status(StatusCode::NO_CONTENT);

    server
        .get("/api/v1/sync/snapshot")
        .await
        .assert_status(StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrations = "./migrations")]
async fn expired_session_is_unauthorized(pool: PgPool) {
    let server = server_for(state_for(pool.clone(), test_config()));
    register(&server, "snap-expired@example.com").await;

    sqlx::query("UPDATE web_sessions SET expires_at = now() - INTERVAL '1 hour'")
        .execute(&pool)
        .await
        .unwrap();

    server
        .get("/api/v1/sync/snapshot")
        .await
        .assert_status(StatusCode::UNAUTHORIZED);
}

/// A session call must not touch any device's `last_seen_at`, while a device
/// call still does (so the assertion would notice if the session path did).
#[sqlx::test(migrations = "./migrations")]
async fn session_call_does_not_touch_last_seen(pool: PgPool) {
    let server = server_for(state_for(pool.clone(), test_config()));
    register(&server, "snap-lastseen@example.com").await;
    let (device_id, token) = register_device(&server, "snap-lastseen@example.com", "Laptop").await;
    assert!(last_seen_is_null(&pool, device_id).await);

    server.get("/api/v1/sync/snapshot").await.assert_status_ok();
    // The device touch is a background task; give a wrongly spawned one time to land.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(
        last_seen_is_null(&pool, device_id).await,
        "a session snapshot read must leave last_seen_at alone"
    );

    server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&token)
        .await
        .assert_status_ok();
    let mut touched = false;
    for _ in 0..40 {
        if !last_seen_is_null(&pool, device_id).await {
            touched = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(touched, "a device snapshot read still updates last_seen_at");
}
