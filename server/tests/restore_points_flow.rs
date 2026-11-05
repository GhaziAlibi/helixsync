mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use axum_test::{TestServer, TestServerConfig, Transport};
use helixsync_server::config::{Config, RestorePointLimits};
use helixsync_server::housekeeping;
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

fn limits(f: impl FnOnce(&mut RestorePointLimits)) -> Config {
    let mut config = test_config();
    f(&mut config.restore_points);
    config
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

fn envelope(filler: usize) -> Value {
    json!({
        "v": 2,
        "keyVersion": 1,
        "alg": "A256GCM",
        "nonce": "AAAAAAAAAAAAAAAA",
        "ciphertext": "A".repeat(filler),
    })
}

fn point_body(id: Uuid, kind: &str, filler: usize) -> Value {
    json!({
        "id": id,
        "kind": kind,
        "bookmarkCount": 7,
        "encryptionVersion": 1,
        "codec": "deflate-raw",
        "envelope": envelope(filler),
    })
}

async fn upload(server: &TestServer, token: &str, body: &Value) -> axum_test::TestResponse {
    server
        .post("/api/v1/restore-points")
        .add_header("x-protocol-version", "1")
        .authorization_bearer(token)
        .json(body)
        .await
}

async fn upload_ok(server: &TestServer, token: &str, id: Uuid, kind: &str, filler: usize) -> Value {
    let res = upload(server, token, &point_body(id, kind, filler)).await;
    res.assert_status_ok();
    res.json()
}

async fn list_ids(server: &TestServer, token: &str) -> Vec<Uuid> {
    let res = server
        .get("/api/v1/restore-points")
        .authorization_bearer(token)
        .await;
    res.assert_status_ok();
    let body: Value = res.json();
    body["points"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap().parse().unwrap())
        .collect()
}

async fn set_pinned(
    server: &TestServer,
    token: &str,
    id: Uuid,
    pinned: bool,
) -> axum_test::TestResponse {
    server
        .patch(&format!("/api/v1/restore-points/{id}"))
        .add_header("x-protocol-version", "1")
        .authorization_bearer(token)
        .json(&json!({ "pinned": pinned }))
        .await
}

async fn tracked_bytes(pool: &PgPool, user_email: &str) -> (i64, i64) {
    let row = sqlx::query!(
        r#"SELECT COALESCE(s.restore_point_bytes, 0) AS "tracked!",
                  COALESCE((SELECT SUM(p.size_bytes) FROM bookmark_restore_points p WHERE p.user_id = u.id), 0)::bigint AS "actual!"
           FROM users u LEFT JOIN sync_stats s ON s.user_id = u.id WHERE u.email = $1"#,
        user_email
    )
    .fetch_one(pool)
    .await
    .unwrap();
    (row.tracked, row.actual)
}

#[sqlx::test(migrations = "./migrations")]
async fn round_trip_upload_list_get_pin_applied_delete(pool: PgPool) {
    let server = server_for(state_for(pool.clone(), test_config()));
    register(&server, "rp1@example.com").await;
    let (device_id, token) = register_device(&server, "rp1@example.com", "Laptop").await;

    let id = Uuid::now_v7();
    let meta = upload_ok(&server, &token, id, "manual", 100).await;
    assert_eq!(meta["id"], json!(id));
    assert_eq!(meta["kind"], "manual");
    assert_eq!(meta["bookmarkCount"], 7);
    assert_eq!(meta["codec"], "deflate-raw");
    assert_eq!(meta["pinned"], false);
    assert_eq!(meta["deviceId"], json!(device_id));
    assert_eq!(meta["deviceName"], "Laptop");
    assert!(meta["sizeBytes"].as_i64().unwrap() > 100);

    assert_eq!(list_ids(&server, &token).await, vec![id]);

    let res = server
        .get(&format!("/api/v1/restore-points/{id}"))
        .authorization_bearer(&token)
        .await;
    res.assert_status_ok();
    let body: Value = res.json();
    assert_eq!(body["envelope"], envelope(100));
    assert_eq!(body["id"], json!(id));

    let res = set_pinned(&server, &token, id, true).await;
    res.assert_status_ok();
    assert_eq!(res.json::<Value>()["pinned"], true);

    let res = server
        .post(&format!("/api/v1/restore-points/{id}/applied"))
        .add_header("x-protocol-version", "1")
        .authorization_bearer(&token)
        .json(&json!({ "mode": "merge", "partial": false }))
        .await;
    res.assert_status(StatusCode::NO_CONTENT);
    let listed: Value = server
        .get("/api/v1/restore-points")
        .authorization_bearer(&token)
        .await
        .json();
    assert!(!listed["points"][0]["lastRestoredAt"].is_null());

    let res = server
        .post(&format!("/api/v1/restore-points/{id}/applied"))
        .add_header("x-protocol-version", "1")
        .authorization_bearer(&token)
        .json(&json!({ "mode": "bogus", "partial": false }))
        .await;
    res.assert_status(StatusCode::BAD_REQUEST);

    let (tracked, actual) = tracked_bytes(&pool, "rp1@example.com").await;
    assert_eq!(tracked, actual);
    assert!(actual > 0);

    let res = server
        .delete(&format!("/api/v1/restore-points/{id}"))
        .add_header("x-protocol-version", "1")
        .authorization_bearer(&token)
        .await;
    res.assert_status(StatusCode::NO_CONTENT);
    assert!(list_ids(&server, &token).await.is_empty());
    assert_eq!(tracked_bytes(&pool, "rp1@example.com").await, (0, 0));

    let events: Vec<String> = sqlx::query_scalar!(
        "SELECT event_type FROM audit_logs WHERE event_type LIKE 'restore_point_%' ORDER BY id"
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        events,
        vec![
            "restore_point_pinned",
            "restore_point_applied",
            "restore_point_deleted"
        ]
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn reuploading_the_same_id_returns_the_existing_point(pool: PgPool) {
    let server = server_for(state_for(pool.clone(), test_config()));
    register(&server, "rp2@example.com").await;
    let (_, token) = register_device(&server, "rp2@example.com", "Laptop").await;

    let id = Uuid::now_v7();
    let first = upload_ok(&server, &token, id, "manual", 50).await;
    let second = upload_ok(&server, &token, id, "manual", 50).await;
    assert_eq!(first, second);
    assert_eq!(list_ids(&server, &token).await.len(), 1);
    let (tracked, actual) = tracked_bytes(&pool, "rp2@example.com").await;
    assert_eq!(tracked, actual);
}

#[sqlx::test(migrations = "./migrations")]
async fn other_accounts_points_are_not_found(pool: PgPool) {
    let server = server_for(state_for(pool.clone(), test_config()));
    register(&server, "owner@example.com").await;
    let (_, owner) = register_device(&server, "owner@example.com", "Laptop").await;
    register(&server, "other@example.com").await;
    let (_, other) = register_device(&server, "other@example.com", "Laptop").await;

    let id = Uuid::now_v7();
    upload_ok(&server, &owner, id, "manual", 10).await;

    server
        .get(&format!("/api/v1/restore-points/{id}"))
        .authorization_bearer(&other)
        .await
        .assert_status(StatusCode::NOT_FOUND);
    set_pinned(&server, &other, id, true)
        .await
        .assert_status(StatusCode::NOT_FOUND);
    server
        .delete(&format!("/api/v1/restore-points/{id}"))
        .add_header("x-protocol-version", "1")
        .authorization_bearer(&other)
        .await
        .assert_status(StatusCode::NOT_FOUND);
    server
        .post(&format!("/api/v1/restore-points/{id}/applied"))
        .add_header("x-protocol-version", "1")
        .authorization_bearer(&other)
        .json(&json!({ "mode": "merge", "partial": false }))
        .await
        .assert_status(StatusCode::NOT_FOUND);
    assert!(list_ids(&server, &other).await.is_empty());
    assert_eq!(list_ids(&server, &owner).await, vec![id]);
}

#[sqlx::test(migrations = "./migrations")]
async fn a_revoked_device_is_rejected(pool: PgPool) {
    let server = server_for(state_for(pool.clone(), test_config()));
    let csrf = register(&server, "rev@example.com").await;
    let (device_id, token) = register_device(&server, "rev@example.com", "Laptop").await;

    server
        .post(&format!("/api/v1/devices/{device_id}/revoke"))
        .add_header("x-csrf-token", &csrf)
        .await
        .assert_status_ok();

    upload(&server, &token, &point_body(Uuid::now_v7(), "manual", 10))
        .await
        .assert_status(StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrations = "./migrations")]
async fn web_session_can_list_pin_and_delete_but_not_download(pool: PgPool) {
    let server = server_for(state_for(pool.clone(), test_config()));
    let csrf = register(&server, "web@example.com").await;
    let (_, token) = register_device(&server, "web@example.com", "Laptop").await;
    let id = Uuid::now_v7();
    upload_ok(&server, &token, id, "manual", 10).await;

    // No bearer token: the saved session cookie authenticates.
    let res = server.get("/api/v1/restore-points").await;
    res.assert_status_ok();
    assert_eq!(res.json::<Value>()["points"].as_array().unwrap().len(), 1);

    server
        .get(&format!("/api/v1/restore-points/{id}"))
        .await
        .assert_status(StatusCode::UNAUTHORIZED);

    // CSRF is required on writes.
    server
        .patch(&format!("/api/v1/restore-points/{id}"))
        .add_header("x-protocol-version", "1")
        .json(&json!({ "pinned": true }))
        .await
        .assert_status(StatusCode::FORBIDDEN);

    let res = server
        .patch(&format!("/api/v1/restore-points/{id}"))
        .add_header("x-protocol-version", "1")
        .add_header("x-csrf-token", &csrf)
        .json(&json!({ "pinned": true }))
        .await;
    res.assert_status_ok();
    assert_eq!(res.json::<Value>()["pinned"], true);

    server
        .delete(&format!("/api/v1/restore-points/{id}"))
        .add_header("x-protocol-version", "1")
        .add_header("x-csrf-token", &csrf)
        .await
        .assert_status(StatusCode::NO_CONTENT);
}

#[sqlx::test(migrations = "./migrations")]
async fn upload_validation(pool: PgPool) {
    let mut config = limits(|l| l.max_bytes = 2000);
    config.require_encryption = true;
    let server = server_for(state_for(pool.clone(), config));
    register(&server, "val@example.com").await;
    let (_, token) = register_device(&server, "val@example.com", "Laptop").await;

    // Too large.
    upload(&server, &token, &point_body(Uuid::now_v7(), "manual", 5000))
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    // Plaintext while encryption is required.
    let mut plaintext = point_body(Uuid::now_v7(), "manual", 10);
    plaintext["encryptionVersion"] = json!(0);
    upload(&server, &token, &plaintext)
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    // Unknown kind, bad count, bad codec, non-object envelope.
    let mut bad = point_body(Uuid::now_v7(), "bogus", 10);
    upload(&server, &token, &bad)
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    bad = point_body(Uuid::now_v7(), "manual", 10);
    bad["bookmarkCount"] = json!(1_000_001);
    upload(&server, &token, &bad)
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    bad = point_body(Uuid::now_v7(), "manual", 10);
    bad["codec"] = json!("gzip");
    upload(&server, &token, &bad)
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    bad = point_body(Uuid::now_v7(), "manual", 10);
    bad["envelope"] = json!("not an object");
    upload(&server, &token, &bad)
        .await
        .assert_status(StatusCode::BAD_REQUEST);

    // The route's own body limit refuses oversized bodies before parsing.
    let res = upload(
        &server,
        &token,
        &point_body(Uuid::now_v7(), "manual", 200_000),
    )
    .await;
    res.assert_status(StatusCode::PAYLOAD_TOO_LARGE);

    assert!(list_ids(&server, &token).await.is_empty());
}

#[sqlx::test(migrations = "./migrations")]
async fn writes_need_the_protocol_version_header(pool: PgPool) {
    let server = server_for(state_for(pool.clone(), test_config()));
    register(&server, "hdr@example.com").await;
    let (_, token) = register_device(&server, "hdr@example.com", "Laptop").await;

    server
        .post("/api/v1/restore-points")
        .authorization_bearer(&token)
        .json(&point_body(Uuid::now_v7(), "manual", 10))
        .await
        .assert_status(StatusCode::UPGRADE_REQUIRED);

    // Reads still work without it.
    server
        .get("/api/v1/restore-points")
        .authorization_bearer(&token)
        .await
        .assert_status_ok();
}

#[sqlx::test(migrations = "./migrations")]
async fn scheduled_points_are_deduped_but_manual_ones_are_not(pool: PgPool) {
    let server = server_for(state_for(pool.clone(), test_config()));
    register(&server, "sched@example.com").await;
    let (_, token) = register_device(&server, "sched@example.com", "Laptop").await;

    upload_ok(&server, &token, Uuid::now_v7(), "scheduled", 10).await;
    let res = upload(
        &server,
        &token,
        &point_body(Uuid::now_v7(), "scheduled", 10),
    )
    .await;
    res.assert_status(StatusCode::CONFLICT);
    assert_eq!(res.json::<Value>()["error"], "restore_point_recent");

    upload_ok(&server, &token, Uuid::now_v7(), "manual", 10).await;
    upload_ok(&server, &token, Uuid::now_v7(), "manual", 10).await;
    upload_ok(&server, &token, Uuid::now_v7(), "mass_delete", 10).await;
    assert_eq!(list_ids(&server, &token).await.len(), 4);
}

#[sqlx::test(migrations = "./migrations")]
async fn automatic_kinds_are_refused_when_disabled(pool: PgPool) {
    let server = server_for(state_for(pool.clone(), test_config()));
    register(&server, "auto@example.com").await;
    let (_, token) = register_device(&server, "auto@example.com", "Laptop").await;

    let res = server
        .patch("/api/v1/sync/settings")
        .authorization_bearer(&token)
        .json(&json!({ "restorePointsAutomatic": false }))
        .await;
    res.assert_status_ok();
    assert_eq!(res.json::<Value>()["restorePointsAutomatic"], false);

    for kind in [
        "scheduled",
        "pre_restore",
        "pre_import",
        "pre_resync",
        "mass_delete",
    ] {
        let res = upload(&server, &token, &point_body(Uuid::now_v7(), kind, 10)).await;
        res.assert_status(StatusCode::CONFLICT);
        assert_eq!(res.json::<Value>()["error"], "restore_points_disabled");
    }
    upload_ok(&server, &token, Uuid::now_v7(), "manual", 10).await;

    let settings: Value = server
        .get("/api/v1/sync/settings")
        .authorization_bearer(&token)
        .await
        .json();
    assert_eq!(settings["restorePointsAutomatic"], false);
}

#[sqlx::test(migrations = "./migrations")]
async fn count_cap_evicts_oldest_unpinned_automatic_first(pool: PgPool) {
    let server = server_for(state_for(pool.clone(), limits(|l| l.max_per_account = 3)));
    register(&server, "evict@example.com").await;
    let (_, token) = register_device(&server, "evict@example.com", "Laptop").await;

    let manual_old = Uuid::now_v7();
    let auto_a = Uuid::now_v7();
    let auto_b = Uuid::now_v7();
    upload_ok(&server, &token, manual_old, "manual", 10).await;
    upload_ok(&server, &token, auto_a, "pre_restore", 10).await;
    upload_ok(&server, &token, auto_b, "pre_import", 10).await;

    // Over the cap: the oldest automatic point goes, not the older manual one.
    let newest = Uuid::now_v7();
    upload_ok(&server, &token, newest, "manual", 10).await;
    let ids = list_ids(&server, &token).await;
    assert_eq!(ids.len(), 3);
    assert!(!ids.contains(&auto_a));
    assert!(ids.contains(&manual_old) && ids.contains(&auto_b) && ids.contains(&newest));

    // Next: the other automatic one, then (none left) the oldest manual one.
    upload_ok(&server, &token, Uuid::now_v7(), "manual", 10).await;
    let ids = list_ids(&server, &token).await;
    assert!(!ids.contains(&auto_b) && ids.contains(&manual_old));
    upload_ok(&server, &token, Uuid::now_v7(), "manual", 10).await;
    let ids = list_ids(&server, &token).await;
    assert!(!ids.contains(&manual_old));
    assert_eq!(ids.len(), 3);

    let (tracked, actual) = tracked_bytes(&pool, "evict@example.com").await;
    assert_eq!(tracked, actual);
}

#[sqlx::test(migrations = "./migrations")]
async fn byte_cap_evicts_and_pinned_only_gives_limit_error(pool: PgPool) {
    // Each point is a little over 1000 bytes; two fit, three do not.
    let server = server_for(state_for(
        pool.clone(),
        limits(|l| l.max_account_bytes = 2500),
    ));
    register(&server, "bytes@example.com").await;
    let (_, token) = register_device(&server, "bytes@example.com", "Laptop").await;

    let a = Uuid::now_v7();
    let b = Uuid::now_v7();
    upload_ok(&server, &token, a, "manual", 1000).await;
    upload_ok(&server, &token, b, "manual", 1000).await;
    let c = Uuid::now_v7();
    upload_ok(&server, &token, c, "manual", 1000).await;
    let ids = list_ids(&server, &token).await;
    assert_eq!(ids.len(), 2);
    assert!(!ids.contains(&a));
    let (tracked, actual) = tracked_bytes(&pool, "bytes@example.com").await;
    assert_eq!(tracked, actual);

    // Pin everything: nothing can be evicted, the upload is refused whole.
    set_pinned(&server, &token, b, true)
        .await
        .assert_status_ok();
    set_pinned(&server, &token, c, true)
        .await
        .assert_status_ok();
    let before = tracked_bytes(&pool, "bytes@example.com").await;
    let res = upload(&server, &token, &point_body(Uuid::now_v7(), "manual", 1000)).await;
    res.assert_status(StatusCode::CONFLICT);
    assert_eq!(res.json::<Value>()["error"], "restore_point_limit");
    assert_eq!(list_ids(&server, &token).await.len(), 2);
    assert_eq!(tracked_bytes(&pool, "bytes@example.com").await, before);
}

#[sqlx::test(migrations = "./migrations")]
async fn pin_cap_is_enforced(pool: PgPool) {
    let server = server_for(state_for(pool.clone(), limits(|l| l.max_pinned = 2)));
    register(&server, "pin@example.com").await;
    let (_, token) = register_device(&server, "pin@example.com", "Laptop").await;

    let ids: Vec<Uuid> = (0..3).map(|_| Uuid::now_v7()).collect();
    for id in &ids {
        upload_ok(&server, &token, *id, "manual", 10).await;
    }
    set_pinned(&server, &token, ids[0], true)
        .await
        .assert_status_ok();
    set_pinned(&server, &token, ids[1], true)
        .await
        .assert_status_ok();
    // Pinning an already pinned point is a no-op, not a limit error.
    set_pinned(&server, &token, ids[1], true)
        .await
        .assert_status_ok();
    let res = set_pinned(&server, &token, ids[2], true).await;
    res.assert_status(StatusCode::CONFLICT);
    assert_eq!(res.json::<Value>()["error"], "restore_point_pin_limit");
    set_pinned(&server, &token, ids[0], false)
        .await
        .assert_status_ok();
    set_pinned(&server, &token, ids[2], true)
        .await
        .assert_status_ok();
}

async fn backdate(pool: &PgPool, id: Uuid, days: i32) {
    sqlx::query!(
        "UPDATE bookmark_restore_points SET created_at = now() - make_interval(days => $2) WHERE id = $1",
        id,
        days
    )
    .execute(pool)
    .await
    .unwrap();
}

#[sqlx::test(migrations = "./migrations")]
async fn housekeeping_prunes_old_points_but_keeps_newest_and_pinned(pool: PgPool) {
    let state = state_for(pool.clone(), test_config());
    let server = server_for(state.clone());
    register(&server, "hk@example.com").await;
    let (_, token) = register_device(&server, "hk@example.com", "Laptop").await;

    let old = Uuid::now_v7();
    let old_pinned = Uuid::now_v7();
    let newest_old = Uuid::now_v7();
    let fresh = Uuid::now_v7();
    upload_ok(&server, &token, old, "manual", 100).await;
    upload_ok(&server, &token, old_pinned, "manual", 100).await;
    set_pinned(&server, &token, old_pinned, true)
        .await
        .assert_status_ok();
    backdate(&pool, old, 200).await;
    backdate(&pool, old_pinned, 190).await;

    housekeeping::run_once(&state).await;
    // `old` is older than retention and a newer point exists: gone.
    let ids = list_ids(&server, &token).await;
    assert_eq!(ids, vec![old_pinned]);
    let (tracked, actual) = tracked_bytes(&pool, "hk@example.com").await;
    assert_eq!(tracked, actual);

    // The newest point is kept even when it is past retention (here the only
    // unpinned old point is the account's second-newest, so add one).
    upload_ok(&server, &token, newest_old, "manual", 100).await;
    backdate(&pool, newest_old, 100).await;
    housekeeping::run_once(&state).await;
    let ids = list_ids(&server, &token).await;
    assert!(ids.contains(&newest_old) && ids.contains(&old_pinned));

    upload_ok(&server, &token, fresh, "manual", 100).await;
    housekeeping::run_once(&state).await;
    let ids = list_ids(&server, &token).await;
    assert!(!ids.contains(&newest_old));
    assert!(ids.contains(&fresh) && ids.contains(&old_pinned));
    let (tracked, actual) = tracked_bytes(&pool, "hk@example.com").await;
    assert_eq!(tracked, actual);
}

#[sqlx::test(migrations = "./migrations")]
async fn account_delete_cascades_and_device_delete_keeps_points(pool: PgPool) {
    let server = server_for(state_for(pool.clone(), test_config()));
    register(&server, "cas@example.com").await;
    let (device_id, token) = register_device(&server, "cas@example.com", "Laptop").await;
    let id = Uuid::now_v7();
    upload_ok(&server, &token, id, "manual", 10).await;

    sqlx::query!("DELETE FROM devices WHERE id = $1", device_id)
        .execute(&pool)
        .await
        .unwrap();
    let row = sqlx::query!(
        "SELECT device_id FROM bookmark_restore_points WHERE id = $1",
        id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(row.device_id.is_none());

    // The web session still lists it, with no device name.
    let listed: Value = server.get("/api/v1/restore-points").await.json();
    assert_eq!(listed["points"][0]["deviceName"], Value::Null);

    sqlx::query!("DELETE FROM users WHERE email = 'cas@example.com'")
        .execute(&pool)
        .await
        .unwrap();
    let left = sqlx::query_scalar!(r#"SELECT COUNT(*) AS "n!" FROM bookmark_restore_points"#)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[sqlx::test(migrations = "./migrations")]
async fn version_stats_and_settings_report_restore_points(pool: PgPool) {
    let server = server_for(state_for(pool.clone(), test_config()));
    register(&server, "info@example.com").await;
    let (_, token) = register_device(&server, "info@example.com", "Laptop").await;

    let version: Value = server.get("/api/v1/version").await.json();
    assert_eq!(version["restorePoints"], true);

    upload_ok(&server, &token, Uuid::now_v7(), "manual", 100).await;
    let stats: Value = server
        .get("/api/v1/sync/stats")
        .authorization_bearer(&token)
        .await
        .json();
    assert_eq!(stats["restorePointCount"], 1);
    assert!(stats["restorePointBytes"].as_i64().unwrap() > 100);
    assert_eq!(
        stats["restorePointLimitBytes"],
        RestorePointLimits::default().max_account_bytes
    );
    // Restore points do not count against the sync storage budget.
    assert_eq!(stats["storageBytes"], 0);

    let settings: Value = server
        .get("/api/v1/sync/settings")
        .authorization_bearer(&token)
        .await
        .json();
    assert_eq!(settings["restorePointsAutomatic"], true);
}
