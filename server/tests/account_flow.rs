//! Account lifecycle: the `ALLOW_REGISTRATION` switch, account deletion
//! (`DELETE /auth/account`) and a device revoking itself
//! (`POST /devices/self/revoke`).

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use axum_test::{TestServer, TestServerConfig, Transport};
use helixsync_server::auth::extractors::{CSRF_COOKIE_NAME, SESSION_COOKIE_NAME};
use helixsync_server::config::Config;
use helixsync_server::middleware::rate_limit::{RateLimiter, ACCOUNT_DELETE_LIMIT, REGISTER_LIMIT};
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

/// One "browser": its own cookie jar in front of a shared `AppState`, so
/// several browsers see the same in-memory caches a real process would have.
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

fn register_json(email: &str, password_seed: &str) -> serde_json::Value {
    json!({
        "email": email,
        "authKey": common::test_auth_key(password_seed),
        "kdfSalt": common::test_kdf_salt(),
        "kdfParams": common::test_kdf_params(),
        "wrappedAk": common::test_wrapped_ak(),
    })
}

const PASSWORD: &str = "correct horse battery staple";

/// Registers `email` through `browser` and returns its CSRF token.
async fn register(browser: &TestServer, email: &str) -> String {
    let res = browser
        .post("/api/v1/auth/register")
        .json(&register_json(email, PASSWORD))
        .await;
    res.assert_status_ok();
    res.json::<serde_json::Value>()["csrfToken"]
        .as_str()
        .unwrap()
        .to_string()
}

struct DeviceTokens {
    device_id: Uuid,
    access_token: String,
    refresh_token: String,
}

async fn register_device(server: &TestServer, email: &str, name: &str) -> DeviceTokens {
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
    DeviceTokens {
        device_id: body["deviceId"].as_str().unwrap().parse().unwrap(),
        access_token: body["accessToken"].as_str().unwrap().to_string(),
        refresh_token: body["refreshToken"].as_str().unwrap().to_string(),
    }
}

fn bookmark_op(sequence: i64) -> serde_json::Value {
    json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": sequence,
        "lamportTimestamp": sequence,
        "objectType": "bookmark",
        "objectId": Uuid::now_v7(),
        "operationType": "create",
        "encryptionVersion": 0,
        "payload": { "title": "Example", "url": "https://example.com", "parent": null, "position": "a0" }
    })
}

