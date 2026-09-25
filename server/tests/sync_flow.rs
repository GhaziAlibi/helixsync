use std::sync::Arc;

use axum_test::{TestServer, TestServerConfig, Transport};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use helixsync_server::config::Config;
use helixsync_server::housekeeping;
use helixsync_server::middleware::rate_limit::{
    RateLimiter, SYNC_SETTINGS_LIMIT, SYNC_STATS_LIMIT,
};
use helixsync_server::state::AppState;
use helixsync_server::sync::compaction;
use helixsync_server::websocket::ConnectionRegistry;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

fn test_config() -> Config {
    Config {
        database_url: String::new(), // unused once the pool exists
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

fn state_for_config(pool: PgPool, config: Config) -> AppState {
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

fn server_for_state(state: AppState) -> TestServer {
    let config = TestServerConfig {
        transport: Some(Transport::HttpRandomPort),
        ..Default::default()
    };
    let make_service =
        helixsync_server::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    TestServer::new_with_config(make_service, config).unwrap()
}

fn server_for(pool: PgPool) -> TestServer {
    server_for_state(state_for_config(pool, test_config()))
}

async fn register_and_login(server: &TestServer, email: &str) {
    let res = server
        .post("/api/v1/auth/register")
        .json(&json!({ "email": email, "password": "correct horse battery staple" }))
        .await;
    res.assert_status_ok();
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
        body["accessToken"].as_str().unwrap().to_string(),
    )
}

fn sample_bookmark_op(op_id: Uuid, object_id: Uuid, seq: i64, lamport: i64) -> serde_json::Value {
    json!({
        "operationId": op_id,
        "deviceSequence": seq,
        "lamportTimestamp": lamport,
        "objectType": "bookmark",
        "objectId": object_id,
        "operationType": "create",
        "encryptionVersion": 0,
        "payload": { "title": "Example", "url": "https://example.com", "parent": null, "position": "a0" }
    })
}

#[sqlx::test(migrations = "./migrations")]
async fn register_login_and_device_flow(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "alice@example.com").await;
    let (device_id, access_token) =
        register_device(&server, "alice@example.com", "Test Laptop").await;
    assert!(!device_id.is_empty());
    assert!(!access_token.is_empty());
}

#[sqlx::test(migrations = "./migrations")]
async fn duplicate_operation_upload_is_idempotent(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "bob@example.com").await;
    let (_device_id, access_token) = register_device(&server, "bob@example.com", "Laptop").await;

    let op_id = Uuid::now_v7();
    let object_id = Uuid::now_v7();
    let op = sample_bookmark_op(op_id, object_id, 1, 1);

    let res1 = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op.clone()] }))
        .await;
    res1.assert_status_ok();
    let body1: serde_json::Value = res1.json();
    assert_eq!(body1["accepted"].as_array().unwrap().len(), 1);
    let cursor1 = body1["serverCursor"].as_i64().unwrap();

    // Retry the same op (as after a dropped response).
    let res2 = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await;
    res2.assert_status_ok();
    let body2: serde_json::Value = res2.json();
    assert_eq!(body2["duplicate"].as_array().unwrap().len(), 1);
    assert!(body2["accepted"].as_array().unwrap().is_empty());
    assert_eq!(body2["serverCursor"].as_i64().unwrap(), cursor1);
}

#[sqlx::test(migrations = "./migrations")]
async fn empty_operations_batch_returns_current_cursor(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "dana@example.com").await;
    let (_device_id, access_token) = register_device(&server, "dana@example.com", "Laptop").await;

    let op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    let res1 = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await;
    res1.assert_status_ok();
    let body1: serde_json::Value = res1.json();
    let cursor1 = body1["serverCursor"].as_i64().unwrap();

    // An empty batch succeeds and returns the current cursor.
    let res2 = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [] }))
        .await;
    res2.assert_status_ok();
    let body2: serde_json::Value = res2.json();
    assert!(body2["accepted"].as_array().unwrap().is_empty());
    assert!(body2["duplicate"].as_array().unwrap().is_empty());
    assert!(body2["rejected"].as_array().unwrap().is_empty());
    assert_eq!(body2["serverCursor"].as_i64().unwrap(), cursor1);
}

#[sqlx::test(migrations = "./migrations")]
async fn duplicate_only_batch_returns_current_cursor_not_stale_max(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "erin@example.com").await;
    let (_device_a_id, access_token_a) =
        register_device(&server, "erin@example.com", "Laptop A").await;
    let (_device_b_id, access_token_b) =
        register_device(&server, "erin@example.com", "Laptop B").await;

    // Device A uploads one op.
    let op_a = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    let res_a = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token_a)
        .json(&json!({ "operations": [op_a.clone()] }))
        .await;
    res_a.assert_status_ok();
    let body_a: serde_json::Value = res_a.json();
    let cursor_after_a = body_a["serverCursor"].as_i64().unwrap();

    // Device B uploads one, moving the account cursor further.
    let op_b = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    let res_b = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token_b)
        .json(&json!({ "operations": [op_b] }))
        .await;
    res_b.assert_status_ok();
    let body_b: serde_json::Value = res_b.json();
    let cursor_after_b = body_b["serverCursor"].as_i64().unwrap();
    assert!(
        cursor_after_b > cursor_after_a,
        "device B's upload should have advanced the account cursor past device A's"
    );

    // Device A retries its op. It's a duplicate, but the response must show
    // the account's current cursor (`cursor_after_b`), not the old one.
    let res_retry = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token_a)
        .json(&json!({ "operations": [op_a] }))
        .await;
    res_retry.assert_status_ok();
    let body_retry: serde_json::Value = res_retry.json();
    assert_eq!(body_retry["duplicate"].as_array().unwrap().len(), 1);
    assert!(body_retry["accepted"].as_array().unwrap().is_empty());
    assert_eq!(
        body_retry["serverCursor"].as_i64().unwrap(),
        cursor_after_b,
        "a duplicate-only batch must report the account's true current cursor, \
         not the stale max cursor among the duplicate rows"
    );
}

// A `deviceSequence` at or below the device's last one is reported
// `duplicate`, even with a different `operationId`. Sequences are never
// reused (docs/protocol.md §4.1), so this is almost always a retry whose
// response was lost.
#[sqlx::test(migrations = "./migrations")]
async fn stale_device_sequence_is_reported_duplicate(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "carol@example.com").await;
    let (_device_id, access_token) = register_device(&server, "carol@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    let op1 = sample_bookmark_op(Uuid::now_v7(), object_id, 5, 10);
    let res1 = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op1] }))
        .await;
    res1.assert_status_ok();

    // Same or lower sequence, different operationId: `duplicate`.
    let mut op2 = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 5, 11);
    op2["operationType"] = json!("create");
    let res2 = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op2] }))
        .await;
    res2.assert_status_ok();
    let body2: serde_json::Value = res2.json();
    assert!(body2["accepted"].as_array().unwrap().is_empty());
    assert!(body2["rejected"].as_array().unwrap().is_empty());
    let duplicate = body2["duplicate"].as_array().unwrap();
    assert_eq!(duplicate.len(), 1);
    assert_eq!(duplicate[0], op2["operationId"]);
}

// Out-of-order sequences within one batch are rejected as
// `sequence_out_of_order`, unlike a replay of an earlier batch, which is
// `duplicate`.
#[sqlx::test(migrations = "./migrations")]
async fn out_of_order_device_sequence_within_one_batch_is_rejected(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "dana@example.com").await;
    let (_device_id, access_token) = register_device(&server, "dana@example.com", "Laptop").await;

    // Four new objects with sequences [1, 2, 4, 3]. The last is out of order
    // within the batch.
    let op1 = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 10);
    let op2 = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 2, 11);
    let op3 = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 4, 12);
    let op4 = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 3, 13);

    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op1, op2, op3, op4] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();

    assert_eq!(body["accepted"].as_array().unwrap().len(), 3);
    let rejected = body["rejected"].as_array().unwrap();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0]["operationId"], op4["operationId"]);
    assert_eq!(rejected[0]["reason"], "sequence_out_of_order");
}

// --- per-user require_encryption ---
//
// There's no API to set `user_settings.require_encryption`, so these tests
// set it with SQL and check that uploads respect it.

#[sqlx::test(migrations = "./migrations")]
async fn per_user_require_encryption_rejects_plaintext_even_when_global_flag_is_off(pool: PgPool) {
    // Server-wide flag off; only the per-user setting is on.
    let server = server_for(pool.clone());
    register_and_login(&server, "erin@example.com").await;
    let (_device_id, access_token) = register_device(&server, "erin@example.com", "Laptop").await;

    let user_id = user_id_for_email(&pool, "erin@example.com").await;
    sqlx::query!(
        "UPDATE user_settings SET require_encryption = true WHERE user_id = $1",
        user_id
    )
    .execute(&pool)
    .await
    .unwrap();

    let op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1); // encryptionVersion: 0
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(body["accepted"].as_array().unwrap().is_empty());
    let rejected = body["rejected"].as_array().unwrap();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0]["reason"], "encryption_required");
}

#[sqlx::test(migrations = "./migrations")]
async fn global_require_encryption_rejects_plaintext_regardless_of_per_user_setting(pool: PgPool) {
    // Server-wide flag on, per-user setting off: still enforced.
    let config = Config {
        require_encryption: true,
        ..test_config()
    };
    let server = server_for_state(state_for_config(pool.clone(), config));
    register_and_login(&server, "frank@example.com").await;
    let (_device_id, access_token) = register_device(&server, "frank@example.com", "Laptop").await;

    let user_id = user_id_for_email(&pool, "frank@example.com").await;
    let per_user_flag: bool = sqlx::query_scalar!(
        "SELECT require_encryption FROM user_settings WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !per_user_flag,
        "sanity check: per-user column must default to false"
    );

    let op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1); // encryptionVersion: 0
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(body["accepted"].as_array().unwrap().is_empty());
    let rejected = body["rejected"].as_array().unwrap();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0]["reason"], "encryption_required");
}

#[sqlx::test(migrations = "./migrations")]
async fn download_returns_operations_after_cursor(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "dave@example.com").await;
    let (_device_id, access_token) = register_device(&server, "dave@example.com", "Laptop").await;

    let op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    let upload_res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await;
    upload_res.assert_status_ok();

    let download_res = server
        .get("/api/v1/sync/changes?cursor=0")
        .authorization_bearer(&access_token)
        .await;
    download_res.assert_status_ok();
    let body: serde_json::Value = download_res.json();
    assert_eq!(body["operations"].as_array().unwrap().len(), 1);
    assert_eq!(body["hasMore"], json!(false));
    assert!(body["nextCursor"].as_i64().unwrap() >= 1);

    // Re-downloading from the new cursor returns nothing further.
    let next_cursor = body["nextCursor"].as_i64().unwrap();
    let download_res2 = server
        .get(&format!("/api/v1/sync/changes?cursor={next_cursor}"))
        .authorization_bearer(&access_token)
        .await;
    download_res2.assert_status_ok();
    let body2: serde_json::Value = download_res2.json();
    assert!(body2["operations"].as_array().unwrap().is_empty());
}

/// After compaction, a stale cursor gets `409` with exactly
/// `{"error":"cursor_too_old","snapshotUrl":"/api/v1/sync/snapshot"}`
/// (docs/protocol.md §10.1).
#[sqlx::test(migrations = "./migrations")]
async fn cursor_too_old_returns_documented_body(pool: PgPool) {
    let state = state_for_config(pool.clone(), test_config());
    let server = server_for_state(state.clone());
    register_and_login(&server, "tara@example.com").await;
    let (_device_id, access_token) = register_device(&server, "tara@example.com", "Laptop").await;

    let op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await
        .assert_status_ok();

    // Ack and compact so the floor moves above 0.
    sync_device(&server, &access_token).await;
    compaction::run_once(&state).await.unwrap();

    let res = server
        .get("/api/v1/sync/changes?cursor=0")
        .authorization_bearer(&access_token)
        .await;
    res.assert_status(axum::http::StatusCode::CONFLICT);
    let body: serde_json::Value = res.json();
    assert_eq!(
        body,
        json!({ "error": "cursor_too_old", "snapshotUrl": "/api/v1/sync/snapshot" }),
        "409 body must match docs/protocol.md §10.1 exactly, no extra/missing keys"
    );
}

