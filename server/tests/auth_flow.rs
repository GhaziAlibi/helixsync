mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum_test::{TestServer, TestServerConfig, Transport};
use helixsync_server::auth::extractors::{
    write_device_revocation_cache_entry, write_web_session_cache_entry, SESSION_COOKIE_NAME,
};
use helixsync_server::config::Config;
use helixsync_server::middleware::rate_limit::{
    RateLimitPartition, RateLimiter, LOGIN_EMAIL_LIMIT, TOKEN_REFRESH_IP_LIMIT, TOKEN_REFRESH_LIMIT,
};
use helixsync_server::state::AppState;
use helixsync_server::websocket::ConnectionRegistry;
use serde_json::json;
use sqlx::postgres::PgPoolOptions;
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

fn server_for_config(pool: PgPool, config: Config) -> TestServer {
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
    let test_server_config = TestServerConfig {
        transport: Some(Transport::HttpRandomPort),
        save_cookies: true,
        ..Default::default()
    };
    let make_service =
        helixsync_server::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    TestServer::new_with_config(make_service, test_server_config)
}

fn server_for(pool: PgPool) -> TestServer {
    server_for_config(pool, test_config())
}

/// Request body for `POST /auth/register`. `password_seed` is just a label
/// used to derive a deterministic, distinct `authKey` (SEC-01: the server
/// never sees a real password) — reusing the same seed across calls gets
/// the same authKey, like logging in with "the same password" would.
fn register_json(email: &str, password_seed: &str) -> serde_json::Value {
    json!({
        "email": email,
        "authKey": common::test_auth_key(password_seed),
        "kdfSalt": common::test_kdf_salt(),
        "kdfParams": common::test_kdf_params(),
        "wrappedAk": common::test_wrapped_ak(),
    })
}

/// Request body for `POST /auth/login`.
fn login_json(email: &str, password_seed: &str) -> serde_json::Value {
    json!({
        "email": email,
        "authKey": common::test_auth_key(password_seed),
    })
}

/// Request body for `POST/PATCH /auth/password`.
fn change_password_json(current_password_seed: &str, new_password_seed: &str) -> serde_json::Value {
    json!({
        "currentAuthKey": common::test_auth_key(current_password_seed),
        "newAuthKey": common::test_auth_key(new_password_seed),
        "newKdfSalt": common::test_kdf_salt(),
        "newKdfParams": common::test_kdf_params(),
        "newWrappedAk": common::test_wrapped_ak(),
    })
}

/// Request body for `POST /devices/register`.
fn device_register_json(
    email: &str,
    password_seed: &str,
    name: impl std::fmt::Display,
) -> serde_json::Value {
    json!({
        "email": email,
        "authKey": common::test_auth_key(password_seed),
        "name": name.to_string(),
    })
}

