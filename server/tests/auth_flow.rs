use std::sync::Arc;

use axum_test::{TestServer, TestServerConfig, Transport};
use helixsync_server::config::Config;
use helixsync_server::middleware::rate_limit::{
    RateLimitPartition, RateLimiter, TOKEN_REFRESH_IP_LIMIT, TOKEN_REFRESH_LIMIT,
};
use helixsync_server::state::AppState;
use helixsync_server::websocket::ConnectionRegistry;
use serde_json::json;
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
        housekeeping_interval_secs: 60 * 60 * 24,
        device_credential_retention_secs: 60 * 60 * 24 * 7,
        audit_log_retention_secs: 60 * 60 * 24 * 90,
        database_max_connections: 5,
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
    };
    let test_server_config = TestServerConfig {
        transport: Some(Transport::HttpRandomPort),
        save_cookies: true,
        ..Default::default()
    };
    let make_service = helixsync_server::app(state)
        .into_make_service_with_connect_info::<std::net::SocketAddr>();
    TestServer::new_with_config(make_service, test_server_config).unwrap()
}

fn server_for(pool: PgPool) -> TestServer {
    server_for_config(pool, test_config())
}

/// Regression test: the web client always parses a JSON body on any
/// non-204 response (see web/src/api/client.ts). An endpoint that returns
/// 200 with an empty body silently breaks every caller with an unhandled
/// promise rejection — logout previously did exactly this.
#[sqlx::test(migrations = "./migrations")]
async fn logout_returns_no_content_and_actually_ends_the_session(pool: PgPool) {
    let server = server_for(pool);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&json!({ "email": "gina@example.com", "password": "correct horse battery staple" }))
        .await;
    register_res.assert_status_ok();

    let me_before = server.get("/api/v1/auth/me").await;
    me_before.assert_status_ok();

    let logout_res = server.post("/api/v1/auth/logout").await;
    logout_res.assert_status(axum::http::StatusCode::NO_CONTENT);
    assert!(
        logout_res.as_bytes().is_empty(),
        "204 response must not carry a body"
    );

    let me_after = server.get("/api/v1/auth/me").await;
    me_after.assert_status_unauthorized();
}

#[sqlx::test(migrations = "./migrations")]
async fn change_password_requires_correct_current_password(pool: PgPool) {
    let server = server_for(pool);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&json!({ "email": "harry@example.com", "password": "correct horse battery staple" }))
        .await;
    register_res.assert_status_ok();
    let body: serde_json::Value = register_res.json();
    let csrf = body["csrfToken"].as_str().unwrap().to_string();

    let wrong = server
        .post("/api/v1/auth/password")
        .add_header("x-csrf-token", &csrf)
        .json(&json!({ "currentPassword": "wrong password wrong", "newPassword": "another long password" }))
        .await;
    wrong.assert_status_unauthorized();

    let right = server
        .post("/api/v1/auth/password")
        .add_header("x-csrf-token", &csrf)
        .json(&json!({ "currentPassword": "correct horse battery staple", "newPassword": "a brand new long password" }))
        .await;
    right.assert_status_ok();

    // Old password must no longer work.
    let old_login = server
        .post("/api/v1/auth/login")
        .json(&json!({ "email": "harry@example.com", "password": "correct horse battery staple" }))
        .await;
    old_login.assert_status_unauthorized();

    let new_login = server
        .post("/api/v1/auth/login")
        .json(&json!({ "email": "harry@example.com", "password": "a brand new long password" }))
        .await;
    new_login.assert_status_ok();
}

async fn register_device(server: &TestServer, email: &str, name: &str) -> (String, String) {
    let res = server
        .post("/api/v1/devices/register")
        .json(&json!({
            "email": email,
            "password": "correct horse battery staple",
            "name": name
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    (
        body["deviceId"].as_str().unwrap().to_string(),
        body["refreshToken"].as_str().unwrap().to_string(),
    )
}

/// SRV-PERF-6 regression: `/api/v1/devices/credentials/refresh` rotates the
/// presented refresh token on every successful call (docs/security.md
/// §1.2), so the original hash-only rate limit keyed on the presented
/// token's hash was rebucketed fresh every call for a strictly-rotating
/// sequence of tokens — a legitimate client faithfully following rotation
/// (or an attacker replaying a leaked credential and always advancing to
/// the newest token) could call this endpoint indefinitely without ever
/// tripping the limit. Before the device-id-keyed second check was added,
/// this exact loop would have gotten 200 OK on every single iteration, no
/// matter how many, since a hash-keyed bucket alone can never fire against
/// distinct, never-repeated tokens. With the fix, the device-id-keyed
/// bucket (rotation-invariant) still accumulates across calls and must
/// trip once `TOKEN_REFRESH_AUTHENTICATED_LIMIT`'s 30/60s limit is exceeded.
#[sqlx::test(migrations = "./migrations")]
async fn rapid_token_rotation_is_rate_limited_by_device_not_by_hash(pool: PgPool) {
    let mut config = test_config();
    config.behind_proxy = true;
    let server = server_for_config(pool, config);

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&json!({ "email": "ivy@example.com", "password": "correct horse battery staple" }))
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

/// SRV-09 regression: `/api/v1/devices/credentials/refresh` must enforce an
/// IP-level rate limit before touching the database or hashing tokens,
/// preventing an unauthenticated attacker from flooding random tokens from
/// one IP to exhaust connection pool slots or rate limiter memory.
#[sqlx::test(migrations = "./migrations")]
async fn refresh_credentials_is_rate_limited_by_ip_even_with_random_tokens(pool: PgPool) {
    let server = server_for(pool);

    let mut hit_rate_limit = false;
    for i in 0..310 {
        // Send a unique, random refresh token every iteration so hash-based
        // rate limiting never triggers (every call lands in a fresh hash bucket).
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

/// SRV-01 regression: `/api/v1/devices/credentials/refresh` validates the
/// device identity after looking up the credential in the database and must
/// enforce rate limiting under `TOKEN_REFRESH_AUTHENTICATED_LIMIT`
/// (in `RateLimitPartition::Authenticated`). When an attacker floods the
/// untrusted partition to capacity (25,000 entries), an authenticated
/// device must still be able to refresh its credentials.
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
    };
    let test_server_config = TestServerConfig {
        transport: Some(Transport::HttpRandomPort),
        save_cookies: true,
        ..Default::default()
    };
    let make_service = helixsync_server::app(state)
        .into_make_service_with_connect_info::<std::net::SocketAddr>();
    let server = TestServer::new_with_config(make_service, test_server_config).unwrap();

    let register_res = server
        .post("/api/v1/auth/register")
        .json(&json!({ "email": "jack@example.com", "password": "correct horse battery staple" }))
        .await;
    register_res.assert_status_ok();

    let (_device_id, refresh_token) =
        register_device(&server, "jack@example.com", "Laptop").await;

    let client_ip = "198.51.100.42";
    let token_hash = helixsync_server::crypto::hash_token(&refresh_token);

    // Warm the untrusted partition for the IP and token hash before saturating it,
    // simulating an already active connection/token.
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

    // Now saturate the untrusted partition to capacity (25,000 entries)
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

    // Attempting a refresh with valid credentials must succeed because
    // cred.device_id is checked in the Authenticated partition.
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