/// A cursor above the highest one ever handed out (e.g. from before a DB
/// restore) must be rejected like `cursor_too_old`, not return empty pages
/// forever.
#[sqlx::test(migrations = "./migrations")]
async fn cursor_above_ceiling_returns_conflict_not_empty_page(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "uma@example.com").await;
    let (_device_id, access_token) = register_device(&server, "uma@example.com", "Laptop").await;

    // The real max cursor is 1.
    let op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await
        .assert_status_ok();

    // The device sends a stale cursor far above that.
    let res = server
        .get("/api/v1/sync/changes?cursor=1500")
        .authorization_bearer(&access_token)
        .await;
    res.assert_status(axum::http::StatusCode::CONFLICT);
    let body: serde_json::Value = res.json();
    assert_eq!(
        body,
        json!({ "error": "cursor_invalid", "snapshotUrl": "/api/v1/sync/snapshot" }),
        "a cursor above the allocator ceiling must force snapshot resync, not an empty page"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn delete_creates_tombstone_excluded_from_snapshot(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "erin@example.com").await;
    let (_device_id, access_token) = register_device(&server, "erin@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    let create_op = sample_bookmark_op(Uuid::now_v7(), object_id, 1, 1);
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [create_op] }))
        .await
        .assert_status_ok();

    let delete_op = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 2,
        "lamportTimestamp": 2,
        "objectType": "bookmark",
        "objectId": object_id,
        "operationType": "delete",
        "encryptionVersion": 0,
        "payload": {}
    });
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [delete_op] }))
        .await
        .assert_status_ok();

    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&access_token)
        .await;
    snapshot_res.assert_status_ok();
    let snapshot: serde_json::Value = snapshot_res.json();
    assert!(snapshot["objects"].as_array().unwrap().is_empty());
    let tombstones = snapshot["tombstones"].as_array().unwrap();
    assert_eq!(tombstones.len(), 1);
    assert_eq!(tombstones[0]["objectId"], json!(object_id));
}

/// The snapshot has a top-level `encryptionVersion`: the highest version
/// among its objects (docs/protocol.md §10.3).
#[sqlx::test(migrations = "./migrations")]
async fn snapshot_reports_max_encryption_version_across_objects(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "uma@example.com").await;
    let (_device_id, access_token) = register_device(&server, "uma@example.com", "Laptop").await;

    let plaintext_op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1); // encryptionVersion: 0
    let mut encrypted_op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 2, 2);
    encrypted_op["encryptionVersion"] = json!(1);

    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [plaintext_op, encrypted_op] }))
        .await
        .assert_status_ok();

    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&access_token)
        .await;
    snapshot_res.assert_status_ok();
    let snapshot: serde_json::Value = snapshot_res.json();
    assert_eq!(
        snapshot["encryptionVersion"],
        json!(1),
        "top-level encryptionVersion must be the max across all objects, not the first/last uploaded"
    );

    let objects = snapshot["objects"].as_array().unwrap();
    assert_eq!(objects.len(), 2);
    let per_object_versions: std::collections::BTreeSet<i64> = objects
        .iter()
        .map(|o| o["encryptionVersion"].as_i64().unwrap())
        .collect();
    assert_eq!(
        per_object_versions,
        std::collections::BTreeSet::from([0, 1]),
        "the new top-level field must not overwrite each object's own encryptionVersion"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn extension_storage_entry_set_then_delete_is_accepted(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "frank@example.com").await;
    let (_device_id, access_token) = register_device(&server, "frank@example.com", "Laptop").await;

    // extensionStorageEntry has no "create", so "set" must be able to create
    // the object (docs/protocol.md §6).
    let object_id = Uuid::now_v7();
    let set_op = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 1,
        "lamportTimestamp": 1,
        "objectType": "extensionStorageEntry",
        "objectId": object_id,
        "operationType": "set",
        "encryptionVersion": 0,
        "payload": { "key": "theme", "value": "dark" }
    });
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [set_op] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["accepted"].as_array().unwrap().len(), 1);
    assert!(body["rejected"].as_array().unwrap().is_empty());

    let delete_op = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 2,
        "lamportTimestamp": 2,
        "objectType": "extensionStorageEntry",
        "objectId": object_id,
        "operationType": "delete",
        "encryptionVersion": 0,
        "payload": {}
    });
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [delete_op] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["accepted"].as_array().unwrap().len(), 1);
    assert!(body["rejected"].as_array().unwrap().is_empty());
}

#[sqlx::test(migrations = "./migrations")]
async fn extension_meta_observe_is_accepted(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "grace@example.com").await;
    let (_device_id, access_token) = register_device(&server, "grace@example.com", "Laptop").await;

    // extensionMeta only has "observe", so it must be able to create the object.
    let observe_op = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 1,
        "lamportTimestamp": 1,
        "objectType": "extensionMeta",
        "objectId": Uuid::now_v7(),
        "operationType": "observe",
        "encryptionVersion": 0,
        "payload": { "extensionVersion": "1.2.3" }
    });
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [observe_op] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["accepted"].as_array().unwrap().len(), 1);
    assert!(body["rejected"].as_array().unwrap().is_empty());
}

#[sqlx::test(migrations = "./migrations")]
async fn snapshot_merges_concurrent_field_updates_independently(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "heidi@example.com").await;
    let (_device_a, token_a) = register_device(&server, "heidi@example.com", "Laptop").await;
    let (_device_b, token_b) = register_device(&server, "heidi@example.com", "Phone").await;

    let object_id = Uuid::now_v7();
    let create_op = sample_bookmark_op(Uuid::now_v7(), object_id, 1, 1);
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_a)
        .json(&json!({ "operations": [create_op] }))
        .await
        .assert_status_ok();

    // Two devices update different fields at the same Lamport time: A the
    // title, B the url. Both changes must survive (docs/protocol.md §8.2).
    let title_update = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 2,
        "lamportTimestamp": 2,
        "objectType": "bookmark",
        "objectId": object_id,
        "operationType": "update",
        "encryptionVersion": 0,
        "payload": { "title": "Updated Title" }
    });
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_a)
        .json(&json!({ "operations": [title_update] }))
        .await
        .assert_status_ok();

    let url_update = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 1,
        "lamportTimestamp": 2,
        "objectType": "bookmark",
        "objectId": object_id,
        "operationType": "update",
        "encryptionVersion": 0,
        "payload": { "url": "https://updated.example.com" }
    });
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_b)
        .json(&json!({ "operations": [url_update] }))
        .await
        .assert_status_ok();

    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&token_a)
        .await;
    snapshot_res.assert_status_ok();
    let snapshot: serde_json::Value = snapshot_res.json();
    let objects = snapshot["objects"].as_array().unwrap();
    assert_eq!(objects.len(), 1);
    let merged = &objects[0]["payload"];
    assert_eq!(merged["title"], json!("Updated Title"));
    assert_eq!(merged["url"], json!("https://updated.example.com"));
    // Neither update moved it, so parent/position stay from the create.
    assert_eq!(merged["position"], json!("a0"));
}

/// Merging bookmark fields must keep other fields (like `dateAdded`).
#[sqlx::test(migrations = "./migrations")]
async fn snapshot_merge_preserves_fields_outside_field_merge(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "ivan@example.com").await;
    let (_device_a, token_a) = register_device(&server, "ivan@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    let create_op = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 1,
        "lamportTimestamp": 1,
        "objectType": "bookmark",
        "objectId": object_id,
        "operationType": "create",
        "encryptionVersion": 0,
        "payload": {
            "title": "Example",
            "url": "https://example.com",
            "parent": null,
            "position": "a0",
            "dateAdded": 1_700_000_000_000i64,
            "tags": ["reference"]
        }
    });
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_a)
        .json(&json!({ "operations": [create_op] }))
        .await
        .assert_status_ok();

    // A later title-only update still carries `dateAdded`/`tags` (the
    // extension sends full state). Those fields must survive.
    let title_update = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 2,
        "lamportTimestamp": 2,
        "objectType": "bookmark",
        "objectId": object_id,
        "operationType": "update",
        "encryptionVersion": 0,
        "payload": {
            "title": "Renamed",
            "url": "https://example.com",
            "parent": null,
            "position": "a0",
            "dateAdded": 1_700_000_000_000i64,
            "tags": ["reference", "updated"]
        }
    });
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_a)
        .json(&json!({ "operations": [title_update] }))
        .await
        .assert_status_ok();

    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&token_a)
        .await;
    snapshot_res.assert_status_ok();
    let snapshot: serde_json::Value = snapshot_res.json();
    let objects = snapshot["objects"].as_array().unwrap();
    assert_eq!(objects.len(), 1);
    let merged = &objects[0]["payload"];
    assert_eq!(merged["title"], json!("Renamed"));
    assert_eq!(merged["url"], json!("https://example.com"));
    // Fields that aren't merged must not be dropped.
    assert_eq!(merged["dateAdded"], json!(1_700_000_000_000i64));
    assert_eq!(merged["tags"], json!(["reference", "updated"]));
}

#[sqlx::test(migrations = "./migrations")]
async fn revoked_device_is_rejected(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "frank@example.com").await;
    let (device_id, access_token) = register_device(&server, "frank@example.com", "Laptop").await;

    // Revoke the device in the DB (like the web UI does).
    sqlx::query("UPDATE devices SET revoked_at = now() WHERE id = $1::uuid")
        .bind(&device_id)
        .execute(&pool)
        .await
        .unwrap();

    let op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await;
    res.assert_status_unauthorized();
}

#[sqlx::test(migrations = "./migrations")]
async fn upload_from_too_old_protocol_version_is_rejected(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "grace@example.com").await;
    let (_device_id, access_token) = register_device(&server, "grace@example.com", "Laptop").await;

    let op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .add_header("x-protocol-version", "0")
        .json(&json!({ "operations": [op] }))
        .await;
    res.assert_status(axum::http::StatusCode::UPGRADE_REQUIRED);
}

// Batch tests: cases that only happen with several ops in one request.

#[sqlx::test(migrations = "./migrations")]
async fn batch_upload_resolves_ownership_for_object_created_earlier_in_same_batch(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "ivan@example.com").await;
    let (_device_id, access_token) = register_device(&server, "ivan@example.com", "Laptop").await;

    // A create and an update for the same object in one request. The
    // update's ownership check must see the earlier create.
    let object_id = Uuid::now_v7();
    let create_op = sample_bookmark_op(Uuid::now_v7(), object_id, 1, 1);
    let update_op = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 2,
        "lamportTimestamp": 2,
        "objectType": "bookmark",
        "objectId": object_id,
        "operationType": "update",
        "encryptionVersion": 0,
        "payload": { "title": "Renamed in same batch" }
    });

    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [create_op, update_op] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["accepted"].as_array().unwrap().len(), 2);
    assert!(body["rejected"].as_array().unwrap().is_empty());

    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&access_token)
        .await;
    let snapshot: serde_json::Value = snapshot_res.json();
    let objects = snapshot["objects"].as_array().unwrap();
    assert_eq!(objects.len(), 1);
    assert_eq!(
        objects[0]["payload"]["title"],
        json!("Renamed in same batch")
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn batch_upload_returns_mixed_accepted_duplicate_and_rejected(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "judy@example.com").await;
    let (_device_id, access_token) = register_device(&server, "judy@example.com", "Laptop").await;

    let already_uploaded_id = Uuid::now_v7();
    let first = sample_bookmark_op(already_uploaded_id, Uuid::now_v7(), 1, 1);
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [first.clone()] }))
        .await
        .assert_status_ok();

    let new_valid = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 2, 2);
    let mut invalid = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 3, 3);
    invalid["objectType"] = json!("not_a_real_type");

    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [first, new_valid, invalid] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["duplicate"].as_array().unwrap().len(), 1);
    assert_eq!(body["accepted"].as_array().unwrap().len(), 1);
    let rejected = body["rejected"].as_array().unwrap();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0]["reason"], "unknown_object_type");
}

#[sqlx::test(migrations = "./migrations")]
async fn batch_upload_rejects_payload_too_large(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "oversize@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "oversize@example.com", "Laptop").await;

    let mut oversize_op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    // MAX_PAYLOAD_BYTES is 256 * 1024 = 262144 bytes.
    let big_string = "a".repeat(256 * 1024 + 1);
    oversize_op["payload"] = json!({ "content": big_string });

    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [oversize_op] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["accepted"].as_array().unwrap().len(), 0);
    let rejected = body["rejected"].as_array().unwrap();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0]["reason"], "payload_too_large");
}

