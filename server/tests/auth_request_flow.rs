//! Login with device (docs/protocol.md §7.4): `POST /auth/requests`,
//! `POST /auth/requests/{id}/poll`, `GET /devices/auth-requests` and
//! `POST /devices/auth-requests/{id}/respond`.

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use axum_test::{TestServer, TestServerConfig, Transport};
use helixsync_server::auth::extractors::SESSION_COOKIE_NAME;
use helixsync_server::config::Config;
use helixsync_server::middleware::rate_limit::{RateLimiter, AUTH_REQUEST_EMAIL_LIMIT};
use helixsync_server::state::AppState;
use helixsync_server::websocket::ConnectionRegistry;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

fn test_config() -> Config {
    Config {
        database_url: String::new(),
        bind_addr: "127.0.0.1:0".into(),
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

/// A syntactically valid uncompressed P-256 point, distinct per `seed`. The
/// server only checks the shape; the clients do the real ECDH.
fn public_key(seed: u8) -> String {
    let mut point = [seed; 65];
    point[0] = 0x04;
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, point)
}

/// Starts a request and returns `(id, secret)`.
async fn create(server: &TestServer, email: &str, kind: &str) -> (String, String) {
    let mut body = json!({ "email": email, "kind": kind, "publicKey": public_key(1) });
    if kind == "device" {
        body["deviceName"] = json!("New laptop");
    }
    let res = server.post("/api/v1/auth/requests").json(&body).await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(body["expiresAt"].is_string());
    (
        body["id"].as_str().unwrap().to_string(),
        body["secret"].as_str().unwrap().to_string(),
    )
}

async fn poll(server: &TestServer, id: &str, secret: &str) -> axum_test::TestResponse {
    server
        .post(&format!("/api/v1/auth/requests/{id}/poll"))
        .json(&json!({
            "secret": secret,
            "browser": "helium",
            "extensionVersion": "9.9.9",
        }))
        .await
}

async fn poll_status(server: &TestServer, id: &str, secret: &str) -> String {
    let res = poll(server, id, secret).await;
    res.assert_status_ok();
    res.json::<serde_json::Value>()["status"]
        .as_str()
        .unwrap()
        .to_string()
}

fn approve_device_json() -> serde_json::Value {
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

async fn audit_count(pool: &PgPool, event_type: &str) -> i64 {
    sqlx::query_scalar!(
        "SELECT count(*) FROM audit_logs WHERE event_type = $1",
        event_type
    )
    .fetch_one(pool)
    .await
    .unwrap()
    .unwrap_or(0)
}

async fn request_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar!("SELECT count(*) FROM auth_requests")
        .fetch_one(pool)
        .await
        .unwrap()
        .unwrap_or(0)
}

#[sqlx::test(migrations = "./migrations")]
async fn a_request_for_an_unknown_email_looks_real_but_stores_nothing(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let server = browser(&state);
    register(&server, EMAIL).await;

    let (_, _) = create(&server, EMAIL, "web").await;
    let (unknown_id, unknown_secret) = create(&server, "nobody@example.com", "web").await;

    assert_eq!(request_count(&pool).await, 1);
    assert_eq!(
        poll_status(&server, &unknown_id, &unknown_secret).await,
        "pending"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn an_approved_new_browser_gets_its_device_and_the_encrypted_key_once(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let dashboard = browser(&state);
    let approver = browser(&state);
    let new_browser = browser(&state);
    register(&dashboard, EMAIL).await;
    let (_, approver_token) = register_device(&approver, EMAIL, "Desktop").await;

    let (id, secret) = create(&new_browser, EMAIL, "device").await;

    let pending = pending_for(&approver, &approver_token).await;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["id"], id);
    assert_eq!(pending[0]["kind"], "device");
    assert_eq!(pending[0]["deviceName"], "New laptop");
    assert_eq!(pending[0]["publicKey"], public_key(1));
    assert!(pending[0]["requestIp"].is_string());
    assert_eq!(poll_status(&new_browser, &id, &secret).await, "pending");

    respond(&approver, &approver_token, &id, approve_device_json())
        .await
        .assert_status_ok();

    let res = poll(&new_browser, &id, &secret).await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["status"], "approved");
    assert_eq!(
        body["encryptedAccountKey"],
        approve_device_json()["encryptedAccountKey"]
    );
    assert_eq!(body["approverPublicKey"], public_key(2));
    assert_eq!(body["accountKeyVersion"], 1);
    assert!(body["refreshToken"].is_string());
    let device_id: Uuid = body["deviceId"].as_str().unwrap().parse().unwrap();
    let access_token = body["accessToken"].as_str().unwrap();

    // The new credentials work, and the device row carries the reported details.
    new_browser
        .get("/api/v1/devices")
        .authorization_bearer(access_token)
        .await
        .assert_status_ok();
    let device = sqlx::query!(
        "SELECT name, browser, extension_version FROM devices WHERE id = $1",
        device_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(device.name, "New laptop");
    assert_eq!(device.browser.as_deref(), Some("helium"));
    assert_eq!(device.extension_version.as_deref(), Some("9.9.9"));

    // Collected once; the request is gone from the approver's list.
    assert_eq!(poll_status(&new_browser, &id, &secret).await, "expired");
    assert!(pending_for(&approver, &approver_token).await.is_empty());
    assert_eq!(audit_count(&pool, "auth_request_approved").await, 1);
    assert_eq!(audit_count(&pool, "login_with_device_succeeded").await, 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn an_approved_dashboard_login_starts_a_session(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let setup = browser(&state);
    let approver = browser(&state);
    let dashboard = browser(&state);
    register(&setup, EMAIL).await;
    let (_, approver_token) = register_device(&approver, EMAIL, "Desktop").await;

    let (id, secret) = create(&dashboard, EMAIL, "web").await;
    dashboard
        .get("/api/v1/auth/me")
        .await
        .assert_status_unauthorized();

    respond(&approver, &approver_token, &id, json!({ "approve": true }))
        .await
        .assert_status_ok();

    let res = poll(&dashboard, &id, &secret).await;
    res.assert_status_ok();
    assert!(res.maybe_cookie(SESSION_COOKIE_NAME).is_some());
    let body: serde_json::Value = res.json();
    assert_eq!(body["status"], "approved");
    assert_eq!(body["user"]["email"], EMAIL);
    assert!(body["csrfToken"].is_string());
    assert!(
        body.get("encryptedAccountKey").is_none(),
        "a dashboard never receives the account key"
    );
    dashboard.get("/api/v1/auth/me").await.assert_status_ok();
    assert_eq!(poll_status(&dashboard, &id, &secret).await, "expired");
}

#[sqlx::test(migrations = "./migrations")]
async fn the_account_key_goes_only_to_an_approved_new_browser(pool: PgPool) {
    let state = state_for(pool, test_config());
    let server = browser(&state);
    register(&server, EMAIL).await;
    let (_, token) = register_device(&server, EMAIL, "Desktop").await;
    let (web_id, _) = create(&server, EMAIL, "web").await;
    let (device_id, _) = create(&server, EMAIL, "device").await;

    respond(&server, &token, &web_id, approve_device_json())
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    respond(&server, &token, &device_id, json!({ "approve": true }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    respond(
        &server,
        &token,
        &device_id,
        json!({ "approve": false, "encryptedAccountKey": "x", "approverPublicKey": public_key(2) }),
    )
    .await
    .assert_status(StatusCode::BAD_REQUEST);
    let mut bad_key = approve_device_json();
    bad_key["approverPublicKey"] = json!("not-a-point");
    respond(&server, &token, &device_id, bad_key)
        .await
        .assert_status(StatusCode::BAD_REQUEST);

    // Nothing above answered either request.
    assert_eq!(pending_for(&server, &token).await.len(), 2);
}

#[sqlx::test(migrations = "./migrations")]
async fn a_denied_request_reads_denied_and_cannot_be_answered_again(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let server = browser(&state);
    register(&server, EMAIL).await;
    let (_, token) = register_device(&server, EMAIL, "Desktop").await;
    let (id, secret) = create(&server, EMAIL, "device").await;

    respond(&server, &token, &id, json!({ "approve": false }))
        .await
        .assert_status_ok();

    assert_eq!(poll_status(&server, &id, &secret).await, "denied");
    respond(&server, &token, &id, approve_device_json())
        .await
        .assert_status_not_found();
    assert_eq!(audit_count(&pool, "auth_request_denied").await, 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn an_expired_request_cannot_be_answered_or_collected(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let server = browser(&state);
    register(&server, EMAIL).await;
    let (_, token) = register_device(&server, EMAIL, "Desktop").await;
    let (id, secret) = create(&server, EMAIL, "device").await;
    respond(&server, &token, &id, approve_device_json())
        .await
        .assert_status_ok();
    let (unanswered_id, _) = create(&server, EMAIL, "web").await;

    sqlx::query!("UPDATE auth_requests SET expires_at = now() - INTERVAL '1 second'")
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(poll_status(&server, &id, &secret).await, "expired");
    assert!(pending_for(&server, &token).await.is_empty());
    respond(&server, &token, &unanswered_id, json!({ "approve": true }))
        .await
        .assert_status_not_found();

    helixsync_server::housekeeping::run_once(&state).await;
    assert_eq!(request_count(&pool).await, 0);
}

#[sqlx::test(migrations = "./migrations")]
async fn a_wrong_secret_reads_as_pending_and_collects_nothing(pool: PgPool) {
    let state = state_for(pool, test_config());
    let server = browser(&state);
    register(&server, EMAIL).await;
    let (_, token) = register_device(&server, EMAIL, "Desktop").await;
    let (id, secret) = create(&server, EMAIL, "device").await;
    respond(&server, &token, &id, approve_device_json())
        .await
        .assert_status_ok();

    assert_eq!(poll_status(&server, &id, "not-the-secret").await, "pending");
    assert_eq!(poll_status(&server, &id, &secret).await, "approved");
}

#[sqlx::test(migrations = "./migrations")]
async fn another_accounts_devices_cannot_see_or_answer_a_request(pool: PgPool) {
    let state = state_for(pool, test_config());
    let server = browser(&state);
    register(&server, EMAIL).await;
    register(&browser(&state), "stranger@example.com").await;
    let (_, stranger_token) = register_device(&server, "stranger@example.com", "Theirs").await;
    let (id, _) = create(&server, EMAIL, "device").await;

    assert!(pending_for(&server, &stranger_token).await.is_empty());
    respond(&server, &stranger_token, &id, approve_device_json())
        .await
        .assert_status_not_found();
}

#[sqlx::test(migrations = "./migrations")]
async fn creating_or_answering_a_request_pings_the_accounts_sockets(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let server = browser(&state);
    register(&server, EMAIL).await;
    let (device_id, token) = register_device(&server, EMAIL, "Desktop").await;
    let user_id = sqlx::query_scalar!("SELECT id FROM users WHERE email = $1", EMAIL)
        .fetch_one(&pool)
        .await
        .unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(4);
    state.ws_registry.register(user_id, device_id, tx);

    let (id, _) = create(&server, EMAIL, "web").await;
    assert_eq!(
        rx.recv().await.as_deref(),
        Some(r#"{"type":"auth_request"}"#)
    );

    respond(&server, &token, &id, json!({ "approve": false }))
        .await
        .assert_status_ok();
    assert_eq!(
        rx.recv().await.as_deref(),
        Some(r#"{"type":"auth_request"}"#)
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn an_approval_waits_out_the_device_cap(pool: PgPool) {
    let state = state_for(
        pool,
        Config {
            max_devices_per_account: 1,
            ..test_config()
        },
    );
    let dashboard = browser(&state);
    let csrf = register(&dashboard, EMAIL).await;
    let (approver_id, approver_token) = register_device(&dashboard, EMAIL, "Desktop").await;
    let (id, secret) = create(&dashboard, EMAIL, "device").await;
    respond(&dashboard, &approver_token, &id, approve_device_json())
        .await
        .assert_status_ok();

    let res = poll(&dashboard, &id, &secret).await;
    res.assert_status(StatusCode::CONFLICT);
    assert_eq!(
        res.json::<serde_json::Value>()["error"],
        "device_limit_reached"
    );

    dashboard
        .post(&format!("/api/v1/devices/{approver_id}/revoke"))
        .add_header("x-csrf-token", &csrf)
        .await
        .assert_status_ok();
    assert_eq!(poll_status(&dashboard, &id, &secret).await, "approved");
}

#[sqlx::test(migrations = "./migrations")]
async fn requests_are_validated(pool: PgPool) {
    let state = state_for(pool, test_config());
    let server = browser(&state);
    register(&server, EMAIL).await;

    server
        .post("/api/v1/auth/requests")
        .json(&json!({ "email": EMAIL, "kind": "web", "publicKey": "short" }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    server
        .post("/api/v1/auth/requests")
        .json(&json!({ "email": EMAIL, "kind": "device", "publicKey": public_key(1) }))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
}

#[sqlx::test(migrations = "./migrations")]
async fn requests_are_rate_limited_per_email(pool: PgPool) {
    let state = state_for(pool, test_config());
    let server = browser(&state);
    register(&server, EMAIL).await;

    for _ in 0..AUTH_REQUEST_EMAIL_LIMIT.limit {
        create(&server, EMAIL, "web").await;
    }
    server
        .post("/api/v1/auth/requests")
        .json(&json!({ "email": EMAIL, "kind": "web", "publicKey": public_key(1) }))
        .await
        .assert_status(StatusCode::TOO_MANY_REQUESTS);
}