async fn upload_one_op(server: &TestServer, access_token: &str) {
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(access_token)
        .json(&json!({ "operations": [bookmark_op(1)] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["accepted"].as_array().unwrap().len(), 1);
}

async fn user_id_for(pool: &PgPool, email: &str) -> Uuid {
    sqlx::query_scalar!("SELECT id FROM users WHERE email = $1", email)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn count_users(pool: &PgPool) -> i64 {
    sqlx::query_scalar!("SELECT count(*) FROM users")
        .fetch_one(pool)
        .await
        .unwrap()
        .unwrap_or(0)
}

/// Rows owned by `user_id` across every table that references the account,
/// as `(table, count)`. Used to assert deletion left nothing behind and
/// touched nothing of another account.
async fn rows_owned_by(pool: &PgPool, user_id: Uuid) -> Vec<(&'static str, i64)> {
    macro_rules! count {
        ($table:literal) => {
            (
                $table,
                sqlx::query_scalar(&format!(
                    "SELECT count(*) FROM {} WHERE {} = $1",
                    $table,
                    if $table == "users" { "id" } else { "user_id" }
                ))
                .bind(user_id)
                .fetch_one(pool)
                .await
                .unwrap(),
            )
        };
    }
    vec![
        count!("users"),
        count!("user_settings"),
        count!("devices"),
        count!("sync_operations"),
        count!("sync_cursors"),
        count!("sync_stats"),
        count!("web_sessions"),
    ]
}

async fn device_credential_count(pool: &PgPool, device_id: Uuid) -> i64 {
    sqlx::query_scalar!(
        "SELECT count(*) FROM device_credentials WHERE device_id = $1",
        device_id
    )
    .fetch_one(pool)
    .await
    .unwrap()
    .unwrap_or(0)
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

// --- ALLOW_REGISTRATION ---

#[sqlx::test(migrations = "./migrations")]
async fn disabled_registration_returns_403_with_its_own_error_code(pool: PgPool) {
    let state = state_for(
        pool.clone(),
        Config {
            allow_registration: false,
            ..test_config()
        },
    );
    let server = browser(&state);

    let res = server
        .post("/api/v1/auth/register")
        .json(&register_json("closed@example.com", PASSWORD))
        .await;
    res.assert_status(StatusCode::FORBIDDEN);
    let body: serde_json::Value = res.json();
    assert_eq!(body["error"], "registration_disabled");
    assert!(
        body["message"].as_str().unwrap().contains("disabled"),
        "the message must tell the user why: {body}"
    );
    assert_eq!(count_users(&pool).await, 0, "no account may be created");
    assert!(
        res.maybe_cookie(SESSION_COOKIE_NAME).is_none(),
        "a refused registration must not start a session"
    );
}

/// The check has to come before validation and Argon2, or a closed server
/// could still be made to burn CPU. A body that would fail validation (and
/// would otherwise return 400) proves the order.
#[sqlx::test(migrations = "./migrations")]
async fn disabled_registration_is_refused_before_validation_and_hashing(pool: PgPool) {
    let state = state_for(
        pool,
        Config {
            allow_registration: false,
            ..test_config()
        },
    );
    let server = browser(&state);

    let res = server
        .post("/api/v1/auth/register")
        .json(&json!({
            "email": "not-an-email",
            "authKey": "not-a-valid-auth-key",
            "kdfSalt": "x",
            "kdfParams": {},
            "wrappedAk": "x",
        }))
        .await;
    res.assert_status(StatusCode::FORBIDDEN);
    assert_eq!(
        res.json::<serde_json::Value>()["error"],
        "registration_disabled"
    );
}

/// Rate limiting still applies first, so a closed instance is not a free
/// oracle for hammering the endpoint.
#[sqlx::test(migrations = "./migrations")]
async fn disabled_registration_is_still_rate_limited(pool: PgPool) {
    let state = state_for(
        pool,
        Config {
            allow_registration: false,
            ..test_config()
        },
    );
    let server = browser(&state);

    let mut statuses = Vec::new();
    for i in 0..(REGISTER_LIMIT.limit + 1) {
        let res = server
            .post("/api/v1/auth/register")
            .json(&register_json(&format!("closed-{i}@example.com"), PASSWORD))
            .await;
        statuses.push(res.status_code());
    }
    assert!(
        statuses[..REGISTER_LIMIT.limit as usize]
            .iter()
            .all(|s| *s == StatusCode::FORBIDDEN),
        "{statuses:?}"
    );
    assert_eq!(
        *statuses.last().unwrap(),
        StatusCode::TOO_MANY_REQUESTS,
        "the rate limit must run before the registration switch"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn enabled_registration_creates_the_account(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let server = browser(&state);

    register(&server, "open@example.com").await;
    assert_eq!(count_users(&pool).await, 1);
}

/// Closing registration must not lock out accounts that already exist.
#[sqlx::test(migrations = "./migrations")]
async fn disabled_registration_does_not_affect_login_or_device_registration(pool: PgPool) {
    let open = browser(&state_for(pool.clone(), test_config()));
    register(&open, "existing@example.com").await;

    let closed = browser(&state_for(
        pool,
        Config {
            allow_registration: false,
            ..test_config()
        },
    ));
    closed
        .post("/api/v1/auth/login")
        .json(&json!({
            "email": "existing@example.com",
            "authKey": common::test_auth_key(PASSWORD),
        }))
        .await
        .assert_status_ok();
    register_device(&closed, "existing@example.com", "Laptop").await;
}

#[sqlx::test(migrations = "./migrations")]
async fn version_reports_whether_registration_is_enabled(pool: PgPool) {
    let open = browser(&state_for(pool.clone(), test_config()));
    let body: serde_json::Value = open.get("/api/v1/version").await.json();
    assert_eq!(body["registrationEnabled"], true);
    // Additive: the existing fields are unchanged.
    assert_eq!(body["apiVersion"], "v1");
    assert_eq!(body["protocolVersion"], 1);

    let closed = browser(&state_for(
        pool,
        Config {
            allow_registration: false,
            ..test_config()
        },
    ));
    let body: serde_json::Value = closed.get("/api/v1/version").await.json();
    assert_eq!(body["registrationEnabled"], false);
}

// --- device self-revoke ---

#[sqlx::test(migrations = "./migrations")]
async fn self_revoke_kills_the_access_token_and_the_refresh_token_immediately(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let server = browser(&state);
    let devices = browser(&state);
    register(&server, "self-revoke@example.com").await;
    let device = register_device(&server, "self-revoke@example.com", "Laptop").await;
    let user_id = user_id_for(&pool, "self-revoke@example.com").await;

    // Fill the revocation cache with "active", so the assertions below prove
    // the cache was updated and not merely that the DB row changed.
    devices
        .get("/api/v1/devices")
        .authorization_bearer(&device.access_token)
        .await
        .assert_status_ok();

    let res = devices
        .post("/api/v1/devices/self/revoke")
        .authorization_bearer(&device.access_token)
        .await;
    res.assert_status(StatusCode::NO_CONTENT);
    assert!(res.as_bytes().is_empty(), "204 must not carry a body");

    // The access token stops working right away, not after the cache TTL.
    devices
        .get("/api/v1/devices")
        .authorization_bearer(&device.access_token)
        .await
        .assert_status_unauthorized();
    devices
        .post("/api/v1/sync/operations")
        .authorization_bearer(&device.access_token)
        .json(&json!({ "operations": [bookmark_op(1)] }))
        .await
        .assert_status_unauthorized();

    // So does the refresh token, so the device can't mint a new access token.
    server
        .post("/api/v1/devices/credentials/refresh")
        .json(&json!({ "refreshToken": device.refresh_token }))
        .await
        .assert_status_unauthorized();

    let revoked_at: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar!(
        "SELECT revoked_at FROM devices WHERE id = $1",
        device.device_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(revoked_at.is_some());
    let live_credentials: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM device_credentials WHERE device_id = $1 AND revoked_at IS NULL",
        device.device_id
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .unwrap_or(0);
    assert_eq!(live_credentials, 0, "every credential must be revoked");

    // Audited, tied to both the account and the device.
    let events: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM audit_logs WHERE event_type = 'device_self_revoked' AND user_id = $1 AND device_id = $2",
        user_id,
        device.device_id
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .unwrap_or(0);
    assert_eq!(events, 1);

    // A repeat is just a request from a revoked device.
    devices
        .post("/api/v1/devices/self/revoke")
        .authorization_bearer(&device.access_token)
        .await
        .assert_status_unauthorized();
}

/// `/self/revoke` and `/:id/revoke` are different path shapes. This pins that
/// "self" is never captured by the `:id` route (which would answer 400 for a
/// non-UUID) and that the id route still works for the dashboard.
#[sqlx::test(migrations = "./migrations")]
async fn self_revoke_route_is_not_shadowed_by_the_id_route(pool: PgPool) {
    let state = state_for(pool, test_config());
    let mut server = browser(&state);
    register(&server, "routes@example.com").await;
    let device = register_device(&server, "routes@example.com", "Laptop").await;

    // No credentials: 401 from the self-revoke handler's own auth, not a
    // path-parse 400 or a 404/405.
    server.clear_cookies();
    server
        .post("/api/v1/devices/self/revoke")
        .await
        .assert_status_unauthorized();

    // A web session (even with a valid CSRF token) is not a device, so it
    // cannot use the self route.
    let login = server
        .post("/api/v1/auth/login")
        .json(&json!({
            "email": "routes@example.com",
            "authKey": common::test_auth_key(PASSWORD),
        }))
        .await;
    login.assert_status_ok();
    let csrf = login.json::<serde_json::Value>()["csrfToken"]
        .as_str()
        .unwrap()
        .to_string();
    server
        .post("/api/v1/devices/self/revoke")
        .add_header("x-csrf-token", &csrf)
        .await
        .assert_status_unauthorized();

    // The dashboard's revoke-by-id still works.
    server
        .post(&format!("/api/v1/devices/{}/revoke", device.device_id))
        .add_header("x-csrf-token", &csrf)
        .await
        .assert_status_ok();
}

#[sqlx::test(migrations = "./migrations")]
async fn self_revoke_only_affects_the_calling_device(pool: PgPool) {
    let state = state_for(pool, test_config());
    let server = browser(&state);
    let devices = browser(&state);
    register(&server, "two-devices@example.com").await;
    let laptop = register_device(&server, "two-devices@example.com", "Laptop").await;
    let phone = register_device(&server, "two-devices@example.com", "Phone").await;

    devices
        .post("/api/v1/devices/self/revoke")
        .authorization_bearer(&laptop.access_token)
        .await
        .assert_status(StatusCode::NO_CONTENT);

    devices
        .get("/api/v1/devices")
        .authorization_bearer(&phone.access_token)
        .await
        .assert_status_ok();
    server
        .post("/api/v1/devices/credentials/refresh")
        .json(&json!({ "refreshToken": phone.refresh_token }))
        .await
        .assert_status_ok();
}

#[sqlx::test(migrations = "./migrations")]
async fn self_revoke_disconnects_the_devices_websocket(pool: PgPool) {
    let state = state_for(pool, test_config());
    let server = browser(&state);
    let devices = browser(&state);
    register(&server, "ws-self@example.com").await;
    let device = register_device(&server, "ws-self@example.com", "Laptop").await;
    let user_id: Uuid = {
        let res = server.get("/api/v1/auth/me").await;
        res.json::<serde_json::Value>()["id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap()
    };

    // A registered sender stands in for an open websocket: dropping it is
    // what closes the real connection's task.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(4);
    state.ws_registry.register(user_id, device.device_id, tx);

    devices
        .post("/api/v1/devices/self/revoke")
        .authorization_bearer(&device.access_token)
        .await
        .assert_status(StatusCode::NO_CONTENT);

    assert_eq!(rx.recv().await, None, "the device's socket must be closed");
}

// --- account deletion ---

fn delete_json(password_seed: &str) -> serde_json::Value {
    json!({ "authKey": common::test_auth_key(password_seed) })
}

#[sqlx::test(migrations = "./migrations")]
async fn delete_account_with_a_wrong_auth_key_is_refused_and_deletes_nothing(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let server = browser(&state);
    let devices = browser(&state);
    let csrf = register(&server, "keep@example.com").await;
    let device = register_device(&server, "keep@example.com", "Laptop").await;
    upload_one_op(&server, &device.access_token).await;
    let user_id = user_id_for(&pool, "keep@example.com").await;
    let before = rows_owned_by(&pool, user_id).await;

    let res = server
        .delete("/api/v1/auth/account")
        .add_header("x-csrf-token", &csrf)
        .json(&delete_json("not the right password"))
        .await;
    res.assert_status_unauthorized();

    assert_eq!(rows_owned_by(&pool, user_id).await, before);
    assert_eq!(audit_count(&pool, "account_delete_failed").await, 1);
    assert_eq!(audit_count(&pool, "account_deleted").await, 0);
    // Still logged in, and the device still works.
    server.get("/api/v1/auth/me").await.assert_status_ok();
    devices
        .get("/api/v1/devices")
        .authorization_bearer(&device.access_token)
        .await
        .assert_status_ok();
}

#[sqlx::test(migrations = "./migrations")]
async fn delete_account_rejects_something_that_is_not_an_auth_key(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let server = browser(&state);
    let csrf = register(&server, "typo@example.com").await;

    // A raw password sent by mistake must never reach the hash check.
    server
        .delete("/api/v1/auth/account")
        .add_header("x-csrf-token", &csrf)
        .json(&json!({ "authKey": PASSWORD }))
        .await
        .assert_status_bad_request();
    assert_eq!(count_users(&pool).await, 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn delete_account_requires_a_csrf_token_and_a_session(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let mut server = browser(&state);
    let csrf = register(&server, "csrf@example.com").await;

    // Session cookie present, no CSRF header.
    server
        .delete("/api/v1/auth/account")
        .json(&delete_json(PASSWORD))
        .await
        .assert_status_forbidden();
    // Wrong CSRF header.
    server
        .delete("/api/v1/auth/account")
        .add_header("x-csrf-token", "not-the-token")
        .json(&delete_json(PASSWORD))
        .await
        .assert_status_forbidden();
    assert_eq!(count_users(&pool).await, 1);

    // No session at all, even with a header that would otherwise match.
    server.clear_cookies();
    server
        .delete("/api/v1/auth/account")
        .add_header("x-csrf-token", &csrf)
        .json(&delete_json(PASSWORD))
        .await
        .assert_status_unauthorized();
    assert_eq!(count_users(&pool).await, 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn delete_account_removes_everything_and_kills_every_credential_at_once(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let browser_a = browser(&state);
    let devices = browser(&state);
    let browser_b = browser(&state);
    let csrf = register(&browser_a, "doomed@example.com").await;
    browser_b
        .post("/api/v1/auth/login")
        .json(&json!({
            "email": "doomed@example.com",
            "authKey": common::test_auth_key(PASSWORD),
        }))
        .await
        .assert_status_ok();
    let laptop = register_device(&browser_a, "doomed@example.com", "Laptop").await;
    let phone = register_device(&browser_a, "doomed@example.com", "Phone").await;
    upload_one_op(&browser_a, &laptop.access_token).await;
    let user_id = user_id_for(&pool, "doomed@example.com").await;

    // Warm every in-memory cache and fake an open websocket plus the
    // per-device bookkeeping maps, so the purge has something to remove.
    browser_a.get("/api/v1/auth/me").await.assert_status_ok();
    browser_b.get("/api/v1/auth/me").await.assert_status_ok();
    for device in [&laptop, &phone] {
        devices
            .get("/api/v1/devices")
            .authorization_bearer(&device.access_token)
            .await
            .assert_status_ok();
    }
    let mut sockets = Vec::new();
    for device in [&laptop, &phone] {
        let (tx, rx) = tokio::sync::mpsc::channel::<String>(4);
        state.ws_registry.register(user_id, device.device_id, tx);
        sockets.push(rx);
        state
            .upload_locks
            .insert(device.device_id, Arc::new(tokio::sync::Semaphore::new(1)));
        state
            .last_seen_cache
            .insert(device.device_id, std::time::Instant::now());
    }
    let before = rows_owned_by(&pool, user_id).await;
    assert!(
        before
            .iter()
            .all(|(table, n)| *n >= 1 || *table == "sync_cursors"),
        "the fixture must give the account data in every table: {before:?}"
    );

    let res = browser_a
        .delete("/api/v1/auth/account")
        .add_header("x-csrf-token", &csrf)
        .json(&delete_json(PASSWORD))
        .await;
    res.assert_status(StatusCode::NO_CONTENT);
    assert!(res.as_bytes().is_empty(), "204 must not carry a body");
    // Both cookies are cleared in the response.
    for name in [SESSION_COOKIE_NAME, CSRF_COOKIE_NAME] {
        let cookie = res.cookie(name);
        assert_eq!(cookie.value(), "", "{name} must be cleared");
        assert_eq!(
            cookie.max_age(),
            Some(time::Duration::seconds(0)),
            "{name} must expire immediately"
        );
    }

    // Nothing left in the database.
    for (table, count) in rows_owned_by(&pool, user_id).await {
        assert_eq!(count, 0, "{table} still has rows for the deleted account");
    }
    for device in [&laptop, &phone] {
        assert_eq!(device_credential_count(&pool, device.device_id).await, 0);
    }
    // The audit trail survives, detached from the deleted user.
    let orphaned_event: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM audit_logs WHERE event_type = 'account_deleted' AND user_id IS NULL"
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .unwrap_or(0);
    assert_eq!(orphaned_event, 1);
    let still_linked: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM audit_logs WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .unwrap_or(0);
    assert_eq!(still_linked, 0);

    // Credentials die immediately, despite the caches having said "valid"
    // a moment ago: both browsers' sessions and both device tokens.
    browser_a
        .get("/api/v1/auth/me")
        .await
        .assert_status_unauthorized();
    browser_b
        .get("/api/v1/auth/me")
        .await
        .assert_status_unauthorized();
    for device in [&laptop, &phone] {
        devices
            .get("/api/v1/devices")
            .authorization_bearer(&device.access_token)
            .await
            .assert_status_unauthorized();
        browser_a
            .post("/api/v1/devices/credentials/refresh")
            .json(&json!({ "refreshToken": device.refresh_token }))
            .await
            .assert_status_unauthorized();
    }

    // Process memory is purged too.
    for mut socket in sockets {
        assert_eq!(socket.recv().await, None, "websockets must be closed");
    }
    assert!(state.upload_locks.is_empty());
    assert!(state.last_seen_cache.is_empty());

    // The account can no longer log in...
    browser_b
        .post("/api/v1/auth/login")
        .json(&json!({
            "email": "doomed@example.com",
            "authKey": common::test_auth_key(PASSWORD),
        }))
        .await
        .assert_status_unauthorized();
    // ...and the email is free to register again, as a brand-new account.
    register(&browser_b, "doomed@example.com").await;
    assert_ne!(user_id_for(&pool, "doomed@example.com").await, user_id);
}

#[sqlx::test(migrations = "./migrations")]
async fn delete_account_leaves_other_accounts_untouched(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let victim = browser(&state);
    let devices = browser(&state);
    let bystander = browser(&state);
    let victim_csrf = register(&victim, "leaver@example.com").await;
    let bystander_csrf = register(&bystander, "stayer@example.com").await;
    let victim_device = register_device(&victim, "leaver@example.com", "Laptop").await;
    let bystander_device = register_device(&bystander, "stayer@example.com", "Laptop").await;
    upload_one_op(&victim, &victim_device.access_token).await;
    upload_one_op(&bystander, &bystander_device.access_token).await;
    let bystander_id = user_id_for(&pool, "stayer@example.com").await;
    let before = rows_owned_by(&pool, bystander_id).await;
    assert!(before
        .iter()
        .all(|(table, n)| *n >= 1 || *table == "sync_cursors"));

    victim
        .delete("/api/v1/auth/account")
        .add_header("x-csrf-token", &victim_csrf)
        .json(&delete_json(PASSWORD))
        .await
        .assert_status(StatusCode::NO_CONTENT);

    assert_eq!(rows_owned_by(&pool, bystander_id).await, before);
    // The other account's session and device token keep working.
    bystander.get("/api/v1/auth/me").await.assert_status_ok();
    devices
        .get("/api/v1/devices")
        .authorization_bearer(&bystander_device.access_token)
        .await
        .assert_status_ok();
    bystander
        .post("/api/v1/auth/logout")
        .add_header("x-csrf-token", &bystander_csrf)
        .await
        .assert_status(StatusCode::NO_CONTENT);
}

/// The caller's own session proves nothing about the password; guessing the
/// authKey for an account whose session you hold must be throttled.
#[sqlx::test(migrations = "./migrations")]
async fn delete_account_attempts_are_rate_limited(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let server = browser(&state);
    let csrf = register(&server, "limited@example.com").await;

    let mut statuses = Vec::new();
    for _ in 0..(ACCOUNT_DELETE_LIMIT.limit + 1) {
        let res = server
            .delete("/api/v1/auth/account")
            .add_header("x-csrf-token", &csrf)
            .json(&delete_json("wrong password"))
            .await;
        statuses.push(res.status_code());
    }
    assert!(
        statuses[..ACCOUNT_DELETE_LIMIT.limit as usize]
            .iter()
            .all(|s| *s == StatusCode::UNAUTHORIZED),
        "{statuses:?}"
    );
    assert_eq!(*statuses.last().unwrap(), StatusCode::TOO_MANY_REQUESTS);
    // The throttle is on deletion only: the owner can still log in.
    server
        .post("/api/v1/auth/login")
        .json(&json!({
            "email": "limited@example.com",
            "authKey": common::test_auth_key(PASSWORD),
        }))
        .await
        .assert_status_ok();
    assert_eq!(count_users(&pool).await, 1);
}
