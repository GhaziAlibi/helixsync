use std::sync::Arc;

use axum_test::{TestServer, TestServerConfig, Transport};
use helixsync_server::config::Config;
use helixsync_server::middleware::rate_limit::RateLimiter;
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
        cors_allowed_origins: vec![],
        protocol_version: 1,
        minimum_supported_protocol_version: 1,
        api_version: "v1".to_string(),
        tombstone_retention_secs: 60 * 60 * 24 * 30,
        compaction_interval_secs: 60 * 60,
    }
}

fn server_for(pool: PgPool) -> TestServer {
    let state = AppState {
        db: pool,
        config: Arc::new(test_config()),
        rate_limiter: Arc::new(RateLimiter::new()),
        ws_registry: Arc::new(ConnectionRegistry::new()),
    };
    let config = TestServerConfig {
        transport: Some(Transport::HttpRandomPort),
        save_cookies: true,
        ..Default::default()
    };
    let make_service = helixsync_server::app(state)
        .into_make_service_with_connect_info::<std::net::SocketAddr>();
    TestServer::new_with_config(make_service, config).unwrap()
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