/// Many concurrent uploads from one device, with a small pool, must finish
/// quickly without starving another user's request.
#[sqlx::test(migrations = "./migrations")]
async fn concurrent_uploads_from_one_device_do_not_starve_other_requests(pool: PgPool) {
    const POOL_SIZE: u32 = 3;
    let small_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(POOL_SIZE)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();

    let server = server_for_state(state_for_config(small_pool, test_config()));

    register_and_login(&server, "flood-a@example.com").await;
    let (_device_a, token_a) = register_device(&server, "flood-a@example.com", "Laptop").await;

    register_and_login(&server, "flood-b@example.com").await;
    let (_device_b, token_b) = register_device(&server, "flood-b@example.com", "Phone").await;

    // More concurrent same-device uploads than the pool has connections.
    let concurrent_uploads = POOL_SIZE as i64 * 3;
    let flood_futures = (1..=concurrent_uploads).map(|seq| {
        let op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), seq, seq);
        let req = server
            .post("/api/v1/sync/operations")
            .authorization_bearer(&token_a)
            .json(&json!({ "operations": [op] }));
        async move { req.await }
    });

    let other_op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    let other_req = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_b)
        .json(&json!({ "operations": [other_op] }));
    let other_request = async move { other_req.await };

    let (flood_results, other_result) = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        futures::future::join(futures::future::join_all(flood_futures), other_request),
    )
    .await
    .expect(
        "device A's concurrent uploads must not starve user B's unrelated request of a pool connection",
    );

    for res in &flood_results {
        res.assert_status_ok();
    }
    other_result.assert_status_ok();
}

/// Waiting for the per-device upload lock must time out. Holds the lock for
/// the whole test; a second upload must get `503 busy` after about 1s.
#[sqlx::test(migrations = "./migrations")]
async fn upload_semaphore_acquire_timeout_rejects_busy_request(pool: PgPool) {
    let config = Config {
        upload_semaphore_acquire_timeout_secs: 1,
        // Above the 1s acquire timeout, so the route timeout isn't what fires.
        request_timeout_secs: 30,
        ..test_config()
    };
    let state = state_for_config(pool, config);
    let server = server_for_state(state.clone());

    register_and_login(&server, "busy@example.com").await;
    let (device_id, access_token) = register_device(&server, "busy@example.com", "Laptop").await;
    let device_uuid: Uuid = device_id.parse().unwrap();

    // Pretend another upload holds the device's lock.
    let held_semaphore = Arc::new(tokio::sync::Semaphore::new(1));
    let _held_permit = held_semaphore.clone().try_acquire_owned().unwrap();
    state.upload_locks.insert(device_uuid, held_semaphore);

    let op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    let started = std::time::Instant::now();
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await;
    let elapsed = started.elapsed();

    res.assert_status(axum::http::StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = res.json();
    assert_eq!(body["error"], "busy");

    // Rejected after about 1s, not hanging.
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "expected rejection near the 1s acquire timeout, took {elapsed:?}"
    );
}

/// The route-level timeout must cut off a slow request. Same setup as
/// above, but the acquire timeout is much longer, so the route timeout
/// fires first.
#[sqlx::test(migrations = "./migrations")]
async fn route_level_timeout_cuts_off_a_slow_request(pool: PgPool) {
    let config = Config {
        // Much longer than the route timeout.
        upload_semaphore_acquire_timeout_secs: 60,
        request_timeout_secs: 1,
        ..test_config()
    };
    let state = state_for_config(pool, config);
    let server = server_for_state(state.clone());

    register_and_login(&server, "slow@example.com").await;
    let (device_id, access_token) = register_device(&server, "slow@example.com", "Laptop").await;
    let device_uuid: Uuid = device_id.parse().unwrap();

    let held_semaphore = Arc::new(tokio::sync::Semaphore::new(1));
    let _held_permit = held_semaphore.clone().try_acquire_owned().unwrap();
    state.upload_locks.insert(device_uuid, held_semaphore);

    let op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    let started = std::time::Instant::now();
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await;
    let elapsed = started.elapsed();

    res.assert_status(axum::http::StatusCode::REQUEST_TIMEOUT);

    // Cut off after about 1s, not 60s.
    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "expected the route-level timeout (~1s) to fire, not the 60s acquire timeout; took {elapsed:?}"
    );
}

fn history_visit_op(op_id: Uuid, object_id: Uuid, seq: i64, url: &str) -> serde_json::Value {
    json!({
        "operationId": op_id,
        "deviceSequence": seq,
        "lamportTimestamp": seq,
        "objectType": "historyVisit",
        "objectId": object_id,
        "operationType": "visit",
        "encryptionVersion": 0,
        "payload": { "url": url, "title": "Example", "visitedAt": "2026-01-01T00:00:00.000Z" }
    })
}

/// `history_retention` is applied in `/snapshot` and `/stats`. Visits are
/// encrypted, so the cutoff uses upload time; the test backdates
/// `created_at` with SQL.
#[sqlx::test(migrations = "./migrations")]
async fn expired_history_visit_is_excluded_from_snapshot_and_stats(pool: PgPool) {
    let state = state_for_config(pool.clone(), test_config());
    let server = server_for_state(state.clone());
    register_and_login(&server, "nora@example.com").await;
    let (_device_id, access_token) = register_device(&server, "nora@example.com", "Laptop").await;

    server
        .patch("/api/v1/sync/settings")
        .authorization_bearer(&access_token)
        .json(&json!({ "historyRetention": "7d" }))
        .await
        .assert_status_ok();

    let old_op_id = Uuid::now_v7();
    let old_object_id = Uuid::now_v7();
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [history_visit_op(old_op_id, old_object_id, 1, "https://old.example.com")] }))
        .await
        .assert_status_ok();

    let recent_object_id = Uuid::now_v7();
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [history_visit_op(Uuid::now_v7(), recent_object_id, 2, "https://recent.example.com")] }))
        .await
        .assert_status_ok();

    // The old visit was uploaded 10 days ago, outside the 7-day window.
    sqlx::query("UPDATE sync_operations SET created_at = now() - interval '10 days' WHERE operation_id = $1::uuid")
        .bind(old_op_id)
        .execute(&pool)
        .await
        .unwrap();

    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&access_token)
        .await;
    snapshot_res.assert_status_ok();
    let snapshot: serde_json::Value = snapshot_res.json();
    let objects = snapshot["objects"].as_array().unwrap();
    assert_eq!(
        objects.len(),
        1,
        "expired visit must not appear in the snapshot: {objects:?}"
    );
    assert_eq!(objects[0]["objectId"], json!(recent_object_id));

    // `sync_stats` only changes on uploads, so right after the backdate it
    // still counts the expired visit. Checked in the table directly, since
    // `/stats` would just hit its 30s cache.
    let user_id = user_id_for_email(&pool, "nora@example.com").await;
    let (_, history_visits_before_compaction, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(
        history_visits_before_compaction, 2,
        "incremental sync_stats has no retention-decay signal, so it still counts the not-yet-reconciled expired visit"
    );

    // Compaction recounts from the retention-filtered objects. Ack first so
    // it covers both ops.
    sync_device(&server, &access_token).await;
    compaction::run_once(&state).await.unwrap();

    // Checked against the `sync_stats` table directly, not `/stats`'s JSON
    // response: `/stats` now answers from `history_visit_hours` (Change 3,
    // docs/protocol.md §8.3.2), which this test's manual `UPDATE
    // sync_operations SET created_at = ...` above never touches — that
    // bucket was already written, at real upload time, before this test
    // artificially backdated `created_at` to simulate an old visit. This is
    // exactly the upload-time-vs-visit-time gap Change 3 exists to close;
    // `visit_hours_accepted_ops_respect_retention_window` above is the test
    // that exercises retention exclusion the way it now actually happens
    // (via real visit-hour buckets, not backdated upload time). What this
    // assertion still correctly verifies is that `compact_user`'s
    // authoritative recount of the legacy `history_visit_count` column
    // (kept, but no longer read by `/stats`) is unaffected by Change 3.
    let (_, history_visits_after_compaction, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(
        history_visits_after_compaction, 1,
        "compaction must reconcile the legacy history_visit_count column to exclude the expired visit"
    );
}

/// With "unlimited" retention, the old visit is still served.
#[sqlx::test(migrations = "./migrations")]
async fn unlimited_history_retention_keeps_old_visits(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "olga@example.com").await;
    let (_device_id, access_token) = register_device(&server, "olga@example.com", "Laptop").await;

    server
        .patch("/api/v1/sync/settings")
        .authorization_bearer(&access_token)
        .json(&json!({ "historyRetention": "unlimited" }))
        .await
        .assert_status_ok();

    let old_op_id = Uuid::now_v7();
    let old_object_id = Uuid::now_v7();
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [history_visit_op(old_op_id, old_object_id, 1, "https://very-old.example.com")] }))
        .await
        .assert_status_ok();

    sqlx::query("UPDATE sync_operations SET created_at = now() - interval '400 days' WHERE operation_id = $1::uuid")
        .bind(old_op_id)
        .execute(&pool)
        .await
        .unwrap();

    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&access_token)
        .await;
    snapshot_res.assert_status_ok();
    let snapshot: serde_json::Value = snapshot_res.json();
    let objects = snapshot["objects"].as_array().unwrap();
    assert_eq!(objects.len(), 1);
    assert_eq!(objects[0]["objectId"], json!(old_object_id));
}

/// Settings requests are rate-limited per device, so two devices of one
/// user each get their own quota.
#[sqlx::test(migrations = "./migrations")]
async fn sync_settings_rate_limit_is_independent_per_device(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "priya-two-devices@example.com").await;
    let (_device_a_id, access_token_a) =
        register_device(&server, "priya-two-devices@example.com", "Laptop").await;
    let (_device_b_id, access_token_b) =
        register_device(&server, "priya-two-devices@example.com", "Phone").await;

    // 59 each, just under the limit of 60. A shared bucket would fail
    // partway through device B.
    let requests_per_device = SYNC_SETTINGS_LIMIT.limit - 1;

    for _ in 0..requests_per_device {
        server
            .get("/api/v1/sync/settings")
            .authorization_bearer(&access_token_a)
            .await
            .assert_status_ok();
    }

    for _ in 0..requests_per_device {
        server
            .get("/api/v1/sync/settings")
            .authorization_bearer(&access_token_b)
            .await
            .assert_status_ok();
    }
}

/// `/api/v1/sync/stats` is rate-limited per device, so maxing out device A
/// doesn't block device B.
#[sqlx::test(migrations = "./migrations")]
async fn sync_stats_rate_limit_is_independent_per_device(pool: PgPool) {
    let rate_limiter = Arc::new(RateLimiter::new());
    let state = AppState {
        db: pool,
        config: Arc::new(test_config()),
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
    let server = server_for_state(state);
    register_and_login(&server, "priya-two-devices-stats@example.com").await;
    let (device_a_id, access_token_a) =
        register_device(&server, "priya-two-devices-stats@example.com", "Laptop").await;
    let (_device_b_id, access_token_b) =
        register_device(&server, "priya-two-devices-stats@example.com", "Phone").await;

    // Use up device A's quota.
    for _ in 0..SYNC_STATS_LIMIT.limit {
        helixsync_server::middleware::rate_limit::enforce(
            &rate_limiter,
            SYNC_STATS_LIMIT,
            &format!("device:{device_a_id}"),
        )
        .unwrap();
    }

    // Device A has exhausted its limit and must receive HTTP 429.
    server
        .get("/api/v1/sync/stats")
        .authorization_bearer(&access_token_a)
        .await
        .assert_status(axum::http::StatusCode::TOO_MANY_REQUESTS);

    // Device B belongs to the same user account but has its own independent rate limit,
    // so it must not be blocked and receives HTTP 200.
    let requests_per_device = SYNC_STATS_LIMIT.limit - 1;
    for _ in 0..requests_per_device {
        server
            .get("/api/v1/sync/stats")
            .authorization_bearer(&access_token_b)
            .await
            .assert_status_ok();
    }
}

#[sqlx::test(migrations = "./migrations")]
async fn batch_upload_dedupes_tombstone_writes_for_same_object(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "mallory@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "mallory@example.com", "Laptop").await;

    // Create, then two deletes for the same object in one batch (e.g. a
    // resent delete after a dropped response, now arriving alongside a
    // fresh one under a new operationId). Both deletes target the same
    // tombstone row, which a single bulk INSERT ... ON CONFLICT cannot
    // update twice from its own VALUES — process_batch must dedupe before
    // writing, keeping the higher-cursor (later) one.
    let object_id = Uuid::now_v7();
    let create_op = sample_bookmark_op(Uuid::now_v7(), object_id, 1, 1);
    let delete_op_a = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 2,
        "lamportTimestamp": 2,
        "objectType": "bookmark",
        "objectId": object_id,
        "operationType": "delete",
        "encryptionVersion": 0,
        "payload": {}
    });
    let delete_op_b = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 3,
        "lamportTimestamp": 3,
        "objectType": "bookmark",
        "objectId": object_id,
        "operationType": "delete",
        "encryptionVersion": 0,
        "payload": {}
    });

    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [create_op, delete_op_a, delete_op_b] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["accepted"].as_array().unwrap().len(), 3);

    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&access_token)
        .await;
    let snapshot: serde_json::Value = snapshot_res.json();
    assert!(snapshot["objects"].as_array().unwrap().is_empty());
    let tombstones = snapshot["tombstones"].as_array().unwrap();
    assert_eq!(tombstones.len(), 1);
    assert_eq!(tombstones[0]["objectId"], json!(object_id));
}

