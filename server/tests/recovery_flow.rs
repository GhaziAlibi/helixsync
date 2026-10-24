//! Password recovery with the recovery code (docs/encryption.md §9.1):
//! `POST /auth/recover/prepare`, `POST /auth/recover/complete`, and
//! `PATCH /auth/recovery-code`.

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use axum_test::{TestServer, TestServerConfig, Transport};
use helixsync_server::config::Config;
use helixsync_server::crypto::hash_token;
use helixsync_server::middleware::rate_limit::{RateLimiter, RECOVER_EMAIL_LIMIT};
use helixsync_server::state::AppState;
use helixsync_server::websocket::ConnectionRegistry;
use serde_json::json;
use sqlx::PgPool;

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
    }
}

fn state_for(pool: PgPool) -> AppState {
    AppState {
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
/// The salt a recovery sets: bytes 16..32, a different valid salt than
/// `common::test_kdf_salt()`.
const NEW_KDF_SALT: &str = "EBESExQVFhcYGRobHB0eHw";

/// Registers `EMAIL` with `common::test_recovery_auth_key()` as its
/// recovery code and returns the CSRF token.
async fn register(browser: &TestServer) -> String {
    let res = browser
        .post("/api/v1/auth/register")
        .json(&json!({
            "email": EMAIL,
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

async fn login(browser: &TestServer, password_seed: &str) -> StatusCode {
    browser
        .post("/api/v1/auth/login")
        .json(&json!({ "email": EMAIL, "authKey": common::test_auth_key(password_seed) }))
        .await
        .status_code()
}

fn prepare_json(email: &str, recovery_auth_key: &str) -> serde_json::Value {
    json!({ "email": email, "recoveryAuthKey": recovery_auth_key })
}

/// Completes a recovery with `recovery_auth_key`, setting `NEW_PASSWORD` and
/// the recovery code `new_code_seed`.
fn complete_json(recovery_auth_key: &str, new_code_seed: &str) -> serde_json::Value {
    json!({
        "email": EMAIL,
        "recoveryAuthKey": recovery_auth_key,
        "newAuthKey": common::test_auth_key(NEW_PASSWORD),
        "newKdfSalt": NEW_KDF_SALT,
        "newKdfParams": common::test_kdf_params(),
        "newWrappedAk": "new-wrapped-account-key",
        "newRecoveryAuthKey": common::test_auth_key(new_code_seed),
        "newRecoveryWrappedAk": format!("recovery-wrapped-under-{new_code_seed}"),
    })
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

#[sqlx::test(migrations = "./migrations")]
async fn register_stores_only_a_hash_of_the_recovery_auth_key(pool: PgPool) {
    let state = state_for(pool.clone());
    register(&browser(&state)).await;

    let row = sqlx::query!(
        "SELECT recovery_auth_hash, recovery_wrapped_account_key FROM users WHERE email = $1",
        EMAIL
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row.recovery_auth_hash,
        hash_token(&common::test_recovery_auth_key())
    );
    assert_eq!(
        row.recovery_wrapped_account_key,
        common::test_recovery_wrapped_ak()
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn register_rejects_a_recovery_auth_key_that_is_not_32_bytes(pool: PgPool) {
    let state = state_for(pool.clone());
    let res = browser(&state)
        .post("/api/v1/auth/register")
        .json(&json!({
            "email": EMAIL,
            "authKey": common::test_auth_key(PASSWORD),
            "kdfSalt": common::test_kdf_salt(),
            "kdfParams": common::test_kdf_params(),
            "wrappedAk": common::test_wrapped_ak(),
            "recoveryAuthKey": "ABCD-EFGH-the-raw-code",
            "recoveryWrappedAk": common::test_recovery_wrapped_ak(),
        }))
        .await;
    res.assert_status(StatusCode::BAD_REQUEST);
    let users = sqlx::query_scalar!("SELECT count(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(users, Some(0));
}

#[sqlx::test(migrations = "./migrations")]
async fn prepare_returns_the_recovery_wrapped_key_for_the_right_code(pool: PgPool) {
    let state = state_for(pool);
    let server = browser(&state);
    register(&server).await;

    let res = server
        .post("/api/v1/auth/recover/prepare")
        .json(&prepare_json(EMAIL, &common::test_recovery_auth_key()))
        .await;
    res.assert_status_ok();
    assert_eq!(
        res.json::<serde_json::Value>()["recoveryWrappedAk"],
        common::test_recovery_wrapped_ak()
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn prepare_refuses_a_wrong_code_and_an_unknown_email_alike(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    register(&server).await;

    let wrong_code = server
        .post("/api/v1/auth/recover/prepare")
        .json(&prepare_json(EMAIL, &common::test_auth_key("wrong code")))
        .await;
    let unknown_email = server
        .post("/api/v1/auth/recover/prepare")
        .json(&prepare_json(
            "nobody@example.com",
            &common::test_recovery_auth_key(),
        ))
        .await;

    wrong_code.assert_status_unauthorized();
    unknown_email.assert_status_unauthorized();
    assert_eq!(
        wrong_code.json::<serde_json::Value>(),
        unknown_email.json::<serde_json::Value>(),
        "the two failures must be indistinguishable"
    );
    assert_eq!(audit_count(&pool, "password_recovery_failed").await, 2);
    let attributed = sqlx::query_scalar!(
        "SELECT count(*) FROM audit_logs WHERE event_type = 'password_recovery_failed' AND user_id IS NOT NULL"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        attributed,
        Some(1),
        "only the real account's failure is attributed"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn complete_resets_the_password_rotates_the_code_and_ends_every_session(pool: PgPool) {
    let state = state_for(pool.clone());
    let first = browser(&state);
    let second = browser(&state);
    let devices = browser(&state);
    register(&first).await;
    assert_eq!(login(&second, PASSWORD).await, StatusCode::OK);
    let device = devices
        .post("/api/v1/devices/register")
        .json(&json!({
            "email": EMAIL,
            "authKey": common::test_auth_key(PASSWORD),
            "name": "Laptop",
        }))
        .await;
    device.assert_status_ok();
    let access_token = device.json::<serde_json::Value>()["accessToken"]
        .as_str()
        .unwrap()
        .to_string();

    let res = first
        .post("/api/v1/auth/recover/complete")
        .json(&complete_json(
            &common::test_recovery_auth_key(),
            "second code",
        ))
        .await;
    res.assert_status(StatusCode::NO_CONTENT);

    // The new password works and the old one doesn't.
    let fresh = browser(&state);
    assert_eq!(login(&fresh, PASSWORD).await, StatusCode::UNAUTHORIZED);
    assert_eq!(login(&fresh, NEW_PASSWORD).await, StatusCode::OK);
    let me = fresh.get("/api/v1/auth/me").await;
    me.assert_status_ok();
    let me: serde_json::Value = me.json();
    assert_eq!(me["kdfSalt"], NEW_KDF_SALT);
    assert_eq!(me["wrappedAk"], "new-wrapped-account-key");

    // Every session from before the reset is gone.
    first
        .get("/api/v1/auth/me")
        .await
        .assert_status_unauthorized();
    second
        .get("/api/v1/auth/me")
        .await
        .assert_status_unauthorized();

    // The code worked once; the new one replaces it.
    fresh
        .post("/api/v1/auth/recover/prepare")
        .json(&prepare_json(EMAIL, &common::test_recovery_auth_key()))
        .await
        .assert_status_unauthorized();
    let prepared = fresh
        .post("/api/v1/auth/recover/prepare")
        .json(&prepare_json(EMAIL, &common::test_auth_key("second code")))
        .await;
    prepared.assert_status_ok();
    assert_eq!(
        prepared.json::<serde_json::Value>()["recoveryWrappedAk"],
        "recovery-wrapped-under-second code"
    );
    fresh
        .post("/api/v1/auth/recover/complete")
        .json(&complete_json(
            &common::test_recovery_auth_key(),
            "third code",
        ))
        .await
        .assert_status_unauthorized();

    // Devices keep syncing, as after a password change.
    devices
        .get("/api/v1/devices")
        .authorization_bearer(&access_token)
        .await
        .assert_status_ok();
    assert_eq!(audit_count(&pool, "password_recovered").await, 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn complete_with_a_wrong_code_changes_nothing(pool: PgPool) {
    let state = state_for(pool);
    let server = browser(&state);
    register(&server).await;

    server
        .post("/api/v1/auth/recover/complete")
        .json(&complete_json(
            &common::test_auth_key("wrong code"),
            "second code",
        ))
        .await
        .assert_status_unauthorized();

    let fresh = browser(&state);
    assert_eq!(login(&fresh, PASSWORD).await, StatusCode::OK);
    server.get("/api/v1/auth/me").await.assert_status_ok();
}

/// The new password's KDF fields are checked like at registration, before
/// the recovery code is: values no client accepts would lock the account
/// out, and the code must stay usable.
#[sqlx::test(migrations = "./migrations")]
async fn complete_rejects_malformed_kdf_fields_and_keeps_the_code(pool: PgPool) {
    let state = state_for(pool);
    let server = browser(&state);
    register(&server).await;

    let bad_fields = [
        ("newKdfSalt", json!("not-16-bytes")),
        ("newKdfParams", json!({ "m": 1, "t": 2, "p": 1 })),
        (
            "newKdfParams",
            json!({ "m": 19456, "t": 2, "p": 1, "extra": 1 }),
        ),
        ("newWrappedAk", json!("x".repeat(2000))),
        ("newRecoveryWrappedAk", json!("x".repeat(2000))),
    ];
    for (field, value) in bad_fields {
        let mut body = complete_json(&common::test_recovery_auth_key(), "second code");
        body[field] = value;
        server
            .post("/api/v1/auth/recover/complete")
            .json(&body)
            .await
            .assert_status(StatusCode::BAD_REQUEST);
    }

    // Nothing changed: the old password still works and the code is unused.
    let fresh = browser(&state);
    assert_eq!(login(&fresh, PASSWORD).await, StatusCode::OK);
    server
        .post("/api/v1/auth/recover/complete")
        .json(&complete_json(
            &common::test_recovery_auth_key(),
            "second code",
        ))
        .await
        .assert_status(StatusCode::NO_CONTENT);
}

fn regenerate_json(current_password_seed: &str, new_code_seed: &str) -> serde_json::Value {
    json!({
        "currentAuthKey": common::test_auth_key(current_password_seed),
        "recoveryAuthKey": common::test_auth_key(new_code_seed),
        "recoveryWrappedAk": format!("recovery-wrapped-under-{new_code_seed}"),
    })
}

#[sqlx::test(migrations = "./migrations")]
async fn regenerate_needs_the_current_password_and_replaces_the_code(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    let csrf = register(&server).await;

    server
        .patch("/api/v1/auth/recovery-code")
        .add_header("x-csrf-token", &csrf)
        .json(&regenerate_json("not the password", "second code"))
        .await
        .assert_status_unauthorized();
    assert_eq!(
        audit_count(&pool, "recovery_code_regenerate_failed").await,
        1
    );

    server
        .patch("/api/v1/auth/recovery-code")
        .add_header("x-csrf-token", &csrf)
        .json(&regenerate_json(PASSWORD, "second code"))
        .await
        .assert_status_ok();
    assert_eq!(audit_count(&pool, "recovery_code_regenerated").await, 1);

    server
        .post("/api/v1/auth/recover/prepare")
        .json(&prepare_json(EMAIL, &common::test_recovery_auth_key()))
        .await
        .assert_status_unauthorized();
    let prepared = server
        .post("/api/v1/auth/recover/prepare")
        .json(&prepare_json(EMAIL, &common::test_auth_key("second code")))
        .await;
    prepared.assert_status_ok();
    assert_eq!(
        prepared.json::<serde_json::Value>()["recoveryWrappedAk"],
        "recovery-wrapped-under-second code"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn regenerate_rejects_an_oversized_wrapped_key(pool: PgPool) {
    let state = state_for(pool);
    let server = browser(&state);
    let csrf = register(&server).await;

    let mut body = regenerate_json(PASSWORD, "second code");
    body["recoveryWrappedAk"] = json!("x".repeat(2000));
    server
        .patch("/api/v1/auth/recovery-code")
        .add_header("x-csrf-token", &csrf)
        .json(&body)
        .await
        .assert_status(StatusCode::BAD_REQUEST);

    // The original code still works.
    server
        .post("/api/v1/auth/recover/prepare")
        .json(&prepare_json(EMAIL, &common::test_recovery_auth_key()))
        .await
        .assert_status_ok();
}

#[sqlx::test(migrations = "./migrations")]
async fn regenerate_requires_a_csrf_token(pool: PgPool) {
    let state = state_for(pool);
    let server = browser(&state);
    register(&server).await;

    server
        .patch("/api/v1/auth/recovery-code")
        .json(&regenerate_json(PASSWORD, "second code"))
        .await
        .assert_status(StatusCode::FORBIDDEN);
}

#[sqlx::test(migrations = "./migrations")]
async fn recovery_attempts_are_rate_limited_per_email(pool: PgPool) {
    let state = state_for(pool);
    let server = browser(&state);
    register(&server).await;

    let mut statuses = Vec::new();
    for _ in 0..(RECOVER_EMAIL_LIMIT.limit + 1) {
        let res = server
            .post("/api/v1/auth/recover/prepare")
            .json(&prepare_json(EMAIL, &common::test_auth_key("guess")))
            .await;
        statuses.push(res.status_code());
    }
    assert!(
        statuses[..RECOVER_EMAIL_LIMIT.limit as usize]
            .iter()
            .all(|s| *s == StatusCode::UNAUTHORIZED),
        "{statuses:?}"
    );
    assert_eq!(*statuses.last().unwrap(), StatusCode::TOO_MANY_REQUESTS);
}
