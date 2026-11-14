//! Two-device password reset (docs/encryption.md §9.4): a `reset` request
//! needs two different connected devices to approve; only the second carries
//! the account key; `POST /auth/requests/{id}/reset` then swaps the password.

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use axum_test::{TestServer, TestServerConfig, Transport};
use helixsync_server::config::Config;
use helixsync_server::middleware::rate_limit::RateLimiter;
use helixsync_server::state::AppState;
use helixsync_server::websocket::ConnectionRegistry;
use serde_json::json;
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

/// One "browser": its own cookie jar in front of a shared `AppState`.
fn browser(state: &AppState) -> TestServer {
    let config = TestServerConfig {
        transport: Some(Transport::HttpRandomPort),
        save_cookies: true,
        ..Default::default()
    };
    TestServer::new_with_config(
        helixsync_server::app(state.clone())
            .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        config,
    )
}

const EMAIL: &str = "owner@example.com";
const PASSWORD: &str = "correct horse battery staple";
const NEW_PASSWORD: &str = "a brand new passphrase";
const NEW_KDF_SALT: &str = "EBESExQVFhcYGRobHB0eHw";

/// Registers `email` and returns the CSRF token.
async fn register(browser: &TestServer, email: &str) -> String {
    let res = browser
        .post("/api/v1/auth/register")
        .json(&json!({
            "email": email,
            "authKey": common::test_auth_key(PASSWORD),
            "kdfSalt": common::test_kdf_salt(),
            "kdfParams": common::test_kdf_params(),
            "wrappedAk": common::test_wrapped_ak(),
            "recoveryAuthKey": common::test_recovery_auth_key(),
            "recoveryWrappedAk": common::test_recovery_wrapped_ak(),
        }))
        .await;
    res.assert_status_ok();
    res.json::<serde_json::Value>()["csrfToken"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Connects a device with the password and returns `(device_id, access_token)`.
async fn register_device(server: &TestServer, email: &str, name: &str) -> (Uuid, String) {
    let res = server
        .post("/api/v1/devices/register")
        .json(&json!({
            "email": email,
            "authKey": common::test_auth_key(PASSWORD),
            "name": name,
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    (
        body["deviceId"].as_str().unwrap().parse().unwrap(),
        body["accessToken"].as_str().unwrap().to_string(),
    )
}

/// A syntactically valid uncompressed P-256 point, distinct per `seed`.
fn public_key(seed: u8) -> String {
    let mut point = [seed; 65];
    point[0] = 0x04;
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, point)
}

/// Starts a reset request and returns `(id, secret)`.
async fn create_reset(server: &TestServer, email: &str) -> (String, String) {
    let res = server
        .post("/api/v1/auth/requests")
        .json(&json!({ "email": email, "kind": "reset", "publicKey": public_key(1) }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    (
        body["id"].as_str().unwrap().to_string(),
        body["secret"].as_str().unwrap().to_string(),
    )
}

async fn poll(server: &TestServer, id: &str, secret: &str) -> serde_json::Value {
    let res = server
        .post(&format!("/api/v1/auth/requests/{id}/poll"))
        .json(&json!({ "secret": secret }))
        .await;
    res.assert_status_ok();
    res.json()
}

fn key_material() -> serde_json::Value {
    json!({
        "approve": true,
        "encryptedAccountKey": "{\"v\":1,\"alg\":\"xchacha20poly1305\",\"nonce\":\"n\",\"ciphertext\":\"c\"}",
        "approverPublicKey": public_key(2),
    })
}

async fn respond(
    server: &TestServer,
    access_token: &str,
    id: &str,
    body: serde_json::Value,
) -> axum_test::TestResponse {
    server
        .post(&format!("/api/v1/devices/auth-requests/{id}/respond"))
        .authorization_bearer(access_token)
        .json(&body)
        .await
}

async fn pending_for(server: &TestServer, access_token: &str) -> Vec<serde_json::Value> {
    let res = server
        .get("/api/v1/devices/auth-requests")
        .authorization_bearer(access_token)
        .await;
    res.assert_status_ok();
    res.json::<Vec<serde_json::Value>>()
}

fn reset_json(secret: &str) -> serde_json::Value {
    json!({
        "secret": secret,
        "newAuthKey": common::test_auth_key(NEW_PASSWORD),
        "newKdfSalt": NEW_KDF_SALT,
        "newKdfParams": common::test_kdf_params(),
        "newWrappedAk": "new-wrapped-account-key",
        "newRecoveryAuthKey": common::test_auth_key("fresh code"),
        "newRecoveryWrappedAk": "recovery-wrapped-under-fresh code",
    })
}

async fn complete(
    server: &TestServer,
    id: &str,
    body: serde_json::Value,
) -> axum_test::TestResponse {
    server
        .post(&format!("/api/v1/auth/requests/{id}/reset"))
        .json(&body)
        .await
}

async fn audit_count(pool: &PgPool, event_type: &str) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit_logs WHERE event_type = $1")
        .bind(event_type)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// An account with two connected devices; returns their tokens.
struct Account {
    server: TestServer,
    first: (Uuid, String),
    second: (Uuid, String),
}

async fn account_with_two_devices(state: &AppState) -> Account {
    let server = browser(state);
    register(&server, EMAIL).await;
    let first = register_device(&server, EMAIL, "Desktop").await;
    let second = register_device(&server, EMAIL, "Laptop").await;
    Account {
        server,
        first,
        second,
    }
}

async fn login_status(server: &TestServer, password: &str) -> StatusCode {
    server
        .post("/api/v1/auth/login")
        .json(&json!({ "email": EMAIL, "authKey": common::test_auth_key(password) }))
        .await
        .status_code()
}

#[sqlx::test(migrations = "./migrations")]
async fn one_approval_is_not_enough_and_carries_no_key(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let a = account_with_two_devices(&state).await;
    let (id, secret) = create_reset(&browser(&state), EMAIL).await;

    // Both devices see it, marked with its kind and 0 approvals.
    let pending = pending_for(&a.server, &a.first.1).await;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["kind"], "reset");
    assert_eq!(pending[0]["approvals"], 0);

    // The first approval must carry no key.
    respond(&a.server, &a.first.1, &id, key_material())
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    respond(&a.server, &a.first.1, &id, json!({ "approve": true }))
        .await
        .assert_status_ok();
    assert_eq!(audit_count(&pool, "password_reset_first_approval").await, 1);

    assert_eq!(poll(&a.server, &id, &secret).await["status"], "pending");
    complete(&a.server, &id, reset_json(&secret))
        .await
        .assert_status_unauthorized();
    assert_eq!(login_status(&a.server, PASSWORD).await, StatusCode::OK);

    // It is hidden from the approver, and shows "1" to the other device.
    assert!(pending_for(&a.server, &a.first.1).await.is_empty());
    let pending = pending_for(&a.server, &a.second.1).await;
    assert_eq!(pending[0]["approvals"], 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn the_same_device_approving_twice_is_rejected(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let a = account_with_two_devices(&state).await;
    let (id, secret) = create_reset(&browser(&state), EMAIL).await;

    respond(&a.server, &a.first.1, &id, json!({ "approve": true }))
        .await
        .assert_status_ok();
    respond(&a.server, &a.first.1, &id, key_material())
        .await
        .assert_status(StatusCode::CONFLICT);

    assert_eq!(poll(&a.server, &id, &secret).await["status"], "pending");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_request_approvals")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn two_distinct_devices_approve_and_the_reset_completes_once(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let a = account_with_two_devices(&state).await;
    let dashboard = browser(&state);
    register(&dashboard, "other@example.com").await; // an unrelated account
    let (id, secret) = create_reset(&browser(&state), EMAIL).await;

    // A second approval needs the key.
    respond(&a.server, &a.first.1, &id, json!({ "approve": true }))
        .await
        .assert_status_ok();
    respond(&a.server, &a.second.1, &id, json!({ "approve": true }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    respond(&a.server, &a.second.1, &id, key_material())
        .await
        .assert_status_ok();

    // Polling returns the key material and does not consume it.
    for _ in 0..2 {
        let body = poll(&a.server, &id, &secret).await;
        assert_eq!(body["status"], "approved");
        assert_eq!(body["approverPublicKey"], public_key(2));
        assert_eq!(
            body["encryptedAccountKey"],
            key_material()["encryptedAccountKey"]
        );
    }

    // A wrong secret can't complete it.
    complete(&a.server, &id, reset_json("not-the-secret"))
        .await
        .assert_status_unauthorized();

    complete(&a.server, &id, reset_json(&secret))
        .await
        .assert_status(StatusCode::NO_CONTENT);
    assert_eq!(audit_count(&pool, "password_reset_by_devices").await, 1);

    // The new password works, the old one doesn't, and the flag is reset.
    let fresh = browser(&state);
    assert_eq!(
        login_status(&fresh, PASSWORD).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(login_status(&fresh, NEW_PASSWORD).await, StatusCode::OK);
    let me: serde_json::Value = fresh.get("/api/v1/auth/me").await.json();
    assert_eq!(me["wrappedAk"], "new-wrapped-account-key");
    assert_eq!(me["recoveryCodeConfirmed"], false);

    // Sessions from before are gone; device credentials still work.
    a.server
        .get("/api/v1/auth/me")
        .await
        .assert_status_unauthorized();
    a.server
        .get("/api/v1/devices/auth-requests")
        .authorization_bearer(&a.first.1)
        .await
        .assert_status_ok();

    // The new recovery code works for recovery, and the request is consumed.
    fresh
        .post("/api/v1/auth/recover/prepare")
        .json(&json!({ "email": EMAIL, "recoveryAuthKey": common::test_auth_key("fresh code") }))
        .await
        .assert_status_ok();
    assert_eq!(poll(&fresh, &id, &secret).await["status"], "expired");
    complete(&fresh, &id, reset_json(&secret))
        .await
        .assert_status_unauthorized();
}

#[sqlx::test(migrations = "./migrations")]
async fn a_denial_from_any_device_wins(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let a = account_with_two_devices(&state).await;
    let (id, secret) = create_reset(&browser(&state), EMAIL).await;

    respond(&a.server, &a.first.1, &id, json!({ "approve": true }))
        .await
        .assert_status_ok();
    respond(&a.server, &a.second.1, &id, json!({ "approve": false }))
        .await
        .assert_status_ok();

    assert_eq!(poll(&a.server, &id, &secret).await["status"], "denied");
    respond(&a.server, &a.first.1, &id, key_material())
        .await
        .assert_status_not_found();
    complete(&a.server, &id, reset_json(&secret))
        .await
        .assert_status_unauthorized();
    assert_eq!(login_status(&a.server, PASSWORD).await, StatusCode::OK);
}

#[sqlx::test(migrations = "./migrations")]
async fn a_revoked_approver_no_longer_counts(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let a = account_with_two_devices(&state).await;
    let (id, secret) = create_reset(&browser(&state), EMAIL).await;

    respond(&a.server, &a.first.1, &id, json!({ "approve": true }))
        .await
        .assert_status_ok();
    respond(&a.server, &a.second.1, &id, key_material())
        .await
        .assert_status_ok();
    sqlx::query("UPDATE devices SET revoked_at = now() WHERE id = $1")
        .bind(a.first.0)
        .execute(&pool)
        .await
        .unwrap();

    complete(&a.server, &id, reset_json(&secret))
        .await
        .assert_status_unauthorized();
    assert_eq!(login_status(&a.server, PASSWORD).await, StatusCode::OK);
}

#[sqlx::test(migrations = "./migrations")]
async fn an_expired_request_cannot_be_approved_or_completed(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let a = account_with_two_devices(&state).await;
    let (id, secret) = create_reset(&browser(&state), EMAIL).await;
    respond(&a.server, &a.first.1, &id, json!({ "approve": true }))
        .await
        .assert_status_ok();
    respond(&a.server, &a.second.1, &id, key_material())
        .await
        .assert_status_ok();

    sqlx::query("UPDATE auth_requests SET expires_at = now() - INTERVAL '1 second'")
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(poll(&a.server, &id, &secret).await["status"], "expired");
    complete(&a.server, &id, reset_json(&secret))
        .await
        .assert_status_unauthorized();
    assert_eq!(login_status(&a.server, PASSWORD).await, StatusCode::OK);

    // And a fresh one can't be approved after it lapses.
    let (late_id, _) = create_reset(&browser(&state), EMAIL).await;
    sqlx::query("UPDATE auth_requests SET expires_at = now() - INTERVAL '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    respond(&a.server, &a.first.1, &late_id, json!({ "approve": true }))
        .await
        .assert_status_not_found();
}

#[sqlx::test(migrations = "./migrations")]
async fn an_unknown_email_looks_real_but_stores_nothing(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let a = account_with_two_devices(&state).await;

    let (unknown_id, unknown_secret) = create_reset(&browser(&state), "nobody@example.com").await;

    let stored: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_requests")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored, 0);
    assert!(pending_for(&a.server, &a.first.1).await.is_empty());
    assert_eq!(
        poll(&a.server, &unknown_id, &unknown_secret).await["status"],
        "pending"
    );
    complete(&a.server, &unknown_id, reset_json(&unknown_secret))
        .await
        .assert_status_unauthorized();
}

#[sqlx::test(migrations = "./migrations")]
async fn an_account_with_one_device_can_never_complete(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let server = browser(&state);
    register(&server, EMAIL).await;
    let (_, token) = register_device(&server, EMAIL, "Only device").await;
    let (id, secret) = create_reset(&browser(&state), EMAIL).await;

    respond(&server, &token, &id, json!({ "approve": true }))
        .await
        .assert_status_ok();
    // Nothing more can approve it, and it stays pending.
    respond(&server, &token, &id, key_material())
        .await
        .assert_status(StatusCode::CONFLICT);
    assert_eq!(poll(&server, &id, &secret).await["status"], "pending");
    complete(&server, &id, reset_json(&secret))
        .await
        .assert_status_unauthorized();
}

#[sqlx::test(migrations = "./migrations")]
async fn a_reset_cannot_be_completed_with_a_malformed_body(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let a = account_with_two_devices(&state).await;
    let (id, secret) = create_reset(&browser(&state), EMAIL).await;
    respond(&a.server, &a.first.1, &id, json!({ "approve": true }))
        .await
        .assert_status_ok();
    respond(&a.server, &a.second.1, &id, key_material())
        .await
        .assert_status_ok();

    let mut body = reset_json(&secret);
    body["newAuthKey"] = json!("not-32-bytes");
    complete(&a.server, &id, body)
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    // The request is still usable.
    complete(&a.server, &id, reset_json(&secret))
        .await
        .assert_status(StatusCode::NO_CONTENT);
}