/// Regression test for the `sync_objects` unbounded-growth bug
/// (SERVER_AUDIT.md, "`sync_objects` accumulates one never-read row per
/// history visit, forever"): a single-visit `historyVisit`/`visit` op has no
/// non-origination op that ever depends on a ledger row for it (unlike
/// `bulkImport`, which now gets one for the permanent-dedup fix — see
/// `bulk_reupload_after_compaction_is_duplicate` and the ledger-insert
/// filter's comment in `sync::routes::process_batch`), so writing one to
/// that never-pruned ledger (`migrations/0006_sync_objects.sql`) would be
/// permanent and structurally dead. `process_batch` must skip writing it for
/// `visit`, while still writing it for object types that *do* have a later
/// non-origination op depending on it (e.g. bookmark's `update`/`delete`).
#[sqlx::test(migrations = "./migrations")]
async fn history_visit_does_not_grow_sync_objects_ledger(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "nadia@example.com").await;
    let (_device_id, access_token) = register_device(&server, "nadia@example.com", "Laptop").await;

    let visit_op = history_visit_op(Uuid::now_v7(), Uuid::now_v7(), 1, "https://example.com");
    let bookmark_op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 2, 2);
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [visit_op, bookmark_op] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["accepted"].as_array().unwrap().len(), 2);
    assert!(body["rejected"].as_array().unwrap().is_empty());

    let user_id = user_id_for_email(&pool, "nadia@example.com").await;
    let ledger_types: Vec<String> = sqlx::query_scalar!(
        "SELECT object_type FROM sync_objects WHERE user_id = $1 ORDER BY object_type",
        user_id
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        ledger_types,
        vec!["bookmark".to_string()],
        "historyVisit must not get a sync_objects row (structurally unread), \
         while bookmark — which has non-origination update/delete ops that \
         depend on the ledger — must still get one"
    );
}

// --- sync_stats tests (migrations/0007_sync_stats.sql) ---
//
// - Upload deltas: `stats_reflects_counts_across_batches`,
//   `stats_nets_out_same_batch_create_then_delete`,
//   `stats_decreases_when_object_deleted_in_later_batch`.
// - Compaction recount: `compaction_reconciles_stats_after_snapshot`.

async fn user_id_for_email(pool: &PgPool, email: &str) -> Uuid {
    sqlx::query_scalar!("SELECT id FROM users WHERE email = $1", email)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Reads `sync_stats` directly, skipping the 30s `/stats` cache. A missing
/// row reads as zeros.
async fn sync_stats_row(pool: &PgPool, user_id: Uuid) -> (i64, i64, i64) {
    sqlx::query!(
        "SELECT bookmark_count, history_visit_count, tab_count FROM sync_stats WHERE user_id = $1",
        user_id
    )
    .fetch_optional(pool)
    .await
    .unwrap()
    .map(|r| (r.bookmark_count, r.history_visit_count, r.tab_count))
    .unwrap_or((0, 0, 0))
}

/// Builds an op with an empty payload; only the types matter for stats tests.
fn make_op(
    object_type: &str,
    operation_type: &str,
    op_id: Uuid,
    object_id: Uuid,
    seq: i64,
    lamport: i64,
) -> serde_json::Value {
    json!({
        "operationId": op_id,
        "deviceSequence": seq,
        "lamportTimestamp": lamport,
        "objectType": object_type,
        "objectId": object_id,
        "operationType": operation_type,
        "encryptionVersion": 0,
        "payload": {}
    })
}

/// Downloads twice so the server records the ack (docs/protocol.md §4.4),
/// like `sync_device` in `compaction_flow.rs`.
async fn sync_device(server: &TestServer, token: &str) {
    let res = server
        .get("/api/v1/sync/changes?cursor=0")
        .authorization_bearer(token)
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let next_cursor = body["nextCursor"].as_i64().unwrap();
    server
        .get(&format!("/api/v1/sync/changes?cursor={next_cursor}"))
        .authorization_bearer(token)
        .await
        .assert_status_ok();
}

/// Bookmarks, a history visit, and a tab from two batches all show in `/stats`.
#[sqlx::test(migrations = "./migrations")]
async fn stats_reflects_counts_across_batches(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "priya@example.com").await;
    let (_device_id, access_token) = register_device(&server, "priya@example.com", "Laptop").await;

    let bookmark_a = Uuid::now_v7();
    let bookmark_b = Uuid::now_v7();
    let visit_a = Uuid::now_v7();
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [
            make_op("bookmark", "create", Uuid::now_v7(), bookmark_a, 1, 1),
            make_op("bookmark", "create", Uuid::now_v7(), bookmark_b, 2, 2),
            make_op("historyVisit", "visit", Uuid::now_v7(), visit_a, 3, 3),
        ] }))
        .await
        .assert_status_ok();

    // Second batch, to test counts adding up across batches.
    let tab_a = Uuid::now_v7();
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [
            make_op("tab", "create", Uuid::now_v7(), tab_a, 4, 4),
        ] }))
        .await
        .assert_status_ok();

    let stats_res = server
        .get("/api/v1/sync/stats")
        .authorization_bearer(&access_token)
        .await;
    stats_res.assert_status_ok();
    let stats: serde_json::Value = stats_res.json();
    assert_eq!(stats["bookmarks"], json!(2));
    assert_eq!(stats["historyVisits"], json!(1));
    assert_eq!(stats["tabs"], json!(1));
}

/// A bookmark created and deleted in the same batch nets to zero.
#[sqlx::test(migrations = "./migrations")]
async fn stats_nets_out_same_batch_create_then_delete(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "quinn@example.com").await;
    let (_device_id, access_token) = register_device(&server, "quinn@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [
            make_op("bookmark", "create", Uuid::now_v7(), object_id, 1, 1),
            make_op("bookmark", "delete", Uuid::now_v7(), object_id, 2, 2),
        ] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["accepted"].as_array().unwrap().len(), 2);

    let user_id = user_id_for_email(&pool, "quinn@example.com").await;
    let (bookmarks, _, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(
        bookmarks, 0,
        "create+delete in the same batch must net to zero, not undercount/overcount"
    );

    let stats_res = server
        .get("/api/v1/sync/stats")
        .authorization_bearer(&access_token)
        .await;
    stats_res.assert_status_ok();
    let stats: serde_json::Value = stats_res.json();
    assert_eq!(stats["bookmarks"], json!(0));
}

/// An object created in one batch and deleted in a later one lowers the count.
#[sqlx::test(migrations = "./migrations")]
async fn stats_decreases_when_object_deleted_in_later_batch(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "rex@example.com").await;
    let (_device_id, access_token) = register_device(&server, "rex@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [make_op("bookmark", "create", Uuid::now_v7(), object_id, 1, 1)] }))
        .await
        .assert_status_ok();

    let user_id = user_id_for_email(&pool, "rex@example.com").await;
    let (bookmarks_after_create, _, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(
        bookmarks_after_create, 1,
        "creation batch must apply a +1 delta"
    );

    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [make_op("bookmark", "delete", Uuid::now_v7(), object_id, 2, 2)] }))
        .await
        .assert_status_ok();

    let (bookmarks_after_delete, _, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(
        bookmarks_after_delete, 0,
        "a later batch's -1 delta must be applied on top of the earlier +1"
    );
}

/// Compaction overwrites `sync_stats` with the real count. The row is
/// corrupted first to prove it's overwritten.
#[sqlx::test(migrations = "./migrations")]
async fn compaction_reconciles_stats_after_snapshot(pool: PgPool) {
    let state = state_for_config(pool.clone(), test_config());
    let server = server_for_state(state.clone());
    register_and_login(&server, "sana@example.com").await;
    let (_device_id, access_token) = register_device(&server, "sana@example.com", "Laptop").await;

    let bookmark_id = Uuid::now_v7();
    let tab_id = Uuid::now_v7();
    let visit_id = Uuid::now_v7();
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [
            make_op("bookmark", "create", Uuid::now_v7(), bookmark_id, 1, 1),
            make_op("tab", "create", Uuid::now_v7(), tab_id, 2, 2),
            make_op("historyVisit", "visit", Uuid::now_v7(), visit_id, 3, 3),
        ] }))
        .await
        .assert_status_ok();

    // Ack so compaction covers these ops.
    sync_device(&server, &access_token).await;

    let user_id = user_id_for_email(&pool, "sana@example.com").await;

    // Corrupt the counts.
    sqlx::query!(
        "UPDATE sync_stats SET bookmark_count = 999, tab_count = 999, history_visit_count = 999 WHERE user_id = $1",
        user_id
    )
    .execute(&pool)
    .await
    .unwrap();

    compaction::run_once(&state).await.unwrap();

    let (bookmarks, history_visits, tabs) = sync_stats_row(&pool, user_id).await;
    assert_eq!(
        bookmarks, 1,
        "compaction must overwrite the corrupted bookmark_count with the true count"
    );
    assert_eq!(
        history_visits, 1,
        "compaction must overwrite the corrupted history_visit_count with the true count"
    );
    assert_eq!(
        tabs, 1,
        "compaction must overwrite the corrupted tab_count with the true count"
    );

    // `/stats` shows the fixed counts.
    let stats_res = server
        .get("/api/v1/sync/stats")
        .authorization_bearer(&access_token)
        .await;
    stats_res.assert_status_ok();
    let stats: serde_json::Value = stats_res.json();
    assert_eq!(stats["bookmarks"], json!(1));
    assert_eq!(stats["historyVisits"], json!(1));
    assert_eq!(stats["tabs"], json!(1));
}

/// Two devices deleting the same bookmark at once must lower the count by
/// exactly 1, not 2.
#[sqlx::test(migrations = "./migrations")]
async fn concurrent_deletes_of_same_object_decrement_once(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "uzo@example.com").await;
    let (_device_a, token_a) = register_device(&server, "uzo@example.com", "Laptop").await;
    let (_device_b, token_b) = register_device(&server, "uzo@example.com", "Phone").await;

    // A second bookmark, so a double decrement (1 -> 0) can be told apart
    // from a correct one (2 -> 1). With only one, the zero floor hides it.
    let object_id = Uuid::now_v7();
    let untouched_object_id = Uuid::now_v7();
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_a)
        .json(&json!({ "operations": [
            make_op("bookmark", "create", Uuid::now_v7(), object_id, 1, 1),
            make_op("bookmark", "create", Uuid::now_v7(), untouched_object_id, 2, 2),
        ] }))
        .await
        .assert_status_ok();

    let user_id = user_id_for_email(&pool, "uzo@example.com").await;
    let (bookmarks_after_create, _, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(
        bookmarks_after_create, 2,
        "creation batch must apply a +1 delta per created bookmark"
    );

    // Both devices delete the same bookmark concurrently. Each delete is
    // valid on its own.
    let delete_a_req = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_a)
        .json(&json!({ "operations": [make_op("bookmark", "delete", Uuid::now_v7(), object_id, 3, 3)] }));
    let delete_a = async move { delete_a_req.await };
    let delete_b_req = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_b)
        .json(&json!({ "operations": [make_op("bookmark", "delete", Uuid::now_v7(), object_id, 1, 2)] }));
    let delete_b = async move { delete_b_req.await };

    let (res_a, res_b) = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        futures::future::join(delete_a, delete_b),
    )
    .await
    .expect("concurrent deletes from two devices must not deadlock against each other");
    res_a.assert_status_ok();
    res_b.assert_status_ok();

    let (bookmarks_after_deletes, _, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(
        bookmarks_after_deletes, 1,
        "two concurrent deletes of the same object must decrement the count exactly once, not twice \
         (the untouched second bookmark must still be the only one left)"
    );
}