/// Logout must return 204: the web client parses JSON on any other status,
/// so an empty 200 breaks it.
#[sqlx::test(migrations = "./migrations")]
async fn logout_returns_no_content_and_actually_ends_the_session(pool: PgPool) {
    let server = server_for(pool);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(
            "gina@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();
    let register_body: serde_json::Value = register_res.json();
    let csrf = register_body["csrfToken"].as_str().unwrap().to_string();

    let me_before = server.get("/api/v1/auth/me").await;
    me_before.assert_status_ok();

    let logout_res = server
        .post("/api/v1/auth/logout")
        .add_header("x-csrf-token", &csrf)
        .await;
    logout_res.assert_status(axum::http::StatusCode::NO_CONTENT);
    assert!(
        logout_res.as_bytes().is_empty(),
        "204 response must not carry a body"
    );

    let me_after = server.get("/api/v1/auth/me").await;
    me_after.assert_status_unauthorized();
}

/// If the revoke query fails, logout must not return 204 and the session
/// must still work. A second server with an unreachable DB simulates the
/// failure.
#[sqlx::test(migrations = "./migrations")]
async fn logout_does_not_return_no_content_when_revoke_fails(pool: PgPool) {
    let healthy = server_for(pool);

    let register_res = healthy
        .post("/api/v1/auth/register")
        .json(&register_json(
            "flaky-logout@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();
    let session_cookie = register_res.cookie(SESSION_COOKIE_NAME);

    // Nothing listens on this port, so every query fails fast.
    let broken_pool = PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(500))
        .connect_lazy("postgres://baduser:badpass@127.0.0.1:1/nonexistent")
        .expect("connect_lazy must not eagerly connect");
    let broken = server_for(broken_pool);

    let logout_res = broken
        .post("/api/v1/auth/logout")
        .add_cookie(session_cookie)
        .await;
    assert_ne!(
        logout_res.status_code(),
        axum::http::StatusCode::NO_CONTENT,
        "logout must not report success when the revoking DB write failed"
    );
    assert!(logout_res.status_code().is_server_error());

    // The revoke never happened, so the session still works.
    let me_after = healthy.get("/api/v1/auth/me").await;
    me_after.assert_status_ok();
}

/// Login attempts on one email from many IPs must still hit the
/// per-account limit (429).
#[sqlx::test(migrations = "./migrations")]
async fn per_account_login_limit_trips_even_when_attacker_rotates_ips(pool: PgPool) {
    let mut config = test_config();
    config.behind_proxy = true;
    let server = server_for_config(pool, config);

    let target_email = "victim@example.com";

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(target_email, "correct horse battery staple"))
        .await;
    register_res.assert_status_ok();
    // Log out, then send every attempt from a different IP.
    server.post("/api/v1/auth/logout").await;

    let mut hit_rate_limit = false;
    for i in 0..(LOGIN_EMAIL_LIMIT.limit as usize + 5) {
        let res = server
            .post("/api/v1/auth/login")
            // New IP every time; must not bypass the per-account limit.
            .add_header("x-forwarded-for", format!("203.0.113.{i}"))
            .json(&login_json(target_email, "definitely the wrong password"))
            .await;

        if res.status_code() == axum::http::StatusCode::TOO_MANY_REQUESTS {
            hit_rate_limit = true;
            break;
        }

        res.assert_status_unauthorized();
    }

    assert!(
        hit_rate_limit,
        "expected a 429: repeated failed logins against one account from \
         distinct IPs must eventually trip the per-account rate limit, not \
         just the per-IP one"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn change_password_requires_correct_current_password(pool: PgPool) {
    let server = server_for(pool);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(
            "harry@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();
    let body: serde_json::Value = register_res.json();
    let csrf = body["csrfToken"].as_str().unwrap().to_string();

    let wrong = server
        .post("/api/v1/auth/password")
        .add_header("x-csrf-token", &csrf)
        .json(&change_password_json(
            "wrong password wrong",
            "another long password",
        ))
        .await;
    wrong.assert_status_unauthorized();

    let right = server
        .post("/api/v1/auth/password")
        .add_header("x-csrf-token", &csrf)
        .json(&change_password_json(
            "correct horse battery staple",
            "a brand new long password",
        ))
        .await;
    right.assert_status_ok();

    // Old password must no longer work.
    let old_login = server
        .post("/api/v1/auth/login")
        .json(&login_json(
            "harry@example.com",
            "correct horse battery staple",
        ))
        .await;
    old_login.assert_status_unauthorized();

    let new_login = server
        .post("/api/v1/auth/login")
        .json(&login_json(
            "harry@example.com",
            "a brand new long password",
        ))
        .await;
    new_login.assert_status_ok();
}

/// `PATCH /api/v1/auth/password` (docs/encryption.md §4) works the same as
/// the old `POST`.
#[sqlx::test(migrations = "./migrations")]
async fn change_password_via_patch_matches_documented_contract(pool: PgPool) {
    let server = server_for(pool);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(
            "patch-password@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();
    let body: serde_json::Value = register_res.json();
    let csrf = body["csrfToken"].as_str().unwrap().to_string();

    let wrong = server
        .patch("/api/v1/auth/password")
        .add_header("x-csrf-token", &csrf)
        .json(&change_password_json(
            "wrong password wrong",
            "another long password",
        ))
        .await;
    wrong.assert_status_unauthorized();

    let right = server
        .patch("/api/v1/auth/password")
        .add_header("x-csrf-token", &csrf)
        .json(&change_password_json(
            "correct horse battery staple",
            "a brand new long password",
        ))
        .await;
    right.assert_status_ok();

    // Old password must no longer work.
    let old_login = server
        .post("/api/v1/auth/login")
        .json(&login_json(
            "patch-password@example.com",
            "correct horse battery staple",
        ))
        .await;
    old_login.assert_status_unauthorized();

    let new_login = server
        .post("/api/v1/auth/login")
        .json(&login_json(
            "patch-password@example.com",
            "a brand new long password",
        ))
        .await;
    new_login.assert_status_ok();
}

/// SEC-01/docs/encryption.md §2: `POST /auth/prelogin` returns the account's
/// real `kdfSalt`/`kdfParams` for a known email, and a stable (but not
/// account-derived) response for an unknown one, so it can't be used to
/// enumerate which emails have accounts.
#[sqlx::test(migrations = "./migrations")]
async fn prelogin_returns_stored_kdf_material_and_a_stable_fake_for_unknown_email(pool: PgPool) {
    let server = server_for(pool);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(
            "prelogin-known@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();

    let known_res = server
        .post("/api/v1/auth/prelogin")
        .json(&json!({ "email": "prelogin-known@example.com" }))
        .await;
    known_res.assert_status_ok();
    let known_body: serde_json::Value = known_res.json();
    assert_eq!(
        known_body["kdfSalt"].as_str(),
        Some(common::test_kdf_salt()),
        "prelogin for a known email must return its stored kdfSalt"
    );

    let unknown_res_1 = server
        .post("/api/v1/auth/prelogin")
        .json(&json!({ "email": "prelogin-unknown@example.com" }))
        .await;
    unknown_res_1.assert_status_ok();
    let unknown_body_1: serde_json::Value = unknown_res_1.json();

    let unknown_res_2 = server
        .post("/api/v1/auth/prelogin")
        .json(&json!({ "email": "prelogin-unknown@example.com" }))
        .await;
    unknown_res_2.assert_status_ok();
    let unknown_body_2: serde_json::Value = unknown_res_2.json();

    assert_eq!(
        unknown_body_1["kdfSalt"], unknown_body_2["kdfSalt"],
        "prelogin for an unknown email must return a stable value across calls, \
         not something that would out it as unregistered by varying"
    );
    assert_ne!(
        unknown_body_1["kdfSalt"].as_str(),
        Some(common::test_kdf_salt()),
        "the unknown-email fake salt must not collide with a real stored salt"
    );
}

/// SEC-10 (bundled into the SEC-01 fix): a successful password change
/// revokes every *other* web session for the account, but not the one
/// making the change.
#[sqlx::test(migrations = "./migrations")]
async fn change_password_revokes_other_web_sessions_but_not_the_current_one(pool: PgPool) {
    // Two independent cookie jars (two "browsers"), but sharing one
    // `AppState` — and therefore one `web_session_cache` — like two tabs
    // talking to the same running server process would. Two entirely
    // separate `server_for(pool)` calls would each get their own in-memory
    // cache, which would mask a real revocation behind a stale local cache
    // entry rather than actually exercising it.
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
    let browser_a = TestServer::new_with_config(
        helixsync_server::app(state.clone())
            .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        test_server_config.clone(),
    );
    let browser_b = TestServer::new_with_config(
        helixsync_server::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
        test_server_config,
    );

    let register_res = browser_a
        .post("/api/v1/auth/register")
        .json(&register_json(
            "sec10@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();
    let register_body: serde_json::Value = register_res.json();
    let csrf_a = register_body["csrfToken"].as_str().unwrap().to_string();

    let login_res_b = browser_b
        .post("/api/v1/auth/login")
        .json(&login_json(
            "sec10@example.com",
            "correct horse battery staple",
        ))
        .await;
    login_res_b.assert_status_ok();

    // Both sessions work before the password change.
    browser_a.get("/api/v1/auth/me").await.assert_status_ok();
    browser_b.get("/api/v1/auth/me").await.assert_status_ok();

    let change_res = browser_a
        .post("/api/v1/auth/password")
        .add_header("x-csrf-token", &csrf_a)
        .json(&change_password_json(
            "correct horse battery staple",
            "a brand new long password",
        ))
        .await;
    change_res.assert_status_ok();

    // The session that made the change stays valid...
    browser_a.get("/api/v1/auth/me").await.assert_status_ok();
    // ...but every other session for the account is revoked.
    browser_b
        .get("/api/v1/auth/me")
        .await
        .assert_status_unauthorized();
}

async fn register_device(server: &TestServer, email: &str, name: &str) -> (String, String) {
    let res = server
        .post("/api/v1/devices/register")
        .json(&device_register_json(
            email,
            "correct horse battery staple",
            name,
        ))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    (
        body["deviceId"].as_str().unwrap().to_string(),
        body["refreshToken"].as_str().unwrap().to_string(),
    )
}

/// Refresh rotates the token every call, so a per-token limit never trips.
/// The per-device limit must still return 429 after 30 calls in 60s.
#[sqlx::test(migrations = "./migrations")]
async fn rapid_token_rotation_is_rate_limited_by_device_not_by_hash(pool: PgPool) {
    let mut config = test_config();
    config.behind_proxy = true;
    let server = server_for_config(pool, config);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(
            "ivy@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();

    let (_device_id, mut refresh_token) =
        register_device(&server, "ivy@example.com", "Laptop").await;

    let mut hit_rate_limit = false;
    for i in 0..40 {
        let res = server
            .post("/api/v1/devices/credentials/refresh")
            .add_header("x-forwarded-for", format!("198.51.100.{i}"))
            .json(&json!({ "refreshToken": refresh_token }))
            .await;

        if res.status_code() == axum::http::StatusCode::TOO_MANY_REQUESTS {
            hit_rate_limit = true;
            break;
        }

        res.assert_status_ok();
        let body: serde_json::Value = res.json();
        refresh_token = body["refreshToken"].as_str().unwrap().to_string();
    }

    assert!(
        hit_rate_limit,
        "expected a 429 before exhausting the loop: a strictly-rotating \
         sequence of refresh calls against one device must eventually hit \
         the device-id-keyed rate limit even when called from different IPs"
    );
}

/// Refresh is rate-limited per IP before any DB work, so random tokens from
/// one IP get throttled.
#[sqlx::test(migrations = "./migrations")]
async fn refresh_credentials_is_rate_limited_by_ip_even_with_random_tokens(pool: PgPool) {
    let server = server_for(pool);

    let mut hit_rate_limit = false;
    for i in 0..310 {
        // A new random token each time, so the per-token limit never trips.
        let res = server
            .post("/api/v1/devices/credentials/refresh")
            .json(&json!({ "refreshToken": format!("random-unauthenticated-token-{i}") }))
            .await;

        if res.status_code() == axum::http::StatusCode::TOO_MANY_REQUESTS {
            hit_rate_limit = true;
            break;
        }

        assert_eq!(res.status_code(), axum::http::StatusCode::UNAUTHORIZED);
    }

    assert!(
        hit_rate_limit,
        "expected a 429: an unauthenticated caller flooding distinct tokens \
         from the same IP must be tripped by the IP-level rate limit"
    );
}

/// SEC-07 regression: IPv6 addresses in the same /64 must share the refresh
/// IP rate-limit bucket, not get one bucket per address.
#[sqlx::test(migrations = "./migrations")]
async fn refresh_credentials_ipv6_rate_limit_is_grouped_by_slash_64(pool: PgPool) {
    let mut config = test_config();
    config.behind_proxy = true;
    let server = server_for_config(pool, config);

    let mut hit_rate_limit = false;
    for i in 0..(TOKEN_REFRESH_IP_LIMIT.limit as usize + 5) {
        // A different IPv6 address within the same /64 on every request,
        // and a new random token each time so the per-token limit never trips.
        let res = server
            .post("/api/v1/devices/credentials/refresh")
            .add_header(
                "x-forwarded-for",
                format!("2001:db8:1234:5678::{:x}", i + 1),
            )
            .json(&json!({ "refreshToken": format!("random-unauthenticated-token-{i}") }))
            .await;

        if res.status_code() == axum::http::StatusCode::TOO_MANY_REQUESTS {
            hit_rate_limit = true;
            break;
        }

        assert_eq!(res.status_code(), axum::http::StatusCode::UNAUTHORIZED);
    }

    assert!(
        hit_rate_limit,
        "expected a 429: rotating the IPv6 address within one /64 must not \
         bypass the IP-level rate limit"
    );
}

/// Even with the untrusted partition full (25,000 entries), a real device
/// can still refresh, since its per-device limit is in the authenticated
/// partition.
#[sqlx::test(migrations = "./migrations")]
async fn saturated_untrusted_partition_does_not_block_authenticated_device_refresh(pool: PgPool) {
    let mut config = test_config();
    config.behind_proxy = true;
    let rate_limiter = Arc::new(RateLimiter::new());
    let state = AppState {
        db: pool,
        config: Arc::new(config),
        rate_limiter: Arc::clone(&rate_limiter),
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
    let server = TestServer::new_with_config(make_service, test_server_config);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(
            "jack@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();

    let (_device_id, refresh_token) = register_device(&server, "jack@example.com", "Laptop").await;

    let client_ip = "198.51.100.42";
    let token_hash = helixsync_server::crypto::hash_token(&refresh_token);

    // Use this IP and token once before filling the partition.
    helixsync_server::middleware::rate_limit::enforce(
        &rate_limiter,
        TOKEN_REFRESH_IP_LIMIT,
        client_ip,
    )
    .unwrap();
    helixsync_server::middleware::rate_limit::enforce(
        &rate_limiter,
        TOKEN_REFRESH_LIMIT,
        &token_hash,
    )
    .unwrap();

    // Fill the untrusted partition (25,000 entries).
    let window = std::time::Duration::from_secs(60);
    for i in 0..25_000 {
        rate_limiter.check(
            RateLimitPartition::Untrusted,
            "flood",
            &format!("flood-{i}"),
            1000,
            window,
        );
    }

    // Refresh must still succeed.
    let res = server
        .post("/api/v1/devices/credentials/refresh")
        .add_header("x-forwarded-for", client_ip)
        .json(&json!({ "refreshToken": refresh_token }))
        .await;

    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(body["accessToken"].is_string());
    assert!(body["refreshToken"].is_string());
}

/// SEC-09 regression: replaying a just-rotated refresh token within the
/// grace window is treated as a lost-response retry, not theft. The device
/// stays active and the credential issued by the original rotation keeps
/// working.
#[sqlx::test(migrations = "./migrations")]
async fn reused_refresh_token_within_grace_window_does_not_revoke_device(pool: PgPool) {
    let server = server_for(pool.clone());

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(
            "mallory@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();

    let (device_id, old_token) = register_device(&server, "mallory@example.com", "Laptop").await;

    let rotate_res = server
        .post("/api/v1/devices/credentials/refresh")
        .json(&json!({ "refreshToken": old_token }))
        .await;
    rotate_res.assert_status_ok();
    let current_token = rotate_res.json::<serde_json::Value>()["refreshToken"]
        .as_str()
        .unwrap()
        .to_string();

    // Replay the now-rotated token right away, as if the rotation's
    // response never reached the device.
    let replay_res = server
        .post("/api/v1/devices/credentials/refresh")
        .json(&json!({ "refreshToken": old_token }))
        .await;
    replay_res.assert_status_unauthorized();

    let device_id: Uuid = device_id.parse().unwrap();
    let device_revoked_at: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar!("SELECT revoked_at FROM devices WHERE id = $1", device_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        device_revoked_at.is_none(),
        "a token replayed within the grace window must not revoke the device"
    );

    // The device's real (current) token must still work.
    let retry_res = server
        .post("/api/v1/devices/credentials/refresh")
        .json(&json!({ "refreshToken": current_token }))
        .await;
    retry_res.assert_status_ok();
}

/// SEC-09 regression: replaying a refresh token well after it was rotated
/// is treated as theft. The whole device is revoked, so even its current,
/// otherwise-valid token stops working, and an audit event is written.
#[sqlx::test(migrations = "./migrations")]
async fn reused_refresh_token_outside_grace_window_revokes_device(pool: PgPool) {
    let server = server_for(pool.clone());

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(
            "oscar@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();

    let (device_id, old_token) = register_device(&server, "oscar@example.com", "Laptop").await;

    let rotate_res = server
        .post("/api/v1/devices/credentials/refresh")
        .json(&json!({ "refreshToken": old_token }))
        .await;
    rotate_res.assert_status_ok();
    let current_token = rotate_res.json::<serde_json::Value>()["refreshToken"]
        .as_str()
        .unwrap()
        .to_string();

    // Back-date the rotated-out credential's revocation, as if it had been
    // rotated well outside the grace window.
    let old_hash = helixsync_server::crypto::hash_token(&old_token);
    sqlx::query!(
        "UPDATE device_credentials SET revoked_at = now() - interval '1 minute' \
         WHERE credential_hash = $1",
        old_hash
    )
    .execute(&pool)
    .await
    .unwrap();

    let replay_res = server
        .post("/api/v1/devices/credentials/refresh")
        .json(&json!({ "refreshToken": old_token }))
        .await;
    replay_res.assert_status_unauthorized();

    let device_id: Uuid = device_id.parse().unwrap();
    let device_revoked_at: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar!("SELECT revoked_at FROM devices WHERE id = $1", device_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        device_revoked_at.is_some(),
        "replaying a token rotated outside the grace window must revoke the device"
    );

    let event_count: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM audit_logs \
         WHERE device_id = $1 AND event_type = 'refresh_token_reuse_detected'",
        device_id
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .unwrap_or(0);
    assert_eq!(event_count, 1);

    // Even the device's current, otherwise-valid token must now be dead.
    let retry_res = server
        .post("/api/v1/devices/credentials/refresh")
        .json(&json!({ "refreshToken": current_token }))
        .await;
    retry_res.assert_status_unauthorized();
}

#[sqlx::test(migrations = "./migrations")]
async fn web_session_is_cached_and_invalidated_on_revocation(pool: PgPool) {
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
    let web_session_cache = Arc::clone(&state.web_session_cache);
    let test_server_config = TestServerConfig {
        transport: Some(Transport::HttpRandomPort),
        save_cookies: true,
        ..Default::default()
    };
    let make_service =
        helixsync_server::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    let server = TestServer::new_with_config(make_service, test_server_config);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(
            "session-cache-test@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();
    let body: serde_json::Value = register_res.json();
    let csrf = body["csrfToken"].as_str().unwrap().to_string();

    // Cache is empty before /me is called.
    assert_eq!(web_session_cache.len(), 0);

    // First request hits the DB and fills the cache.
    let me_res = server.get("/api/v1/auth/me").await;
    me_res.assert_status_ok();
    assert_eq!(web_session_cache.len(), 1);

    // Second request hits cache
    let me_res2 = server.get("/api/v1/auth/me").await;
    me_res2.assert_status_ok();
    assert_eq!(web_session_cache.len(), 1);

    // Find the current session ID.
    let sessions_res = server.get("/api/v1/auth/sessions").await;
    sessions_res.assert_status_ok();
    let sessions: Vec<serde_json::Value> = sessions_res.json();
    assert_eq!(sessions.len(), 1);
    let session_id = sessions[0]["id"].as_str().unwrap();

    // Revoke the session via POST /api/v1/auth/sessions/:id/revoke
    let revoke_res = server
        .post(&format!("/api/v1/auth/sessions/{}/revoke", session_id))
        .add_header("x-csrf-token", &csrf)
        .await;
    revoke_res.assert_status_ok();

    // The entry must become a tombstone (`None`), not be removed.
    assert_eq!(web_session_cache.len(), 1);
    assert!(
        web_session_cache
            .iter()
            .next()
            .expect("tombstone entry should exist")
            .1
            .is_none(),
        "revoked session's cache entry must be a tombstone (None), not stale valid data"
    );

    // /me now returns 401.
    let me_after_revoke = server.get("/api/v1/auth/me").await;
    me_after_revoke.assert_status_unauthorized();
}

#[sqlx::test(migrations = "./migrations")]
async fn logout_immediately_evicts_from_web_session_cache(pool: PgPool) {
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
    let web_session_cache = Arc::clone(&state.web_session_cache);
    let test_server_config = TestServerConfig {
        transport: Some(Transport::HttpRandomPort),
        save_cookies: true,
        ..Default::default()
    };
    let make_service =
        helixsync_server::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    let server = TestServer::new_with_config(make_service, test_server_config);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(
            "logout-cache@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();
    let register_body: serde_json::Value = register_res.json();
    let csrf = register_body["csrfToken"].as_str().unwrap().to_string();

    let me_res = server.get("/api/v1/auth/me").await;
    me_res.assert_status_ok();
    assert_eq!(web_session_cache.len(), 1);

    let logout_res = server
        .post("/api/v1/auth/logout")
        .add_header("x-csrf-token", &csrf)
        .await;
    logout_res.assert_status(axum::http::StatusCode::NO_CONTENT);

    // The entry must become a tombstone (`None`), not be removed.
    assert_eq!(web_session_cache.len(), 1);
    assert!(
        web_session_cache
            .iter()
            .next()
            .expect("tombstone entry should exist")
            .1
            .is_none(),
        "logged-out session's cache entry must be a tombstone (None), not stale valid data"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn expired_cache_entry_revalidates_against_database(pool: PgPool) {
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
    let web_session_cache = Arc::clone(&state.web_session_cache);
    let test_server_config = TestServerConfig {
        transport: Some(Transport::HttpRandomPort),
        save_cookies: true,
        ..Default::default()
    };
    let make_service =
        helixsync_server::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    let server = TestServer::new_with_config(make_service, test_server_config);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(
            "ttl-revalidate@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();

    let me_res = server.get("/api/v1/auth/me").await;
    me_res.assert_status_ok();
    assert_eq!(web_session_cache.len(), 1);

    // Make the cached entry older than 30s.
    for mut entry in web_session_cache.iter_mut() {
        entry.value_mut().0 = std::time::Instant::now() - std::time::Duration::from_secs(35);
    }

    // The request still succeeds by checking the DB and refreshing the entry.
    let me_res2 = server.get("/api/v1/auth/me").await;
    me_res2.assert_status_ok();

    for entry in web_session_cache.iter() {
        assert!(entry.value().0.elapsed() < std::time::Duration::from_secs(5));
    }
}

/// The sweeper removes session cache entries past `WEB_SESSION_CACHE_TTL`,
/// even if the cookie is never used again.
#[sqlx::test(migrations = "./migrations")]
async fn stale_cache_entry_is_removed_by_sweep(pool: PgPool) {
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
    let web_session_cache = Arc::clone(&state.web_session_cache);
    let test_server_config = TestServerConfig {
        transport: Some(Transport::HttpRandomPort),
        save_cookies: true,
        ..Default::default()
    };
    let make_service =
        helixsync_server::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    let server = TestServer::new_with_config(make_service, test_server_config);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(
            "sweep-test@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();

    // Populate the cache.
    let me_res = server.get("/api/v1/auth/me").await;
    me_res.assert_status_ok();
    assert_eq!(web_session_cache.len(), 1);

    // A fresh entry survives the sweep.
    helixsync_server::auth::extractors::sweep_web_session_cache(&web_session_cache);
    assert_eq!(web_session_cache.len(), 1);

    // Make the entry stale.
    for mut entry in web_session_cache.iter_mut() {
        entry.value_mut().0 = std::time::Instant::now() - std::time::Duration::from_secs(35);
    }

    // The sweep removes it.
    helixsync_server::auth::extractors::sweep_web_session_cache(&web_session_cache);
    assert_eq!(web_session_cache.len(), 0);
}

/// `register` inserts `users` and `user_settings` in one transaction, so a
/// failed second insert leaves no half-created account.
#[sqlx::test(migrations = "./migrations")]
async fn register_with_failed_user_settings_insert_leaves_no_orphaned_user_row(pool: PgPool) {
    // Make the second insert fail (each sqlx::test has its own database).
    sqlx::query("DROP TABLE user_settings")
        .execute(&pool)
        .await
        .unwrap();

    let query_pool = pool.clone();
    let server = server_for(pool);

    let email = "orphan-check@example.com";
    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(email, "correct horse battery staple"))
        .await;
    assert!(
        register_res.status_code().is_server_error(),
        "expected register to fail once user_settings is missing, got {}",
        register_res.status_code()
    );

    let row = sqlx::query("SELECT id FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(&query_pool)
        .await
        .unwrap();
    assert!(
        row.is_none(),
        "users row must not be committed when the user_settings insert fails"
    );
}

/// Registering an already-used email must not confirm that the account
/// exists (SEC-11): same status/shape as any other registration failure,
/// with no reference to the email already being taken. The attempt is
/// still audited server-side against the existing account.
#[sqlx::test(migrations = "./migrations")]
async fn registering_an_existing_email_gives_a_generic_error(pool: PgPool) {
    let query_pool = pool.clone();
    let server = server_for(pool);

    let email = "taken@example.com";
    let first = server
        .post("/api/v1/auth/register")
        .json(&register_json(email, "correct horse battery staple"))
        .await;
    assert_eq!(first.status_code(), axum::http::StatusCode::OK);

    let second = server
        .post("/api/v1/auth/register")
        .json(&register_json(email, "a different password entirely"))
        .await;
    assert_eq!(second.status_code(), axum::http::StatusCode::BAD_REQUEST);
    let body: serde_json::Value = second.json();
    let message = body["message"].as_str().unwrap_or_default().to_lowercase();
    assert!(
        !message.contains("already exists") && !message.contains("already registered"),
        "response must not confirm the email is taken, got {message:?}"
    );

    let user_id: uuid::Uuid = sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(email)
        .fetch_one(&query_pool)
        .await
        .unwrap();
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_logs WHERE user_id = $1 AND event_type = 'registration_duplicate_attempt'",
    )
    .bind(user_id)
    .fetch_one(&query_pool)
    .await
    .unwrap();
    assert_eq!(
        audited, 1,
        "the duplicate attempt must still be audited server-side against the existing account"
    );
}

/// Login saves the client IP on the session, and the session list shows it.
#[sqlx::test(migrations = "./migrations")]
async fn login_session_reports_the_real_client_ip(pool: PgPool) {
    let mut config = test_config();
    config.behind_proxy = true;
    let server = server_for_config(pool, config);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(
            "ip-check@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();

    let client_ip = "203.0.113.77";
    let login_res = server
        .post("/api/v1/auth/login")
        .add_header("x-forwarded-for", client_ip)
        .json(&login_json(
            "ip-check@example.com",
            "correct horse battery staple",
        ))
        .await;
    login_res.assert_status_ok();

    let sessions_res = server
        .get("/api/v1/auth/sessions")
        .add_header("x-forwarded-for", client_ip)
        .await;
    sessions_res.assert_status_ok();
    let sessions: Vec<serde_json::Value> = sessions_res.json();

    // The newest session (listed first) is from the login with the
    // forwarded IP.
    assert!(
        !sessions.is_empty(),
        "expected at least one active session after register+login"
    );
    assert_eq!(
        sessions[0]["ipAddress"].as_str(),
        Some(client_ip),
        "expected the most recent session's ipAddress to be populated with \
         the client IP computed by client_ip(), not left as null"
    );
}

/// Device cap per account (set to 3 here). The 4th device is rejected with
/// `device_limit_reached`; revoking one frees a slot.
#[sqlx::test(migrations = "./migrations")]
async fn device_registration_is_capped_per_account(pool: PgPool) {
    let mut config = test_config();
    config.max_devices_per_account = 3;
    let server = server_for_config(pool, config);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(
            "device-cap@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();
    let register_body: serde_json::Value = register_res.json();
    let csrf = register_body["csrfToken"].as_str().unwrap().to_string();

    let (first_device_id, _) = register_device(&server, "device-cap@example.com", "Laptop 1").await;
    register_device(&server, "device-cap@example.com", "Laptop 2").await;
    register_device(&server, "device-cap@example.com", "Laptop 3").await;

    // Already at the cap, so this one is rejected.
    let over_cap_res = server
        .post("/api/v1/devices/register")
        .json(&device_register_json(
            "device-cap@example.com",
            "correct horse battery staple",
            "Laptop 4",
        ))
        .await;
    over_cap_res.assert_status(axum::http::StatusCode::CONFLICT);
    let over_cap_body: serde_json::Value = over_cap_res.json();
    assert_eq!(
        over_cap_body["error"].as_str(),
        Some("device_limit_reached"),
        "expected the over-cap registration to be rejected with the \
         device_limit_reached error code"
    );

    // Revoking a device frees a slot.
    let revoke_res = server
        .post(&format!("/api/v1/devices/{}/revoke", first_device_id))
        .add_header("x-csrf-token", &csrf)
        .await;
    revoke_res.assert_status_ok();

    let after_revoke_res = server
        .post("/api/v1/devices/register")
        .json(&device_register_json(
            "device-cap@example.com",
            "correct horse battery staple",
            "Laptop 5",
        ))
        .await;
    after_revoke_res.assert_status_ok();
}

/// Concurrent registrations can't go over the device cap.
#[sqlx::test(migrations = "./migrations")]
async fn concurrent_device_registration_at_cap_is_serialized(pool: PgPool) {
    let mut config = test_config();
    config.max_devices_per_account = 3;
    let query_pool = pool.clone();
    let server = server_for_config(pool, config);

    let email = "concurrent-device-cap@example.com";
    let register_res = server
        .post("/api/v1/auth/register")
        .json(&register_json(email, "correct horse battery staple"))
        .await;
    register_res.assert_status_ok();

    // One slot left: exactly one registration below should get it.
    register_device(&server, email, "Laptop 1").await;
    register_device(&server, email, "Laptop 2").await;

    let concurrent_attempts = 5;
    let futures = (1..=concurrent_attempts).map(|i| {
        let req = server
            .post("/api/v1/devices/register")
            .json(&device_register_json(
                email,
                "correct horse battery staple",
                format!("Concurrent Device {i}"),
            ));
        async move { req.await }
    });

    let results = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        futures::future::join_all(futures),
    )
    .await
    .expect("concurrent device registrations must not deadlock or hang");

    let succeeded = results
        .iter()
        .filter(|res| res.status_code() == axum::http::StatusCode::OK)
        .count();
    let rejected = results
        .iter()
        .filter(|res| res.status_code() == axum::http::StatusCode::CONFLICT)
        .count();

    assert_eq!(
        succeeded, 1,
        "exactly one of the concurrent registrations should have claimed the \
         single remaining slot under the cap, got {succeeded} successes"
    );
    assert_eq!(
        rejected,
        concurrent_attempts - 1,
        "every other concurrent registration should have been rejected as \
         over the cap, got {rejected} rejections"
    );

    let active_device_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM devices d JOIN users u ON u.id = d.user_id \
         WHERE u.email = $1 AND d.revoked_at IS NULL",
    )
    .bind(email)
    .fetch_one(&query_pool)
    .await
    .unwrap();

    assert_eq!(
        active_device_count, 3,
        "the account's final active device count must never exceed \
         max_devices_per_account, regardless of how many registrations raced"
    );
}

/// Register and login responses carry the CSRF token, so they must never be
/// compressed (BREACH), even when the client asks for gzip. `/auth/sessions`
/// is still compressed, to show compression works.
#[sqlx::test(migrations = "./migrations")]
async fn auth_secrets_are_never_compressed_but_other_responses_still_are(pool: PgPool) {
    let server = server_for(pool);

    let register_res = server
        .post("/api/v1/auth/register")
        .add_header(axum::http::header::ACCEPT_ENCODING, "gzip")
        .json(&register_json(
            "hannah@example.com",
            "correct horse battery staple",
        ))
        .await;
    register_res.assert_status_ok();
    assert!(
        register_res
            .headers()
            .get(axum::http::header::CONTENT_ENCODING)
            .is_none(),
        "register response carries csrf_token and must never be compressed"
    );
    // The body must be plain JSON, not gzip.
    let register_body: serde_json::Value = register_res.json();
    assert!(register_body["csrfToken"].as_str().is_some());

    let login_res = server
        .post("/api/v1/auth/login")
        .add_header(axum::http::header::ACCEPT_ENCODING, "gzip")
        .json(&login_json(
            "hannah@example.com",
            "correct horse battery staple",
        ))
        .await;
    login_res.assert_status_ok();
    assert!(
        login_res
            .headers()
            .get(axum::http::header::CONTENT_ENCODING)
            .is_none(),
        "login response carries csrf_token and must never be compressed"
    );
    let login_body: serde_json::Value = login_res.json();
    assert!(login_body["csrfToken"].as_str().is_some());

    let sessions_res = server
        .get("/api/v1/auth/sessions")
        .add_header(axum::http::header::ACCEPT_ENCODING, "gzip")
        .await;
    sessions_res.assert_status_ok();
    assert_eq!(
        sessions_res
            .headers()
            .get(axum::http::header::CONTENT_ENCODING)
            .map(|v| v.to_str().unwrap()),
        Some("gzip"),
        "a non-secret endpoint should still be compressed when the client requests it, \
         otherwise this test would also pass if compression were disabled globally"
    );
}

// Cache race tests. Request A starts a DB read (t0). A revocation then
// writes its tombstone (t1 > t0). When A finally writes its stale "active"
// result, it must lose because its `as_of` is older.

#[test]
fn device_revocation_cache_write_cannot_overwrite_a_newer_revocation_with_a_stale_active() {
    let cache = dashmap::DashMap::new();
    let device_id = Uuid::new_v4();

    // A's DB read starts (t0), but it writes to the cache later.
    let read_started_at = Instant::now();

    // The revocation writes its tombstone after A started.
    std::thread::sleep(Duration::from_millis(5));
    let revoked_at = Instant::now();
    write_device_revocation_cache_entry(&cache, device_id, revoked_at, false);
    assert!(!cache.get(&device_id).unwrap().1);

    // A finishes and writes its stale "active" with the older time.
    write_device_revocation_cache_entry(&cache, device_id, read_started_at, true);

    // The revocation must still win.
    let entry = cache.get(&device_id).unwrap();
    assert!(
        !entry.1,
        "a stale in-flight read landing after a revocation overwrote the revocation's `false`"
    );
    assert_eq!(entry.0, revoked_at);
}

#[test]
fn device_revocation_cache_write_from_a_read_that_is_genuinely_newer_still_applies() {
    // A read that starts after the cached entry must still win.
    let cache = dashmap::DashMap::new();
    let device_id = Uuid::new_v4();

    let earlier = Instant::now();
    write_device_revocation_cache_entry(&cache, device_id, earlier, false);

    std::thread::sleep(Duration::from_millis(5));
    let later = Instant::now();
    write_device_revocation_cache_entry(&cache, device_id, later, true);

    let entry = cache.get(&device_id).unwrap();
    assert!(entry.1);
    assert_eq!(entry.0, later);
}

#[test]
fn web_session_cache_write_cannot_overwrite_a_newer_revocation_tombstone_with_stale_data() {
    let cache = dashmap::DashMap::new();
    let session_hash = "test-session-hash".to_string();
    let user_id = Uuid::new_v4();
    let email = "victim@example.com".to_string();

    // A's DB read starts (t0) while the session is valid.
    let read_started_at = Instant::now();

    // Logout writes its tombstone after A started.
    std::thread::sleep(Duration::from_millis(5));
    let revoked_at = Instant::now();
    write_web_session_cache_entry(&cache, session_hash.clone(), revoked_at, None);
    assert!(cache.get(&session_hash).unwrap().1.is_none());

    // A finishes and writes "valid" with the older time.
    write_web_session_cache_entry(
        &cache,
        session_hash.clone(),
        read_started_at,
        Some((user_id, email)),
    );

    // The revocation must still win.
    let entry = cache.get(&session_hash).unwrap();
    assert!(
        entry.1.is_none(),
        "a stale in-flight read landing after a session revocation overwrote its tombstone"
    );
    assert_eq!(entry.0, revoked_at);
}