// --- `/changes` must not write (or fail) when the cursor hasn't moved ---

/// Reads `sync_cursors.updated_at` for a device, to prove a write was skipped.
async fn cursor_updated_at(pool: &PgPool, user_id: Uuid, device_id: Uuid) -> DateTime<Utc> {
    sqlx::query_scalar!(
        "SELECT updated_at FROM sync_cursors WHERE user_id = $1 AND device_id = $2",
        user_id,
        device_id
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Idle polls with an unchanged cursor must return 200 and not write
/// (`updated_at` stays the same). A poll with a newer cursor must write.
#[sqlx::test(migrations = "./migrations")]
async fn idle_poll_with_unchanged_cursor_skips_cursor_write(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "tara@example.com").await;
    let (device_id, access_token) = register_device(&server, "tara@example.com", "Laptop").await;
    let device_id = Uuid::parse_str(&device_id).unwrap();

    let op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await
        .assert_status_ok();

    // First download creates the cursor row.
    let download_res = server
        .get("/api/v1/sync/changes?cursor=0")
        .authorization_bearer(&access_token)
        .await;
    download_res.assert_status_ok();
    let body: serde_json::Value = download_res.json();
    let cursor = body["nextCursor"].as_i64().unwrap();

    let user_id = user_id_for_email(&pool, "tara@example.com").await;

    // Same cursor again must still return 200 (not 500).
    let idle_res = server
        .get(&format!("/api/v1/sync/changes?cursor={cursor}"))
        .authorization_bearer(&access_token)
        .await;
    idle_res.assert_status_ok();

    let updated_at_after_first_idle_poll = cursor_updated_at(&pool, user_id, device_id).await;

    // Short wait so two `now()` values can't match by chance.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    // Same cursor again: `updated_at` must not change.
    let idle_res2 = server
        .get(&format!("/api/v1/sync/changes?cursor={cursor}"))
        .authorization_bearer(&access_token)
        .await;
    idle_res2.assert_status_ok();
    let updated_at_after_second_idle_poll = cursor_updated_at(&pool, user_id, device_id).await;
    assert_eq!(
        updated_at_after_first_idle_poll, updated_at_after_second_idle_poll,
        "an idle poll with an unchanged cursor must not touch sync_cursors.updated_at"
    );

    // Upload a new op and poll again: now `updated_at` must change.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let op2 = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 2, 2);
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op2] }))
        .await
        .assert_status_ok();

    // The saved cursor is the one the request sends, not the response's
    // `nextCursor`. So fetch with the old cursor, then send the new one.
    let advancing_res = server
        .get(&format!("/api/v1/sync/changes?cursor={cursor}"))
        .authorization_bearer(&access_token)
        .await;
    advancing_res.assert_status_ok();
    let advancing_body: serde_json::Value = advancing_res.json();
    let new_cursor = advancing_body["nextCursor"].as_i64().unwrap();
    assert!(
        new_cursor > cursor,
        "the second upload must advance the cursor"
    );

    let ack_res = server
        .get(&format!("/api/v1/sync/changes?cursor={new_cursor}"))
        .authorization_bearer(&access_token)
        .await;
    ack_res.assert_status_ok();

    let updated_at_after_real_advance = cursor_updated_at(&pool, user_id, device_id).await;
    assert!(
        updated_at_after_real_advance > updated_at_after_second_idle_poll,
        "a poll that actually acks a higher cursor must update sync_cursors.updated_at"
    );
}

// --- History import (historyVisit / bulkImport, docs/protocol.md §8.3) ---

/// Builds one bulkImport op with `visit_count` visits. The payload is a
/// minimal placeholder.
fn bulk_history_op(
    op_id: Uuid,
    object_id: Uuid,
    seq: i64,
    visit_count: Option<i64>,
) -> serde_json::Value {
    let mut op = json!({
        "operationId": op_id,
        "deviceSequence": seq,
        "lamportTimestamp": seq,
        "objectType": "historyVisit",
        "objectId": object_id,
        "operationType": "bulkImport",
        "encryptionVersion": 0,
        "payload": { "v": 1, "bulkVersion": 1, "visitCount": visit_count, "segments": [] },
        "visitCount": visit_count
    });
    // The server reads the top-level `visitCount`, not the payload's copy.
    // `None` leaves the field out (not `null`).
    if visit_count.is_none() {
        op.as_object_mut().unwrap().remove("visitCount");
    }
    op
}

/// bulkImport needs visitCount >= 1; other ops may not set it.
#[sqlx::test(migrations = "./migrations")]
async fn bulk_upload_validation_rejects_missing_and_unexpected_visit_count(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "bulk-validation@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "bulk-validation@example.com", "Laptop").await;

    // bulkImport without visitCount → rejected.
    let missing = bulk_history_op(Uuid::now_v7(), Uuid::now_v7(), 1, None);
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [missing] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(body["accepted"].as_array().unwrap().is_empty());
    assert_eq!(
        body["rejected"].as_array().unwrap()[0]["reason"],
        json!("bulk_import_missing_count")
    );

    // bulkImport with visitCount 0 → rejected (requires >= 1).
    let zero = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 1,
        "lamportTimestamp": 1,
        "objectType": "historyVisit",
        "objectId": Uuid::now_v7(),
        "operationType": "bulkImport",
        "encryptionVersion": 0,
        "payload": { "v": 1, "bulkVersion": 1, "visitCount": 0, "segments": [] },
        "visitCount": 0
    });
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [zero] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(
        body["rejected"].as_array().unwrap()[0]["reason"],
        json!("bulk_import_missing_count")
    );

    // Non-bulk historyVisit carrying visitCount → rejected.
    let mut smuggled = history_visit_op(Uuid::now_v7(), Uuid::now_v7(), 1, "https://x.example.com");
    smuggled["visitCount"] = json!(5);
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [smuggled] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(
        body["rejected"].as_array().unwrap()[0]["reason"],
        json!("unexpected_visit_count")
    );

    // Non-bulk bookmark carrying visitCount → rejected.
    let mut bookmark_smuggled = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    bookmark_smuggled["visitCount"] = json!(5);
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [bookmark_smuggled] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(
        body["rejected"].as_array().unwrap()[0]["reason"],
        json!("unexpected_visit_count")
    );

    // Valid bulkImport → accepted, one op, one cursor.
    let valid = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 1,
        "lamportTimestamp": 1,
        "objectType": "historyVisit",
        "objectId": Uuid::now_v7(),
        "operationType": "bulkImport",
        "encryptionVersion": 0,
        "payload": { "v": 1, "bulkVersion": 1, "visitCount": 3, "segments": [] },
        "visitCount": 3
    });
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [valid] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["accepted"].as_array().unwrap().len(), 1);
}

/// `visitCount` above `MAX_VISIT_COUNT_PER_OP` (1,000,000) is rejected as
/// `visit_count_too_large`. Exactly at the limit is accepted.
#[sqlx::test(migrations = "./migrations")]
async fn bulk_upload_rejects_visit_count_above_ceiling(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "bulk-ceiling@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "bulk-ceiling@example.com", "Laptop").await;

    let too_many = bulk_history_op(Uuid::now_v7(), Uuid::now_v7(), 1, Some(1_000_001));
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [too_many] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(body["accepted"].as_array().unwrap().is_empty());
    assert_eq!(
        body["rejected"].as_array().unwrap()[0]["reason"],
        json!("visit_count_too_large")
    );

    let at_ceiling = bulk_history_op(Uuid::now_v7(), Uuid::now_v7(), 2, Some(1_000_000));
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [at_ceiling] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(
        body["accepted"].as_array().unwrap().len(),
        1,
        "exactly at the ceiling must still be accepted"
    );
}

/// `/changes` caps a page by payload bytes (16MB). Three ~7MB ops don't fit
/// in one page; the first page has `hasMore: true` and the next has the rest.
#[sqlx::test(migrations = "./migrations")]
async fn download_caps_page_by_byte_budget_not_just_row_count(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "byte-budget@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "byte-budget@example.com", "Laptop").await;

    // ~7MB each: 2 fit under 16MB, 3 don't.
    let big_blob = "x".repeat(7 * 1024 * 1024);
    let mut ops = Vec::new();
    for seq in 1..=3i64 {
        ops.push(json!({
            "operationId": Uuid::now_v7(),
            "deviceSequence": seq,
            "lamportTimestamp": seq,
            "objectType": "historyVisit",
            "objectId": Uuid::now_v7(),
            "operationType": "bulkImport",
            "encryptionVersion": 0,
            "payload": { "v": 1, "bulkVersion": 1, "visitCount": 1, "blob": big_blob },
            "visitCount": 1
        }));
    }
    let upload_res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": ops }))
        .await;
    upload_res.assert_status_ok();
    let upload_body: serde_json::Value = upload_res.json();
    assert_eq!(upload_body["accepted"].as_array().unwrap().len(), 3);

    let page1 = server
        .get("/api/v1/sync/changes?cursor=0")
        .authorization_bearer(&access_token)
        .await;
    page1.assert_status_ok();
    let page1_body: serde_json::Value = page1.json();
    let page1_ops = page1_body["operations"].as_array().unwrap();
    assert!(
        page1_ops.len() < 3,
        "byte budget should stop the page short of all 3 large ops, got {}",
        page1_ops.len()
    );
    assert!(
        !page1_ops.is_empty(),
        "byte budget must still return at least one row, never zero"
    );
    assert_eq!(page1_body["hasMore"], json!(true));

    // The rest comes from `nextCursor`.
    let next_cursor = page1_body["nextCursor"].as_i64().unwrap();
    let page2 = server
        .get(&format!("/api/v1/sync/changes?cursor={next_cursor}"))
        .authorization_bearer(&access_token)
        .await;
    page2.assert_status_ok();
    let page2_body: serde_json::Value = page2.json();
    let page2_ops = page2_body["operations"].as_array().unwrap();
    assert_eq!(page1_ops.len() + page2_ops.len(), 3);
    assert_eq!(page2_body["hasMore"], json!(false));
}

/// With the counter already at `i32::MAX`, another bulk import still works
/// and the count goes past it (columns are BIGINT, migration 0014).
#[sqlx::test(migrations = "./migrations")]
async fn bulk_upload_does_not_overflow_sync_stats_past_i32_max(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "overflow-guard@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "overflow-guard@example.com", "Laptop").await;
    let user_id = user_id_for_email(&pool, "overflow-guard@example.com").await;

    sqlx::query!(
        "INSERT INTO sync_stats (user_id, bookmark_count, history_visit_count, tab_count) VALUES ($1, 0, $2, 0)",
        user_id,
        i32::MAX as i64
    )
    .execute(&pool)
    .await
    .unwrap();

    let op = bulk_history_op(Uuid::now_v7(), Uuid::now_v7(), 1, Some(1_000_000));
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(
        body["accepted"].as_array().unwrap().len(),
        1,
        "a batch must not 500 just because the account's counter already sits at i32::MAX"
    );

    let (_, history_visits, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(
        history_visits,
        i32::MAX as i64 + 1_000_000,
        "the counter must sum past i32::MAX, not overflow, roll back, or silently stick"
    );
}

/// A first batch whose net change is negative must save zero, not a
/// negative count.
#[sqlx::test(migrations = "./migrations")]
async fn negative_delta_on_fresh_account_clamps_to_zero(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "negative-seed@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "negative-seed@example.com", "Laptop").await;
    let user_id = user_id_for_email(&pool, "negative-seed@example.com").await;

    // Bookmarks the account already owns, added to `sync_objects` directly,
    // so there's no `sync_stats` row yet.
    let object_ids: Vec<Uuid> = (0..5).map(|_| Uuid::now_v7()).collect();
    for object_id in &object_ids {
        sqlx::query!(
            "INSERT INTO sync_objects (user_id, object_type, object_id) VALUES ($1, 'bookmark', $2)",
            user_id,
            object_id
        )
        .execute(&pool)
        .await
        .unwrap();
    }

    let ops: Vec<serde_json::Value> = object_ids
        .iter()
        .enumerate()
        .map(|(i, object_id)| {
            make_op(
                "bookmark",
                "delete",
                Uuid::now_v7(),
                *object_id,
                1 + i as i64,
                1 + i as i64,
            )
        })
        .collect();
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": ops }))
        .await
        .assert_status_ok();

    let (bookmarks, _, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(
        bookmarks, 0,
        "a negative net delta on a fresh row must clamp to zero, not go negative"
    );
}

/// One bulk op with visitCount N adds N (not 1) to the count.
#[sqlx::test(migrations = "./migrations")]
async fn bulk_upload_counts_n_visits_in_stats(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "bulk-counts@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "bulk-counts@example.com", "Laptop").await;

    let op = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 1,
        "lamportTimestamp": 1,
        "objectType": "historyVisit",
        "objectId": Uuid::now_v7(),
        "operationType": "bulkImport",
        "encryptionVersion": 0,
        "payload": { "v": 1, "bulkVersion": 1, "visitCount": 5000, "segments": [] },
        "visitCount": 5000
    });
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await
        .assert_status_ok();

    let user_id = user_id_for_email(&pool, "bulk-counts@example.com").await;
    let (_, history_visits, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(
        history_visits, 5000,
        "one bulk op must count N visits, not 1 row"
    );

    // The row stores the count; non-bulk rows stay NULL (means 1).
    let stored: Option<i32> = sqlx::query_scalar!(
        "SELECT visit_count FROM sync_operations WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored, Some(5000));
}

/// After compaction, `history_visit_count` is N for a bulk import of N
/// visits, not 1.
#[sqlx::test(migrations = "./migrations")]
async fn bulk_compaction_reconciles_to_n_not_one(pool: PgPool) {
    let state = state_for_config(pool.clone(), test_config());
    let server = server_for_state(state.clone());
    register_and_login(&server, "bulk-compact@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "bulk-compact@example.com", "Laptop").await;

    const N: i64 = 3210;
    let bulk = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 1,
        "lamportTimestamp": 1,
        "objectType": "historyVisit",
        "objectId": Uuid::now_v7(),
        "operationType": "bulkImport",
        "encryptionVersion": 0,
        "payload": { "v": 1, "bulkVersion": 1, "visitCount": N, "segments": [] },
        "visitCount": N
    });
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [bulk] }))
        .await
        .assert_status_ok();

    // 250 bookmarks, over the 200-op threshold, so compaction runs.
    let mut ops = Vec::new();
    for i in 0..250 {
        ops.push(make_op(
            "bookmark",
            "create",
            Uuid::now_v7(),
            Uuid::now_v7(),
            2 + i as i64,
            2 + i as i64,
        ));
    }
    // One batch (max 500); deviceSequence continues from 2.
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": ops }))
        .await
        .assert_status_ok();

    sync_device(&server, &access_token).await;

    let user_id = user_id_for_email(&pool, "bulk-compact@example.com").await;
    // Corrupt first, to prove it's overwritten.
    sqlx::query!(
        "UPDATE sync_stats SET history_visit_count = 999 WHERE user_id = $1",
        user_id
    )
    .execute(&pool)
    .await
    .unwrap();

    compaction::run_once(&state).await.unwrap();

    let (bookmarks, history_visits, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(bookmarks, 250);
    assert_eq!(
        history_visits, N,
        "compaction must converge on N visits, not 1 row"
    );
}

/// The first-time `/stats` backfill also counts N for a bulk object, not 1.
#[sqlx::test(migrations = "./migrations")]
async fn bulk_stats_lazy_seed_counts_n(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "bulk-lazy@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "bulk-lazy@example.com", "Laptop").await;

    let op = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 1,
        "lamportTimestamp": 1,
        "objectType": "historyVisit",
        "objectId": Uuid::now_v7(),
        "operationType": "bulkImport",
        "encryptionVersion": 0,
        "payload": { "v": 1, "bulkVersion": 1, "visitCount": 777, "segments": [] },
        "visitCount": 777
    });
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await
        .assert_status_ok();

    // Delete the stats row so `/stats` does the backfill.
    let user_id = user_id_for_email(&pool, "bulk-lazy@example.com").await;
    sqlx::query!("DELETE FROM sync_stats WHERE user_id = $1", user_id)
        .execute(&pool)
        .await
        .unwrap();

    let stats_res = server
        .get("/api/v1/sync/stats")
        .authorization_bearer(&access_token)
        .await;
    stats_res.assert_status_ok();
    let stats: serde_json::Value = stats_res.json();
    assert_eq!(stats["historyVisits"], json!(777));

    let (_, history_visits, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(history_visits, 777);
}

/// The `/stats` backfill races an upload from another device. Whichever
/// gets the lock first, the final count must include both bookmarks, with
/// no lost or double-counted update.
#[sqlx::test(migrations = "./migrations")]
async fn concurrent_lazy_backfill_and_upload_do_not_lose_or_double_count(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "race@example.com").await;
    let (_device_a, token_a) = register_device(&server, "race@example.com", "Laptop").await;
    let (_device_b, token_b) = register_device(&server, "race@example.com", "Phone").await;

    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_a)
        .json(&json!({ "operations": [
            make_op("bookmark", "create", Uuid::now_v7(), Uuid::now_v7(), 1, 1),
        ] }))
        .await
        .assert_status_ok();

    let user_id = user_id_for_email(&pool, "race@example.com").await;
    sqlx::query!("DELETE FROM sync_stats WHERE user_id = $1", user_id)
        .execute(&pool)
        .await
        .unwrap();

    let stats_req = server
        .get("/api/v1/sync/stats")
        .authorization_bearer(&token_a);
    let stats_request = async move { stats_req.await };

    let upload_op = make_op("bookmark", "create", Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    let upload_req = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_b)
        .json(&json!({ "operations": [upload_op] }));
    let upload_request = async move { upload_req.await };

    let (stats_result, upload_result) = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        futures::future::join(stats_request, upload_request),
    )
    .await
    .expect("backfill and concurrent upload must not deadlock on the advisory lock");

    stats_result.assert_status_ok();
    upload_result.assert_status_ok();

    // Check the table directly; `/stats` would just return its cached value.
    let (bookmarks, _, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(
        bookmarks, 2,
        "final count must reflect both bookmarks regardless of race outcome"
    );
}

/// Old rows (NULL visit_count) and old snapshot objects (no visitCount
/// field) each count as 1.
#[sqlx::test(migrations = "./migrations")]
async fn legacy_rows_and_blobs_without_visit_count_count_one(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "bulk-legacy@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "bulk-legacy@example.com", "Laptop").await;

    // Two old single-visit rows (visit_count NULL).
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [
            history_visit_op(Uuid::now_v7(), Uuid::now_v7(), 1, "https://a.example.com"),
            history_visit_op(Uuid::now_v7(), Uuid::now_v7(), 2, "https://b.example.com"),
        ] }))
        .await
        .assert_status_ok();

    let user_id = user_id_for_email(&pool, "bulk-legacy@example.com").await;
    let nulls: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "c!" FROM sync_operations WHERE user_id = $1 AND visit_count IS NULL"#,
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(nulls, 2, "non-bulk rows must store NULL visit_count");

    let (_, history_visits, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(history_visits, 2, "legacy NULL rows count 1 each");

    // An old snapshot object with no visitCount field at all. Written as raw
    // JSON so the field is really missing, not null.
    let legacy_object_id = Uuid::now_v7();
    let legacy_blob = json!([{
        "objectType": "historyVisit",
        "objectId": legacy_object_id,
        "operationType": "visit",
        "encryptionVersion": 0,
        "payload": { "url": "https://legacy.example.com" },
        "createdAt": chrono::Utc::now().to_rfc3339()
    }]);
    let legacy_bytes = serde_json::to_vec(&legacy_blob).unwrap();
    assert!(
        !String::from_utf8_lossy(&legacy_bytes).contains("visitCount"),
        "test precondition: blob must omit visitCount entirely"
    );
    sqlx::query(
        "INSERT INTO sync_snapshots (user_id, snapshot_cursor, encryption_version, data) VALUES ($1, $2, 0, $3)",
    )
    .bind(user_id)
    .bind(0i64)
    .bind(&legacy_bytes)
    .execute(&pool)
    .await
    .unwrap();

    // Force the backfill: 2 rows + 1 snapshot object = 3.
    sqlx::query!("DELETE FROM sync_stats WHERE user_id = $1", user_id)
        .execute(&pool)
        .await
        .unwrap();
    // The row check below doesn't depend on the /stats cache.
    let stats_res = server
        .get("/api/v1/sync/stats")
        .authorization_bearer(&access_token)
        .await;
    stats_res.assert_status_ok();
    let stats: serde_json::Value = stats_res.json();
    assert_eq!(
        stats["historyVisits"],
        json!(3),
        "2 NULL rows + 1 field-less blob object must count 3"
    );
}

/// `/snapshot` opens its transaction with `SNAPSHOT_TX_ISOLATION`, so all
/// its reads see one point in time (docs/protocol.md §10.3).
///
/// The race itself can't be triggered or observed from outside the crate,
/// so this checks that the exact statement used really gives REPEATABLE
/// READ and READ ONLY.
#[sqlx::test(migrations = "./migrations")]
async fn snapshot_transaction_isolation_is_repeatable_read_read_only(pool: PgPool) {
    use helixsync_server::sync::routes::SNAPSHOT_TX_ISOLATION;

    let mut tx = pool.begin_with(SNAPSHOT_TX_ISOLATION).await.unwrap();

    let isolation: String = sqlx::query_scalar("SHOW transaction_isolation")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        isolation, "repeatable read",
        "snapshot's transaction must run under REPEATABLE READ so every read in it sees one consistent point-in-time view"
    );

    let read_only: String = sqlx::query_scalar("SHOW transaction_read_only")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        read_only, "on",
        "snapshot's transaction never writes and should be marked READ ONLY to stay out of REPEATABLE READ's serialization-failure path"
    );

    tx.commit().await.unwrap();
}

/// Runs `/snapshot` many times alongside uploads from another device and
/// checks each response is consistent (no object is also an active
/// tombstone).
#[sqlx::test(migrations = "./migrations")]
async fn snapshot_stays_internally_consistent_under_concurrent_uploads(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "snapshot-race@example.com").await;
    let (_device_a, token_a) =
        register_device(&server, "snapshot-race@example.com", "Laptop").await;
    let (_device_b, token_b) = register_device(&server, "snapshot-race@example.com", "Phone").await;

    for i in 0..20u32 {
        let snapshot_req = server
            .get("/api/v1/sync/snapshot")
            .authorization_bearer(&token_a);
        let snapshot_request = async move { snapshot_req.await };

        let op = make_op(
            "bookmark",
            "create",
            Uuid::now_v7(),
            Uuid::now_v7(),
            1,
            i as i64 + 1,
        );
        let upload_req = server
            .post("/api/v1/sync/operations")
            .authorization_bearer(&token_b)
            .json(&json!({ "operations": [op] }));
        let upload_request = async move { upload_req.await };

        let (snapshot_result, upload_result) = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            futures::future::join(snapshot_request, upload_request),
        )
        .await
        .expect("snapshot and concurrent upload must not deadlock");

        snapshot_result.assert_status_ok();
        upload_result.assert_status_ok();

        let snapshot: serde_json::Value = snapshot_result.json();
        let objects = snapshot["objects"].as_array().unwrap();
        let tombstones = snapshot["tombstones"].as_array().unwrap();
        let tombstoned_ids: std::collections::HashSet<&str> = tombstones
            .iter()
            .map(|t| t["objectId"].as_str().unwrap())
            .collect();
        for obj in objects {
            let id = obj["objectId"].as_str().unwrap();
            assert!(
                !tombstoned_ids.contains(id),
                "iteration {i}: object {id} must not appear as both a live object and an active tombstone in the same snapshot"
            );
        }
    }
}

// --- Pruning sync_objects rows for closed tabs/windows ---

async fn sync_objects_row_exists(
    pool: &PgPool,
    user_id: Uuid,
    object_type: &str,
    object_id: Uuid,
) -> bool {
    sqlx::query_scalar!(
        "SELECT EXISTS(SELECT 1 FROM sync_objects WHERE user_id = $1 AND object_type = $2 AND object_id = $3)",
        user_id,
        object_type,
        object_id
    )
    .fetch_one(pool)
    .await
    .unwrap()
    .unwrap_or(false)
}

/// A closed tab's `sync_objects` row is deleted along with its tombstone
/// once past `ephemeral_tombstone_retention_secs`. A recently closed tab
/// keeps its row, and bookmark rows are never touched.
#[sqlx::test(migrations = "./migrations")]
async fn prunes_ledger_row_for_tab_once_its_close_tombstone_ages_out(pool: PgPool) {
    let mut config = test_config();
    config.ephemeral_tombstone_retention_secs = 60 * 60 * 24 * 30; // 30 days
    let server = server_for_state(state_for_config(pool.clone(), config.clone()));
    register_and_login(&server, "opal@example.com").await;
    let (_device_id, access_token) = register_device(&server, "opal@example.com", "Laptop").await;

    let old_tab = Uuid::now_v7();
    let recent_tab = Uuid::now_v7();
    let old_bookmark = Uuid::now_v7();

    let ops = json!({
        "operations": [
            make_op("tab", "create", Uuid::now_v7(), old_tab, 1, 1),
            make_op("tab", "close", Uuid::now_v7(), old_tab, 2, 2),
            make_op("tab", "create", Uuid::now_v7(), recent_tab, 3, 3),
            make_op("tab", "close", Uuid::now_v7(), recent_tab, 4, 4),
            make_op("bookmark", "create", Uuid::now_v7(), old_bookmark, 5, 5),
        ]
    });
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&ops)
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["accepted"].as_array().unwrap().len(), 5);

    let user_id = user_id_for_email(&pool, "opal@example.com").await;

    // Backdate `old_tab`'s tombstone past retention; `recent_tab` stays recent.
    sqlx::query!(
        "UPDATE tombstones SET created_at = $1 WHERE user_id = $2 AND object_type = 'tab' AND object_id = $3",
        Utc::now() - ChronoDuration::days(31),
        user_id,
        old_tab
    )
    .execute(&pool)
    .await
    .unwrap();

    assert!(sync_objects_row_exists(&pool, user_id, "tab", old_tab).await);
    assert!(sync_objects_row_exists(&pool, user_id, "tab", recent_tab).await);
    assert!(sync_objects_row_exists(&pool, user_id, "bookmark", old_bookmark).await);

    let state = state_for_config(pool.clone(), config);
    housekeeping::run_once(&state).await;

    assert!(
        !sync_objects_row_exists(&pool, user_id, "tab", old_tab).await,
        "old_tab's ledger row must be pruned alongside its aged-out close tombstone"
    );
    assert!(
        sync_objects_row_exists(&pool, user_id, "tab", recent_tab).await,
        "recent_tab's close tombstone is still inside the retention window, so its ledger row must survive"
    );
    assert!(
        sync_objects_row_exists(&pool, user_id, "bookmark", old_bookmark).await,
        "bookmark ledger rows must never be touched by this sweep"
    );
}

/// After a tab's ledger row is pruned, a late `update` for it is rejected
/// `object_not_found` (tab ids are never reused). A tab whose row still
/// exists keeps working.
#[sqlx::test(migrations = "./migrations")]
async fn late_op_after_ledger_prune_is_rejected_but_live_object_still_works(pool: PgPool) {
    let mut config = test_config();
    config.ephemeral_tombstone_retention_secs = 60 * 60 * 24 * 30; // 30 days
    let server = server_for_state(state_for_config(pool.clone(), config.clone()));
    register_and_login(&server, "quinn@example.com").await;
    let (_device_id, access_token) = register_device(&server, "quinn@example.com", "Laptop").await;

    let pruned_tab = Uuid::now_v7();
    let live_tab = Uuid::now_v7();

    let ops = json!({
        "operations": [
            make_op("tab", "create", Uuid::now_v7(), pruned_tab, 1, 1),
            make_op("tab", "close", Uuid::now_v7(), pruned_tab, 2, 2),
            make_op("tab", "create", Uuid::now_v7(), live_tab, 3, 3),
        ]
    });
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&ops)
        .await
        .assert_status_ok();

    let user_id = user_id_for_email(&pool, "quinn@example.com").await;
    sqlx::query!(
        "UPDATE tombstones SET created_at = $1 WHERE user_id = $2 AND object_type = 'tab' AND object_id = $3",
        Utc::now() - ChronoDuration::days(31),
        user_id,
        pruned_tab
    )
    .execute(&pool)
    .await
    .unwrap();

    let state = state_for_config(pool.clone(), config);
    housekeeping::run_once(&state).await;
    assert!(!sync_objects_row_exists(&pool, user_id, "tab", pruned_tab).await);

    // Late `update` for the pruned tab: rejected, without affecting the rest.
    let stale_update = make_op("tab", "update", Uuid::now_v7(), pruned_tab, 4, 4);
    // `update` for the live tab: accepted.
    let live_update = make_op("tab", "update", Uuid::now_v7(), live_tab, 5, 5);

    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [stale_update, live_update] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["accepted"].as_array().unwrap().len(), 1);
    let rejected = body["rejected"].as_array().unwrap();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0]["reason"], "object_not_found");
}

// --- Bulk history permanent dedup (fix.md §3): a bulkImport op's
// `object_id`, once accepted, must read as `Duplicate` forever, even after
// compaction has deleted its `sync_operations` row and even when the retry
// reserves a fresh `device_sequence`. ---

/// Acks a device past everything currently downloadable — the two-round-trip
/// dance `sync::compaction::compact_user`'s per-device ack boundary actually
/// requires (docs/protocol.md §4.4): the cursor a request sends is what the
/// device claims to have *already* applied, so the server only learns it
/// advanced to `nextCursor` on the device's *next* request.
async fn ack_device(server: &TestServer, token: &str) {
    let res = server
        .get("/api/v1/sync/changes?cursor=0")
        .authorization_bearer(token)
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let next_cursor = body["nextCursor"].as_i64().unwrap();
    server
        .get(&format!("/api/v1/sync/changes?cursor={next_cursor}"))
        .authorization_bearer(token)
        .await
        .assert_status_ok();
}

/// Test 1 (fix.md §7): upload a bulk op, ack it, compact it away (its
/// `sync_operations` row is deleted), then re-upload the *same*
/// operationId/objectId but with a higher `deviceSequence` — simulating the
/// extension resuming an import after `sync::compaction` has already run.
/// Must come back `duplicate`, must not create a new `sync_operations` row,
/// and `sync_stats.history_visit_count` must not double-count it.
#[sqlx::test(migrations = "./migrations")]
async fn bulk_reupload_after_compaction_is_duplicate(pool: PgPool) {
    let state = state_for_config(pool.clone(), test_config());
    let server = server_for_state(state.clone());
    register_and_login(&server, "bulk-compact-dup@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "bulk-compact-dup@example.com", "Laptop").await;
    let user_id = user_id_for_email(&pool, "bulk-compact-dup@example.com").await;

    let object_id = Uuid::now_v7();
    let operation_id = Uuid::now_v7();
    let first = bulk_history_op(operation_id, object_id, 1, Some(100_000));
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [first] }))
        .await;
    res.assert_status_ok();
    assert_eq!(
        res.json::<serde_json::Value>()["accepted"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    ack_device(&server, &access_token).await;
    compaction::run_once(&state).await.unwrap();

    // The original op's row is gone — folded into a snapshot and pruned.
    let still_present: Option<Uuid> = sqlx::query_scalar!(
        "SELECT operation_id FROM sync_operations WHERE operation_id = $1",
        operation_id
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(
        still_present.is_none(),
        "compaction must have pruned the original op's row"
    );

    let (_, history_visits_after_compaction, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(history_visits_after_compaction, 100_000);

    // Re-upload: same operationId and objectId, but a fresh, higher
    // deviceSequence — as a naive resume that doesn't know the chunk was
    // already accepted would do.
    let retry = bulk_history_op(operation_id, object_id, 50, Some(100_000));
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [retry] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(
        body["accepted"].as_array().unwrap().is_empty(),
        "a re-sent bulk chunk must not be accepted twice"
    );
    assert_eq!(
        body["duplicate"].as_array().unwrap(),
        &vec![json!(operation_id)]
    );

    let row_count: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "c!" FROM sync_operations WHERE object_id = $1"#,
        object_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row_count, 0,
        "no new sync_operations row for the duplicate retry"
    );

    let (_, history_visits_after_retry, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(
        history_visits_after_retry, 100_000,
        "history_visit_count must not double-count the re-sent chunk"
    );
}

/// Test 2 (fix.md §7): the permanent-dedup check is keyed on `object_id`,
/// not `operation_id` — a *different* operationId carrying the same bulk
/// object_id (as a client that lost its own record of which operationId it
/// used, but kept the deterministic object_id, might resend) is also a
/// duplicate.
#[sqlx::test(migrations = "./migrations")]
async fn bulk_reupload_with_different_operation_id_same_object_is_duplicate(pool: PgPool) {
    let state = state_for_config(pool.clone(), test_config());
    let server = server_for_state(state.clone());
    register_and_login(&server, "bulk-object-dup@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "bulk-object-dup@example.com", "Laptop").await;
    let user_id = user_id_for_email(&pool, "bulk-object-dup@example.com").await;

    let object_id = Uuid::now_v7();
    let first = bulk_history_op(Uuid::now_v7(), object_id, 1, Some(50_000));
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [first] }))
        .await
        .assert_status_ok();

    ack_device(&server, &access_token).await;
    compaction::run_once(&state).await.unwrap();

    let retry = bulk_history_op(Uuid::now_v7(), object_id, 2, Some(50_000));
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [retry] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(
        body["accepted"].as_array().unwrap().is_empty(),
        "same object_id under a different operation_id must still be caught"
    );
    assert_eq!(body["rejected"].as_array().unwrap().len(), 0);

    let (_, history_visits, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(history_visits, 50_000);
}

/// Test 3 (fix.md §7): single-visit `historyVisit`/`visit` ops must still
/// never create a `sync_objects` ledger row — only `bulkImport` gets the
/// permanent-dedup ledger entry (fix.md §3, the filter that keeps bulk rows
/// while still dropping every other historyVisit row).
#[sqlx::test(migrations = "./migrations")]
async fn single_visit_history_ops_do_not_create_sync_objects_rows(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "single-visit-ledger@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "single-visit-ledger@example.com", "Laptop").await;
    let user_id = user_id_for_email(&pool, "single-visit-ledger@example.com").await;

    let object_id = Uuid::now_v7();
    let op = history_visit_op(Uuid::now_v7(), object_id, 1, "https://example.com");
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await
        .assert_status_ok();

    let row: Option<Uuid> = sqlx::query_scalar!(
        "SELECT object_id FROM sync_objects WHERE user_id = $1 AND object_type = 'historyVisit' AND object_id = $2",
        user_id,
        object_id
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(
        row.is_none(),
        "a single-visit historyVisit op must not get a sync_objects ledger row"
    );
}

// --- Hourly visit-count buckets (Change 3, docs/protocol.md §8.3.2):
// `visitHours` validation, the `history_visit_hours` write path, and the
// `/stats` read path (retention filtering + legacy accounts). ---

/// Truncates down to the containing UTC hour — the Rust-side equivalent of
/// `date_trunc('hour', ...)`, used to build expected bucket keys/rows for
/// these tests without going through a live server round trip.
fn truncate_hour(dt: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp(dt.timestamp() - dt.timestamp().rem_euclid(3600), 0).unwrap()
}

/// RFC3339-with-milliseconds hour key, matching exactly what the extension's
/// `hourKey` (extension/src/util/hour.ts) sends on the wire.
fn hour_key(dt: DateTime<Utc>) -> String {
    truncate_hour(dt).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn bulk_history_op_with_hours(
    op_id: Uuid,
    object_id: Uuid,
    seq: i64,
    visit_count: i64,
    visit_hours: serde_json::Value,
) -> serde_json::Value {
    json!({
        "operationId": op_id,
        "deviceSequence": seq,
        "lamportTimestamp": seq,
        "objectType": "historyVisit",
        "objectId": object_id,
        "operationType": "bulkImport",
        "encryptionVersion": 0,
        "payload": { "v": 1, "bulkVersion": 1, "visitCount": visit_count, "segments": [] },
        "visitCount": visit_count,
        "visitHours": visit_hours
    })
}

fn history_visit_op_with_hours(
    op_id: Uuid,
    object_id: Uuid,
    seq: i64,
    url: &str,
    visit_hours: serde_json::Value,
) -> serde_json::Value {
    json!({
        "operationId": op_id,
        "deviceSequence": seq,
        "lamportTimestamp": seq,
        "objectType": "historyVisit",
        "objectId": object_id,
        "operationType": "visit",
        "encryptionVersion": 0,
        "payload": { "url": url, "title": "Example", "visitedAt": "2026-01-01T00:00:00.000Z" },
        "visitHours": visit_hours
    })
}

async fn history_visit_hours_sum(pool: &PgPool, user_id: Uuid) -> i64 {
    sqlx::query_scalar!(
        r#"SELECT COALESCE(SUM(visits), 0)::bigint AS "sum!" FROM history_visit_hours WHERE user_id = $1"#,
        user_id
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Test 1: every documented `visitHours` rejection reason.
#[sqlx::test(migrations = "./migrations")]
async fn visit_hours_validation_rejects_each_reason(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "visit-hours-validation@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "visit-hours-validation@example.com", "Laptop").await;

    async fn post_and_reason(server: &TestServer, token: &str, op: serde_json::Value) -> String {
        let res = server
            .post("/api/v1/sync/operations")
            .authorization_bearer(token)
            .json(&json!({ "operations": [op] }))
            .await;
        res.assert_status_ok();
        let body: serde_json::Value = res.json();
        assert!(
            body["accepted"].as_array().unwrap().is_empty(),
            "expected this op to be rejected, not accepted"
        );
        body["rejected"][0]["reason"].as_str().unwrap().to_string()
    }

    let now_hour = hour_key(Utc::now());

    // unexpected_visit_hours: not a historyVisit op.
    let mut bookmark_op = sample_bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1);
    bookmark_op["visitHours"] = json!({ now_hour.clone(): 1 });
    assert_eq!(
        post_and_reason(&server, &access_token, bookmark_op).await,
        "unexpected_visit_hours"
    );

    // invalid_visit_hours: hour not aligned to the hour boundary.
    let misaligned = history_visit_op_with_hours(
        Uuid::now_v7(),
        Uuid::now_v7(),
        1,
        "https://a.example.com",
        json!({ "2026-01-01T00:30:00.000Z": 1 }),
    );
    assert_eq!(
        post_and_reason(&server, &access_token, misaligned).await,
        "invalid_visit_hours"
    );

    // invalid_visit_hours: hour more than a day in the future.
    let future_hour = hour_key(Utc::now() + ChronoDuration::days(3));
    let future_op = history_visit_op_with_hours(
        Uuid::now_v7(),
        Uuid::now_v7(),
        1,
        "https://b.example.com",
        json!({ future_hour: 1 }),
    );
    assert_eq!(
        post_and_reason(&server, &access_token, future_op).await,
        "invalid_visit_hours"
    );

    // invalid_visit_hours: a zero count.
    let zero_op = history_visit_op_with_hours(
        Uuid::now_v7(),
        Uuid::now_v7(),
        1,
        "https://c.example.com",
        json!({ now_hour.clone(): 0 }),
    );
    assert_eq!(
        post_and_reason(&server, &access_token, zero_op).await,
        "invalid_visit_hours"
    );

    // visit_hours_mismatch: bulkImport whose visitHours doesn't sum to visitCount.
    let bulk_mismatch = bulk_history_op_with_hours(
        Uuid::now_v7(),
        Uuid::now_v7(),
        1,
        10,
        json!({ now_hour.clone(): 5 }),
    );
    assert_eq!(
        post_and_reason(&server, &access_token, bulk_mismatch).await,
        "visit_hours_mismatch"
    );

    // visit_hours_mismatch: a live `visit` op with 2 entries (must be exactly 1).
    let other_hour = hour_key(Utc::now() - ChronoDuration::hours(2));
    let two_entries = history_visit_op_with_hours(
        Uuid::now_v7(),
        Uuid::now_v7(),
        1,
        "https://d.example.com",
        json!({ now_hour.clone(): 1, other_hour: 1 }),
    );
    assert_eq!(
        post_and_reason(&server, &access_token, two_entries).await,
        "visit_hours_mismatch"
    );

    // Sanity: a valid one of each is still accepted.
    let valid_bulk = bulk_history_op_with_hours(
        Uuid::now_v7(),
        Uuid::now_v7(),
        1,
        10,
        json!({ now_hour.clone(): 10 }),
    );
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [valid_bulk] }))
        .await;
    res.assert_status_ok();
    assert_eq!(
        res.json::<serde_json::Value>()["accepted"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let valid_visit = history_visit_op_with_hours(
        Uuid::now_v7(),
        Uuid::now_v7(),
        2,
        "https://e.example.com",
        json!({ now_hour: 1 }),
    );
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [valid_visit] }))
        .await;
    res.assert_status_ok();
    assert_eq!(
        res.json::<serde_json::Value>()["accepted"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

/// Test 2: an accepted bulk op spanning 40 days ago and 1 day ago, with
/// retention set to 30d, must have `/stats` count only the recent bucket;
/// accepted live `visit` ops each add 1.
#[sqlx::test(migrations = "./migrations")]
async fn visit_hours_accepted_ops_respect_retention_window(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "visit-hours-retention@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "visit-hours-retention@example.com", "Laptop").await;

    server
        .patch("/api/v1/sync/settings")
        .authorization_bearer(&access_token)
        .json(&json!({ "historyRetention": "30d" }))
        .await
        .assert_status_ok();

    let old_hour = hour_key(Utc::now() - ChronoDuration::days(40));
    let recent_hour = hour_key(Utc::now() - ChronoDuration::days(1));
    let bulk = bulk_history_op_with_hours(
        Uuid::now_v7(),
        Uuid::now_v7(),
        1,
        150,
        json!({ old_hour: 100, recent_hour.clone(): 50 }),
    );
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [bulk] }))
        .await
        .assert_status_ok();

    let visit1 = history_visit_op_with_hours(
        Uuid::now_v7(),
        Uuid::now_v7(),
        2,
        "https://a.example.com",
        json!({ recent_hour.clone(): 1 }),
    );
    let visit2 = history_visit_op_with_hours(
        Uuid::now_v7(),
        Uuid::now_v7(),
        3,
        "https://b.example.com",
        json!({ recent_hour: 1 }),
    );
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [visit1, visit2] }))
        .await
        .assert_status_ok();

    let stats_res = server
        .get("/api/v1/sync/stats")
        .authorization_bearer(&access_token)
        .await;
    stats_res.assert_status_ok();
    let stats: serde_json::Value = stats_res.json();
    // 50 (bulk, recent) + 1 + 1 (live visits) = 52 — the 100 from 40 days
    // ago must be excluded by the 30d retention cutoff.
    assert_eq!(stats["historyVisits"], json!(52));
}

/// Test 3: an exact duplicate upload (same operationId, still in
/// `sync_operations`) must not add buckets again, and neither must the
/// post-compaction bulk-permanent-dedup duplicate path from the previous
/// pass (fix.md §3).
#[sqlx::test(migrations = "./migrations")]
async fn duplicate_visit_hours_upload_does_not_double_count(pool: PgPool) {
    let state = state_for_config(pool.clone(), test_config());
    let server = server_for_state(state.clone());
    register_and_login(&server, "visit-hours-dup@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "visit-hours-dup@example.com", "Laptop").await;
    let user_id = user_id_for_email(&pool, "visit-hours-dup@example.com").await;

    let hour = hour_key(Utc::now());
    let op = history_visit_op_with_hours(
        Uuid::now_v7(),
        Uuid::now_v7(),
        1,
        "https://dup.example.com",
        json!({ hour.clone(): 1 }),
    );

    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op.clone()] }))
        .await
        .assert_status_ok();
    assert_eq!(history_visit_hours_sum(&pool, user_id).await, 1);

    // Same operationId, still present in sync_operations: plain duplicate.
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await;
    res.assert_status_ok();
    assert!(res.json::<serde_json::Value>()["accepted"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        history_visit_hours_sum(&pool, user_id).await,
        1,
        "an exact duplicate must not add buckets again"
    );

    // Bulk op, then ack + compact so its sync_operations row is pruned, then
    // resend the same object_id with a fresh operationId/deviceSequence —
    // the permanent bulk-dedup path (fix.md §3), independent of the
    // `existing` operationId check above.
    let bulk_object_id = Uuid::now_v7();
    let bulk_hour = hour_key(Utc::now());
    let bulk = bulk_history_op_with_hours(
        Uuid::now_v7(),
        bulk_object_id,
        2,
        10,
        json!({ bulk_hour.clone(): 10 }),
    );
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [bulk] }))
        .await
        .assert_status_ok();
    ack_device(&server, &access_token).await;
    compaction::run_once(&state).await.unwrap();
    assert_eq!(history_visit_hours_sum(&pool, user_id).await, 11);

    let retry = bulk_history_op_with_hours(
        Uuid::now_v7(),
        bulk_object_id,
        50,
        10,
        json!({ bulk_hour: 10 }),
    );
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [retry] }))
        .await;
    res.assert_status_ok();
    assert!(res.json::<serde_json::Value>()["accepted"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        history_visit_hours_sum(&pool, user_id).await,
        11,
        "a post-compaction duplicate retry must not add buckets again"
    );
}

/// Test 4: a legacy op with no `visitHours` field at all (an older client
/// build) is bucketed at its upload hour, using `visit_count.unwrap_or(1)`.
#[sqlx::test(migrations = "./migrations")]
async fn legacy_op_without_visit_hours_buckets_at_upload_hour(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "legacy-visit-hours@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "legacy-visit-hours@example.com", "Laptop").await;
    let user_id = user_id_for_email(&pool, "legacy-visit-hours@example.com").await;

    let before = Utc::now();
    let op = history_visit_op(
        Uuid::now_v7(),
        Uuid::now_v7(),
        1,
        "https://legacy.example.com",
    );
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [op] }))
        .await
        .assert_status_ok();

    let rows = sqlx::query!(
        "SELECT hour, visits FROM history_visit_hours WHERE user_id = $1",
        user_id
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].visits, 1);
    assert_eq!(rows[0].hour, truncate_hour(before));
}

/// Test 5: a pre-migration-0018 account (simulated: `history_hours_seed_
/// before` set, bucket rows deleted as if they'd never existed) gets its
/// buckets backfilled from its live historyVisit objects on the next
/// `/stats` call, and the marker is cleared so nothing re-seeds afterward.
#[sqlx::test(migrations = "./migrations")]
async fn legacy_seed_backfills_history_visit_hours_once(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "legacy-seed@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "legacy-seed@example.com", "Laptop").await;
    let user_id = user_id_for_email(&pool, "legacy-seed@example.com").await;

    let bulk = bulk_history_op_with_hours(
        Uuid::now_v7(),
        Uuid::now_v7(),
        1,
        20,
        json!({ hour_key(Utc::now()): 20 }),
    );
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&access_token)
        .json(&json!({ "operations": [bulk] }))
        .await
        .assert_status_ok();

    // Simulate a pre-0018 account: mark it for seeding and wipe the bucket
    // rows process_batch just wrote, as if they'd never existed.
    sqlx::query!(
        "UPDATE sync_stats SET history_hours_seed_before = now() WHERE user_id = $1",
        user_id
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query!(
        "DELETE FROM history_visit_hours WHERE user_id = $1",
        user_id
    )
    .execute(&pool)
    .await
    .unwrap();

    let stats_res = server
        .get("/api/v1/sync/stats")
        .authorization_bearer(&access_token)
        .await;
    stats_res.assert_status_ok();
    let stats: serde_json::Value = stats_res.json();
    assert_eq!(
        stats["historyVisits"],
        json!(20),
        "legacy seed must recover the count from the live object"
    );

    let seed_marker: Option<DateTime<Utc>> = sqlx::query_scalar!(
        "SELECT history_hours_seed_before FROM sync_stats WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        seed_marker.is_none(),
        "the marker must be cleared after seeding"
    );
    assert_eq!(
        history_visit_hours_sum(&pool, user_id).await,
        20,
        "seeding must not double-count the single live object"
    );
    // A later call can never re-seed: with the marker cleared, every future
    // `stats` call takes the `Some(r) if r.history_hours_seed_before.is_none()`
    // fast path, which never calls `seed_history_visit_hours` at all — this
    // is a structural guarantee, not a race that needs to be won. (A second
    // live HTTP call here would only re-exercise `STATS_CACHE`'s 30s TTL,
    // not this code path.)
}
