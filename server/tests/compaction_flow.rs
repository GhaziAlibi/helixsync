use std::sync::Arc;

use axum_test::{TestServer, TestServerConfig, Transport};
use chrono::Utc;
use helixsync_server::config::Config;
use helixsync_server::housekeeping;
use helixsync_server::middleware::rate_limit::RateLimiter;
use helixsync_server::state::AppState;
use helixsync_server::sync::compaction;
use helixsync_server::sync::model::SnapshotObject;
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
        behind_proxy: false,
        cors_allowed_origins: vec![],
        protocol_version: 1,
        minimum_supported_protocol_version: 1,
        api_version: "v1".to_string(),
        // Zero, so delete ops are compactable without waiting.
        tombstone_retention_secs: 0,
        compaction_interval_secs: 60 * 60,
        // Keep the real 30-day default so no device ages out by accident.
        inactive_device_compaction_grace_period_secs: 60 * 60 * 24 * 30,
        // Long, so never-synced devices don't age out unless a test says so.
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

fn state_with_tombstone_retention(pool: PgPool, retention_secs: i64) -> AppState {
    let mut config = test_config();
    config.tombstone_retention_secs = retention_secs;
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

fn state_with_inactive_device_grace_period(pool: PgPool, grace_period_secs: i64) -> AppState {
    let mut config = test_config();
    config.inactive_device_compaction_grace_period_secs = grace_period_secs;
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

fn state_with_never_synced_device_grace_period(pool: PgPool, grace_period_secs: i64) -> AppState {
    let mut config = test_config();
    config.never_synced_device_compaction_grace_period_secs = grace_period_secs;
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

fn bookmark_op(
    op_id: Uuid,
    object_id: Uuid,
    seq: i64,
    lamport: i64,
    title: &str,
) -> serde_json::Value {
    json!({
        "operationId": op_id,
        "deviceSequence": seq,
        "lamportTimestamp": lamport,
        "objectType": "bookmark",
        "objectId": object_id,
        "operationType": if seq == 1 { "create" } else { "update" },
        "encryptionVersion": 0,
        "payload": if seq == 1 {
            json!({ "title": title, "url": "https://example.com", "parent": null, "position": "a0" })
        } else {
            json!({ "title": title })
        }
    })
}

async fn upload(server: &TestServer, token: &str, op: serde_json::Value) {
    server
        .post("/api/v1/sync/operations")
        .authorization_bearer(token)
        .json(&json!({ "operations": [op] }))
        .await
        .assert_status_ok();
}

async fn download(server: &TestServer, token: &str, cursor: i64) -> axum_test::TestResponse {
    server
        .get(&format!("/api/v1/sync/changes?cursor={cursor}"))
        .authorization_bearer(token)
        .await
}

/// Syncs a device and makes sure its ack is saved. The server only learns
/// the new cursor on the next request (docs/protocol.md §4.4), so this
/// makes a second call like a real client's next poll.
async fn sync_device(server: &TestServer, token: &str) {
    let res = download(server, token, 0).await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let next_cursor = body["nextCursor"].as_i64().unwrap();
    download(server, token, next_cursor)
        .await
        .assert_status_ok();
}

async fn count_operations(pool: &PgPool, user_id: Uuid) -> i64 {
    sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "c!" FROM sync_operations WHERE user_id = $1"#,
        user_id
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn count_snapshots(pool: &PgPool, user_id: Uuid) -> i64 {
    sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "c!" FROM sync_snapshots WHERE user_id = $1"#,
        user_id
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn user_id_for_email(pool: &PgPool, email: &str) -> Uuid {
    sqlx::query_scalar!("SELECT id FROM users WHERE email = $1", email)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrations = "./migrations")]
async fn compaction_waits_for_every_active_device_to_acknowledge(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "ann@example.com").await;
    let (_device_a, token_a) = register_device(&server, "ann@example.com", "Laptop").await;
    // Device B is registered but never syncs — it must block compaction.
    let (_device_b, _token_b) = register_device(&server, "ann@example.com", "Phone").await;

    let object_id = Uuid::now_v7();
    upload(
        &server,
        &token_a,
        bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example"),
    )
    .await;

    // Device A acknowledges past the only operation; device B never does.
    sync_device(&server, &token_a).await;

    let user_id = user_id_for_email(&pool, "ann@example.com").await;
    assert_eq!(count_operations(&pool, user_id).await, 1);

    compaction::run_once(&state).await.unwrap();

    // Device B never acked, so nothing is compacted.
    assert_eq!(count_operations(&pool, user_id).await, 1);
    assert_eq!(count_snapshots(&pool, user_id).await, 0);

    // The data is still there for device B.
    let body_b: serde_json::Value = download(&server, &_token_b, 0).await.json();
    assert_eq!(body_b["operations"].as_array().unwrap().len(), 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn revoked_device_never_blocks_compaction(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "bea@example.com").await;
    let (_device_a, token_a) = register_device(&server, "bea@example.com", "Laptop").await;
    let (device_b, _token_b) = register_device(&server, "bea@example.com", "Phone").await;

    let object_id = Uuid::now_v7();
    upload(
        &server,
        &token_a,
        bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example"),
    )
    .await;
    upload(
        &server,
        &token_a,
        bookmark_op(Uuid::now_v7(), object_id, 2, 2, "Renamed"),
    )
    .await;

    // Only device A acks; device B is revoked without ever calling /changes.
    sync_device(&server, &token_a).await;

    sqlx::query("UPDATE devices SET revoked_at = now() WHERE id = $1::uuid")
        .bind(&device_b)
        .execute(&pool)
        .await
        .unwrap();

    let user_id = user_id_for_email(&pool, "bea@example.com").await;
    compaction::run_once(&state).await.unwrap();

    // The revoked device doesn't block compaction; everything up to A's ack
    // is compacted.
    assert_eq!(count_operations(&pool, user_id).await, 0);
    assert_eq!(count_snapshots(&pool, user_id).await, 1);

    let snapshot_cursor: i64 = sqlx::query_scalar!(
        "SELECT snapshot_cursor FROM sync_snapshots WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(snapshot_cursor, 2);
}

#[sqlx::test(migrations = "./migrations")]
async fn reconnecting_device_gets_cursor_too_old_and_resyncs_via_snapshot(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "cleo@example.com").await;
    let (_device_a, token_a) = register_device(&server, "cleo@example.com", "Laptop").await;
    let (_device_b, token_b) = register_device(&server, "cleo@example.com", "Phone").await;

    let object_id = Uuid::now_v7();
    upload(
        &server,
        &token_a,
        bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example"),
    )
    .await;
    upload(
        &server,
        &token_a,
        bookmark_op(Uuid::now_v7(), object_id, 2, 2, "Renamed"),
    )
    .await;

    // Both devices fully acknowledge, so compaction can remove everything.
    sync_device(&server, &token_a).await;
    sync_device(&server, &token_b).await;

    let user_id = user_id_for_email(&pool, "cleo@example.com").await;
    compaction::run_once(&state).await.unwrap();
    assert_eq!(count_operations(&pool, user_id).await, 0);
    assert_eq!(count_snapshots(&pool, user_id).await, 1);

    // Device B reinstalls and starts from cursor 0. That's below the
    // compacted floor, so it must be told to resync.
    let stale_res = download(&server, &token_b, 0).await;
    stale_res.assert_status(axum::http::StatusCode::CONFLICT);
    let stale_body: serde_json::Value = stale_res.json();
    assert_eq!(stale_body["error"], json!("cursor_too_old"));

    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&token_b)
        .await;
    snapshot_res.assert_status_ok();
    let snapshot: serde_json::Value = snapshot_res.json();
    let objects = snapshot["objects"].as_array().unwrap();
    assert_eq!(objects.len(), 1);
    assert_eq!(objects[0]["payload"]["title"], json!("Renamed"));
    let resync_cursor = snapshot["snapshotCursor"].as_i64().unwrap();

    // Resuming from the snapshot cursor works.
    let resumed = download(&server, &token_b, resync_cursor).await;
    resumed.assert_status_ok();
    let resumed_body: serde_json::Value = resumed.json();
    assert!(resumed_body["operations"].as_array().unwrap().is_empty());
}

/// A huge client cursor must not be saved as-is. Otherwise compaction would
/// treat it as acked and delete every op, including newer ones from other
/// devices.
#[sqlx::test(migrations = "./migrations")]
async fn cursor_beyond_allocated_is_clamped_not_recorded_verbatim(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "finn@example.com").await;
    let (device_a, token_a) = register_device(&server, "finn@example.com", "Laptop").await;
    let (_device_b, token_b) = register_device(&server, "finn@example.com", "Phone").await;

    let object_id_1 = Uuid::now_v7();
    upload(
        &server,
        &token_a,
        bookmark_op(Uuid::now_v7(), object_id_1, 1, 1, "First"),
    )
    .await;

    // A cursor far beyond anything allocated is rejected with
    // `409 cursor_invalid`, and the saved cursor is still clamped.
    let poison_attempt = download(&server, &token_a, i64::MAX / 2).await;
    poison_attempt.assert_status(axum::http::StatusCode::CONFLICT);
    let poison_body: serde_json::Value = poison_attempt.json();
    assert_eq!(poison_body["error"], json!("cursor_invalid"));

    // Saved cursor is clamped to the real max (1).
    let device_a_id = Uuid::parse_str(&device_a).unwrap();
    let recorded_cursor: i64 = sqlx::query_scalar!(
        "SELECT cursor_value FROM sync_cursors WHERE user_id = (SELECT id FROM users WHERE email = 'finn@example.com') AND device_id = $1",
        device_a_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(recorded_cursor, 1);

    // Device B uploads and acks a new op after the bad request.
    let object_id_2 = Uuid::now_v7();
    upload(
        &server,
        &token_b,
        bookmark_op(Uuid::now_v7(), object_id_2, 1, 2, "Second"),
    )
    .await;
    sync_device(&server, &token_b).await;

    let user_id = user_id_for_email(&pool, "finn@example.com").await;
    compaction::run_once(&state).await.unwrap();

    // Device A never really acked past 1, so op 2 must still exist.
    assert_eq!(count_operations(&pool, user_id).await, 1);
    let remaining_cursor: i64 = sqlx::query_scalar!(
        r#"SELECT server_cursor FROM sync_operations WHERE user_id = $1"#,
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(remaining_cursor, 2);

    // Device A can still download normally.
    let follow_up = download(&server, &token_a, 1).await;
    follow_up.assert_status_ok();
}

/// A pass with only a few new ops (below the threshold) must not rebuild
/// the snapshot.
#[sqlx::test(migrations = "./migrations")]
async fn compaction_skips_recompaction_below_new_operation_threshold(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "dev@example.com").await;
    let (_device_a, token_a) = register_device(&server, "dev@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    upload(
        &server,
        &token_a,
        bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example"),
    )
    .await;
    // Track the device's cursor like a real client. `sync_device` starts from
    // 0, which fails with `cursor_too_old` after the first compaction.
    let cursor = download(&server, &token_a, 0)
        .await
        .json::<serde_json::Value>()["nextCursor"]
        .as_i64()
        .unwrap();
    download(&server, &token_a, cursor).await.assert_status_ok();

    let user_id = user_id_for_email(&pool, "dev@example.com").await;

    // First pass: no snapshot yet, so it always runs.
    compaction::run_once(&state).await.unwrap();
    assert_eq!(count_snapshots(&pool, user_id).await, 1);
    assert_eq!(count_operations(&pool, user_id).await, 0);
    let first_cursor: i64 = sqlx::query_scalar!(
        "SELECT snapshot_cursor FROM sync_snapshots WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(first_cursor, 1);
    assert_eq!(cursor, first_cursor);

    // Two more ops, well under the threshold. Built by hand because this is
    // a new object's first op (so a `create`), but not the device's first.
    let other_object = Uuid::now_v7();
    upload(
        &server,
        &token_a,
        json!({
            "operationId": Uuid::now_v7(),
            "deviceSequence": 2,
            "lamportTimestamp": 2,
            "objectType": "bookmark",
            "objectId": other_object,
            "operationType": "create",
            "encryptionVersion": 0,
            "payload": { "title": "Second", "url": "https://example.com/2", "parent": null, "position": "a1" }
        }),
    )
    .await;
    upload(
        &server,
        &token_a,
        json!({
            "operationId": Uuid::now_v7(),
            "deviceSequence": 3,
            "lamportTimestamp": 3,
            "objectType": "bookmark",
            "objectId": other_object,
            "operationType": "update",
            "encryptionVersion": 0,
            "payload": { "title": "Second renamed" }
        }),
    )
    .await;
    let cursor = download(&server, &token_a, cursor)
        .await
        .json::<serde_json::Value>()["nextCursor"]
        .as_i64()
        .unwrap();
    download(&server, &token_a, cursor).await.assert_status_ok();
    assert_eq!(
        count_operations(&pool, user_id).await,
        2,
        "new ops land as raw rows before compaction"
    );

    compaction::run_once(&state).await.unwrap();

    // Skipped: same single snapshot, and the two new rows are still there.
    assert_eq!(count_snapshots(&pool, user_id).await, 1);
    let cursor_after_skip: i64 = sqlx::query_scalar!(
        "SELECT snapshot_cursor FROM sync_snapshots WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        cursor_after_skip, first_cursor,
        "compaction must not have advanced the snapshot"
    );
    assert_eq!(
        count_operations(&pool, user_id).await,
        2,
        "raw rows below the threshold must survive untouched"
    );
}

/// Compaction deletes acked ops except delete ops still inside their
/// retention window.
#[sqlx::test(migrations = "./migrations")]
async fn terminal_operation_survives_its_own_retention_window(pool: PgPool) {
    // One day, so a just-made delete is always inside it.
    let state = state_with_tombstone_retention(pool.clone(), 60 * 60 * 24);
    let server = server_for_state(state.clone());

    register_and_login(&server, "paul@example.com").await;
    let (_device_a, token_a) = register_device(&server, "paul@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    upload(
        &server,
        &token_a,
        bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example"),
    )
    .await;
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
        .authorization_bearer(&token_a)
        .json(&json!({ "operations": [delete_op] }))
        .await
        .assert_status_ok();

    sync_device(&server, &token_a).await;

    let user_id = user_id_for_email(&pool, "paul@example.com").await;
    assert_eq!(
        count_operations(&pool, user_id).await,
        2,
        "create + delete before compaction"
    );

    compaction::run_once(&state).await.unwrap();

    // The `create` is gone; the `delete` stays (still in retention).
    assert_eq!(
        count_operations(&pool, user_id).await,
        1,
        "the delete op's raw row must survive its own retention window"
    );
    let remaining_op_type: String = sqlx::query_scalar!(
        "SELECT operation_type FROM sync_operations WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(remaining_op_type, "delete");

    // The object is still excluded from a new snapshot either way.
    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&token_a)
        .await;
    snapshot_res.assert_status_ok();
    let snapshot: serde_json::Value = snapshot_res.json();
    assert!(snapshot["objects"].as_array().unwrap().is_empty());
    assert_eq!(snapshot["tombstones"].as_array().unwrap().len(), 1);
}

/// Editing an object after compaction removed its `create` row must work.
/// The ownership check uses `sync_objects`, which compaction never prunes
/// (migration `0006_sync_objects.sql`).
#[sqlx::test(migrations = "./migrations")]
async fn edit_after_compaction_is_accepted_not_rejected(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "finn@example.com").await;
    let (_device_a, token_a) = register_device(&server, "finn@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    upload(
        &server,
        &token_a,
        bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example"),
    )
    .await;

    // Ack and compact, which deletes the object's `create` row.
    sync_device(&server, &token_a).await;

    let user_id = user_id_for_email(&pool, "finn@example.com").await;
    compaction::run_once(&state).await.unwrap();
    assert_eq!(
        count_operations(&pool, user_id).await,
        0,
        "the create op's raw row must be gone after compaction, same as the existing cursor_too_old test proves"
    );
    assert_eq!(count_snapshots(&pool, user_id).await, 1);

    // The ledger row survived compaction.
    let ledger_rows: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "c!" FROM sync_objects WHERE user_id = $1 AND object_id = $2"#,
        user_id,
        object_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(ledger_rows, 1);

    // A plain `update` to the compacted object is accepted.
    let rename_op = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 2,
        "lamportTimestamp": 2,
        "objectType": "bookmark",
        "objectId": object_id,
        "operationType": "update",
        "encryptionVersion": 0,
        "payload": { "title": "Renamed after compaction" }
    });
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_a)
        .json(&json!({ "operations": [rename_op] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(
        body["rejected"].as_array().unwrap().len(),
        0,
        "the rename must not be rejected: {body}"
    );
    assert_eq!(body["accepted"].as_array().unwrap().len(), 1);
}

/// After compaction deletes all of a device's rows, an old `device_sequence`
/// must still not be accepted again (it's reported `duplicate`). The last
/// sequence is stored on `devices` (migration `0009_devices_last_sequence.sql`).
#[sqlx::test(migrations = "./migrations")]
async fn device_sequence_does_not_reset_after_full_compaction(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "gwen@example.com").await;
    let (_device_a, token_a) = register_device(&server, "gwen@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    // Two ops: sequence 1 (create) and 2 (update).
    upload(
        &server,
        &token_a,
        bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example"),
    )
    .await;
    upload(
        &server,
        &token_a,
        bookmark_op(Uuid::now_v7(), object_id, 2, 2, "Renamed"),
    )
    .await;

    // Ack and compact, removing all of this device's rows.
    sync_device(&server, &token_a).await;

    let user_id = user_id_for_email(&pool, "gwen@example.com").await;
    compaction::run_once(&state).await.unwrap();
    assert_eq!(
        count_operations(&pool, user_id).await,
        0,
        "every one of this device's rows must be gone after compaction — the precondition for the bug this test guards against"
    );

    // Reuse sequence 2 on a new object (so ownership can't be the reason).
    // It must be `duplicate`, never accepted.
    let replayed_op = bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 2, 3, "Replayed");
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_a)
        .json(&json!({ "operations": [replayed_op] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(
        body["accepted"].as_array().unwrap().len(),
        0,
        "a replayed device_sequence must never be accepted, compacted or not: {body}"
    );
    assert_eq!(
        body["rejected"].as_array().unwrap().len(),
        0,
        "a replay of an already-accepted sequence is `duplicate`, not `rejected`: {body}"
    );
    let duplicate = body["duplicate"].as_array().unwrap();
    assert_eq!(duplicate.len(), 1);
    assert_eq!(duplicate[0], replayed_op["operationId"]);

    // A higher sequence on a new object still works.
    let mut next_op = bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 4, "Still works");
    next_op["deviceSequence"] = json!(3);
    let res2 = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_a)
        .json(&json!({ "operations": [next_op] }))
        .await;
    res2.assert_status_ok();
    let body2: serde_json::Value = res2.json();
    assert_eq!(body2["accepted"].as_array().unwrap().len(), 1, "{body2}");
}

/// A client retries an upload it never got a response for, after
/// compaction removed the row. With the same `operationId`, the retry must
/// be `duplicate`, not `sequence_conflict`.
#[sqlx::test(migrations = "./migrations")]
async fn retry_of_compacted_upload_is_reported_duplicate_not_sequence_conflict(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "hana@example.com").await;
    let (_device_a, token_a) = register_device(&server, "hana@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    let op_id = Uuid::now_v7();
    let op = bookmark_op(op_id, object_id, 1, 1, "Example");
    upload(&server, &token_a, op.clone()).await;

    // Ack and compact, removing the op's row.
    sync_device(&server, &token_a).await;
    let user_id = user_id_for_email(&pool, "hana@example.com").await;
    compaction::run_once(&state).await.unwrap();
    assert_eq!(
        count_operations(&pool, user_id).await,
        0,
        "op's row must be gone after compaction — the precondition for the bug this test guards against"
    );

    // Retry the exact same op.
    let res = server
        .post("/api/v1/sync/operations")
        .authorization_bearer(&token_a)
        .json(&json!({ "operations": [op] }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(
        body["accepted"].as_array().unwrap().len(),
        0,
        "a retry of an already-accepted, now-compacted op must not be accepted again: {body}"
    );
    assert_eq!(
        body["rejected"].as_array().unwrap().len(),
        0,
        "the retry must not look like a conflict to the client: {body}"
    );
    let duplicate = body["duplicate"].as_array().unwrap();
    assert_eq!(duplicate.len(), 1);
    assert_eq!(duplicate[0], op_id.to_string());
}

/// A device that never acks stops blocking compaction once it's inactive
/// past the grace period (docs/protocol.md §11). If it returns, it gets
/// `cursor_too_old`.
#[sqlx::test(migrations = "./migrations")]
async fn stale_never_revoked_device_ages_out_of_compaction_boundary(pool: PgPool) {
    // Short grace period; we backdate the device instead of waiting.
    let state = state_with_inactive_device_grace_period(pool.clone(), 60);
    let server = server_for_state(state.clone());

    register_and_login(&server, "gale@example.com").await;
    let (_device_a, token_a) = register_device(&server, "gale@example.com", "Laptop").await;
    // Device B registers and never syncs (an abandoned device).
    let (device_b, _token_b) = register_device(&server, "gale@example.com", "Phone").await;

    let object_id = Uuid::now_v7();
    upload(
        &server,
        &token_a,
        bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example"),
    )
    .await;

    // Device A acknowledges past the only operation; device B never does.
    sync_device(&server, &token_a).await;

    let user_id = user_id_for_email(&pool, "gale@example.com").await;
    assert_eq!(count_operations(&pool, user_id).await, 1);

    // Backdate device B's `created_at` and `last_seen_at` past the grace
    // period (raw SQL; there's no API for this).
    sqlx::query(
        "UPDATE devices SET created_at = now() - INTERVAL '1 hour', last_seen_at = now() - INTERVAL '1 hour' \
         WHERE id = $1::uuid",
    )
    .bind(&device_b)
    .execute(&pool)
    .await
    .unwrap();

    compaction::run_once(&state).await.unwrap();

    // B no longer blocks, so everything up to A's ack is compacted.
    assert_eq!(count_operations(&pool, user_id).await, 0);
    assert_eq!(count_snapshots(&pool, user_id).await, 1);

    let snapshot_cursor: i64 = sqlx::query_scalar!(
        "SELECT snapshot_cursor FROM sync_snapshots WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(snapshot_cursor, 1);
}

/// A device that never called `/changes` stops blocking compaction after
/// the short never-synced grace period, even while the inactive-device
/// grace period (30 days) hasn't passed. Uploads alone would keep it
/// looking active.
#[sqlx::test(migrations = "./migrations")]
async fn never_synced_device_ages_out_of_compaction_boundary_on_its_own_clock(pool: PgPool) {
    // Short grace period so the test doesn't wait 24 hours.
    let state = state_with_never_synced_device_grace_period(pool.clone(), 60);
    let server = server_for_state(state.clone());

    register_and_login(&server, "orin@example.com").await;
    let (_device_a, token_a) = register_device(&server, "orin@example.com", "Laptop").await;
    // Device B registers and never calls `/changes`.
    let (device_b, _token_b) = register_device(&server, "orin@example.com", "Phone").await;

    let object_id = Uuid::now_v7();
    upload(
        &server,
        &token_a,
        bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example"),
    )
    .await;

    // Device A acknowledges past the only operation; device B never does.
    sync_device(&server, &token_a).await;

    let user_id = user_id_for_email(&pool, "orin@example.com").await;
    assert_eq!(count_operations(&pool, user_id).await, 1);

    // Backdate only `created_at`, past the never-synced period but inside
    // the inactive period. So only the never-synced rule can exclude B.
    sqlx::query("UPDATE devices SET created_at = now() - INTERVAL '2 minutes' WHERE id = $1::uuid")
        .bind(&device_b)
        .execute(&pool)
        .await
        .unwrap();

    compaction::run_once(&state).await.unwrap();

    // B no longer blocks compaction.
    assert_eq!(count_operations(&pool, user_id).await, 0);
    assert_eq!(count_snapshots(&pool, user_id).await, 1);

    let snapshot_cursor: i64 = sqlx::query_scalar!(
        "SELECT snapshot_cursor FROM sync_snapshots WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(snapshot_cursor, 1);
}

/// Old snapshot rows (from migration `0008_compress_sync_snapshots.sql`) are
/// plain JSON, not gzip. `/snapshot` must still read them.
#[sqlx::test(migrations = "./migrations")]
async fn snapshot_route_falls_back_to_uncompressed_legacy_data(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "iris@example.com").await;
    let (_device_a, token_a) = register_device(&server, "iris@example.com", "Laptop").await;

    let user_id = user_id_for_email(&pool, "iris@example.com").await;

    let object_id = Uuid::now_v7();
    let legacy_objects = vec![SnapshotObject {
        object_type: "bookmark".to_string(),
        object_id,
        operation_type: "create".to_string(),
        encryption_version: 0,
        payload: json!({ "title": "Legacy bookmark", "url": "https://example.com", "parent": null, "position": "a0" }),
        created_at: Utc::now(),
        visit_count: None,
        lamport_timestamp: 0,
        device_id: Uuid::nil(),
        operation_id: Uuid::nil(),
    }];
    // Plain JSON, like rows left by migration 0008.
    let legacy_bytes = serde_json::to_vec(&legacy_objects).unwrap();

    sqlx::query(
        "INSERT INTO sync_snapshots (user_id, snapshot_cursor, encryption_version, data) VALUES ($1, $2, 0, $3)",
    )
    .bind(user_id)
    .bind(1i64)
    .bind(&legacy_bytes)
    .execute(&pool)
    .await
    .unwrap();

    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&token_a)
        .await;
    snapshot_res.assert_status_ok();
    let snapshot: serde_json::Value = snapshot_res.json();
    let objects = snapshot["objects"].as_array().unwrap();
    assert_eq!(
        objects.len(),
        1,
        "legacy uncompressed row must still be readable: {snapshot}"
    );
    assert_eq!(objects[0]["objectId"], json!(object_id));
    assert_eq!(objects[0]["payload"]["title"], json!("Legacy bookmark"));
    assert_eq!(snapshot["snapshotCursor"].as_i64().unwrap(), 1);
}

/// A historyVisit stored in a saved snapshot must still be dropped once it's
/// older than the retention window. The snapshot is inserted with raw SQL.
#[sqlx::test(migrations = "./migrations")]
async fn expired_history_visit_baked_into_base_snapshot_is_pruned(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "juno@example.com").await;
    let (_device_a, token_a) = register_device(&server, "juno@example.com", "Laptop").await;

    let user_id = user_id_for_email(&pool, "juno@example.com").await;

    server
        .patch("/api/v1/sync/settings")
        .authorization_bearer(&token_a)
        .json(&json!({ "historyRetention": "7d" }))
        .await
        .assert_status_ok();

    let old_visit_id = Uuid::now_v7();
    let recent_visit_id = Uuid::now_v7();
    let bookmark_id = Uuid::now_v7();
    let base_objects = vec![
        SnapshotObject {
            object_type: "historyVisit".to_string(),
            object_id: old_visit_id,
            operation_type: "visit".to_string(),
            encryption_version: 0,
            payload: json!({ "url": "https://old.example.com" }),
            // Outside the 7-day window.
            created_at: Utc::now() - chrono::Duration::days(30),
            visit_count: None,
            lamport_timestamp: 0,
            device_id: Uuid::nil(),
            operation_id: Uuid::nil(),
        },
        SnapshotObject {
            object_type: "historyVisit".to_string(),
            object_id: recent_visit_id,
            operation_type: "visit".to_string(),
            encryption_version: 0,
            payload: json!({ "url": "https://recent.example.com" }),
            // Inside the window.
            created_at: Utc::now() - chrono::Duration::days(1),
            visit_count: None,
            lamport_timestamp: 0,
            device_id: Uuid::nil(),
            operation_id: Uuid::nil(),
        },
        SnapshotObject {
            object_type: "bookmark".to_string(),
            object_id: bookmark_id,
            operation_type: "create".to_string(),
            encryption_version: 0,
            payload: json!({ "title": "Old bookmark", "url": "https://example.com", "parent": null, "position": "a0" }),
            // Also old, but kept: retention only applies to historyVisit.
            created_at: Utc::now() - chrono::Duration::days(30),
            visit_count: None,
            lamport_timestamp: 0,
            device_id: Uuid::nil(),
            operation_id: Uuid::nil(),
        },
    ];
    let base_bytes = serde_json::to_vec(&base_objects).unwrap();

    sqlx::query(
        "INSERT INTO sync_snapshots (user_id, snapshot_cursor, encryption_version, data) VALUES ($1, $2, 0, $3)",
    )
    .bind(user_id)
    .bind(1i64)
    .bind(&base_bytes)
    .execute(&pool)
    .await
    .unwrap();

    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&token_a)
        .await;
    snapshot_res.assert_status_ok();
    let snapshot: serde_json::Value = snapshot_res.json();
    let objects = snapshot["objects"].as_array().unwrap();
    let object_ids: Vec<serde_json::Value> =
        objects.iter().map(|o| o["objectId"].clone()).collect();

    assert!(
        !object_ids.contains(&json!(old_visit_id)),
        "expired historyVisit baked into the base snapshot must be pruned: {snapshot}"
    );
    assert!(
        object_ids.contains(&json!(recent_visit_id)),
        "historyVisit still within retention must survive: {snapshot}"
    );
    assert!(
        object_ids.contains(&json!(bookmark_id)),
        "non-historyVisit object types must never be pruned by history_cutoff: {snapshot}"
    );
    assert_eq!(objects.len(), 2);
}

/// Deletes run in chunks (5,000 rows). With 12,000 rows (three chunks), the
/// result must match one big delete: all rows gone, one snapshot.
///
/// Rows are inserted with SQL; uploading them over HTTP would be slow.
#[sqlx::test(migrations = "./migrations")]
async fn chunked_delete_drains_backlog_larger_than_one_chunk(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "hugo@example.com").await;
    let (device_a, _token_a) = register_device(&server, "hugo@example.com", "Laptop").await;

    let user_id = user_id_for_email(&pool, "hugo@example.com").await;
    let device_id: Uuid = device_a.parse().unwrap();

    const OP_COUNT: i64 = 12_000;
    let object_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO sync_operations \
            (operation_id, user_id, device_id, device_sequence, lamport_timestamp, server_cursor, \
             object_type, object_id, operation_type, encryption_version, payload) \
         SELECT gen_random_uuid(), $1, $2, seq, seq, seq, 'bookmark', $3, \
             CASE WHEN seq = 1 THEN 'create' ELSE 'update' END, 0, \
             CASE WHEN seq = 1 \
                 THEN jsonb_build_object('title', 'Example', 'url', 'https://example.com', 'parent', NULL, 'position', 'a0') \
                 ELSE jsonb_build_object('title', 'Title ' || seq) \
             END \
         FROM generate_series(1, $4::bigint) AS seq",
    )
    .bind(user_id)
    .bind(device_id)
    .bind(object_id)
    .bind(OP_COUNT)
    .execute(&pool)
    .await
    .unwrap();

    // Ack every op for this device directly.
    sqlx::query("INSERT INTO sync_cursors (user_id, device_id, cursor_value) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(device_id)
        .bind(OP_COUNT)
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(count_operations(&pool, user_id).await, OP_COUNT);

    compaction::run_once(&state).await.unwrap();

    // All ops gone and one snapshot written, so the loop ran past the first chunk.
    assert_eq!(count_operations(&pool, user_id).await, 0);
    assert_eq!(count_snapshots(&pool, user_id).await, 1);

    let snapshot_cursor: i64 = sqlx::query_scalar!(
        "SELECT snapshot_cursor FROM sync_snapshots WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(snapshot_cursor, OP_COUNT);
}

/// An upload during compaction must not wait on the chunked delete loop.
/// The `sync_stats` transaction now commits before the loop starts.
///
/// This is a smoke test (it would hang on a deadlock), not a timing test.
/// The final row counts are exact, since both cursors are set beforehand.
#[sqlx::test(migrations = "./migrations")]
async fn concurrent_upload_is_not_blocked_by_compaction_delete_phase(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "concurrent@example.com").await;
    let (device_a, _token_a) = register_device(&server, "concurrent@example.com", "Laptop").await;
    let (device_b, token_b) = register_device(&server, "concurrent@example.com", "Phone").await;

    let user_id = user_id_for_email(&pool, "concurrent@example.com").await;
    let device_id: Uuid = device_a.parse().unwrap();
    let device_b_id: Uuid = device_b.parse().unwrap();

    const OP_COUNT: i64 = 12_000;
    let object_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO sync_operations \
            (operation_id, user_id, device_id, device_sequence, lamport_timestamp, server_cursor, \
             object_type, object_id, operation_type, encryption_version, payload) \
         SELECT gen_random_uuid(), $1, $2, seq, seq, seq, 'bookmark', $3, \
             CASE WHEN seq = 1 THEN 'create' ELSE 'update' END, 0, \
             CASE WHEN seq = 1 \
                 THEN jsonb_build_object('title', 'Example', 'url', 'https://example.com', 'parent', NULL, 'position', 'a0') \
                 ELSE jsonb_build_object('title', 'Title ' || seq) \
             END \
         FROM generate_series(1, $4::bigint) AS seq",
    )
    .bind(user_id)
    .bind(device_id)
    .bind(object_id)
    .bind(OP_COUNT)
    .execute(&pool)
    .await
    .unwrap();

    // The rows were inserted with SQL, so also move the account's cursor
    // allocator to `OP_COUNT`. Otherwise the upload below would reuse cursor 1.
    sqlx::query(
        "INSERT INTO sync_cursors (user_id, device_id, cursor_value) VALUES ($1, NULL, $2)",
    )
    .bind(user_id)
    .bind(OP_COUNT)
    .execute(&pool)
    .await
    .unwrap();

    // Ack the backlog from both devices directly. `/changes` only acks one
    // 500-op page per call.
    sqlx::query("INSERT INTO sync_cursors (user_id, device_id, cursor_value) VALUES ($1, $2, $3), ($1, $4, $3)")
        .bind(user_id)
        .bind(device_id)
        .bind(OP_COUNT)
        .bind(device_b_id)
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(count_operations(&pool, user_id).await, OP_COUNT);

    // Run compaction and an upload from device_b at the same time.
    let compaction_state = state.clone();
    let compaction_task =
        tokio::spawn(async move { compaction::run_once(&compaction_state).await });

    let upload_op = bookmark_op(Uuid::now_v7(), Uuid::now_v7(), 1, 1, "Concurrent upload");
    let upload_result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        upload(&server, &token_b, upload_op),
    )
    .await;
    assert!(
        upload_result.is_ok(),
        "concurrent upload should not be blocked for the duration of compaction's delete phase"
    );

    compaction_task.await.unwrap().unwrap();

    // All backlog ops are gone; only the new upload (above the boundary) remains.
    assert_eq!(count_operations(&pool, user_id).await, 1);
    assert_eq!(count_snapshots(&pool, user_id).await, 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn prune_compacted_operations_tolerates_preexisting_temp_table_and_connection_reuse(
    pool: PgPool,
) {
    let single_conn_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let state = state_for(single_conn_pool.clone());

    let setup_server = server_for_state(state_for(pool.clone()));
    register_and_login(&setup_server, "collision_test@example.com").await;
    let (_device_id, token) =
        register_device(&setup_server, "collision_test@example.com", "TestDevice").await;
    let user_id = user_id_for_email(&pool, "collision_test@example.com").await;

    let object_id = Uuid::now_v7();
    let op1 = bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Bookmark 1");
    let op2 = bookmark_op(Uuid::now_v7(), object_id, 2, 2, "Bookmark 2");
    upload(&setup_server, &token, op1).await;
    upload(&setup_server, &token, op2).await;

    assert_eq!(count_operations(&pool, user_id).await, 2);

    let op1_row_id: i64 = sqlx::query_scalar!(
        "SELECT id FROM sync_operations WHERE user_id = $1 AND server_cursor = 1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    // 1. A cancelled run left the temp table behind with a survivor id.
    {
        let mut conn = single_conn_pool.acquire().await.unwrap();
        sqlx::query(
            "CREATE TEMPORARY TABLE compaction_survivor_ids (id BIGINT PRIMARY KEY) ON COMMIT PRESERVE ROWS",
        )
        .execute(&mut *conn)
        .await
        .unwrap();

        // Leftover survivor row: without TRUNCATE, op1 would not be pruned.
        sqlx::query("INSERT INTO compaction_survivor_ids (id) VALUES ($1)")
            .bind(op1_row_id)
            .execute(&mut *conn)
            .await
            .unwrap();
    }

    // Prune on the same connection. `IF NOT EXISTS` and `TRUNCATE` make this
    // work and op1 gets pruned.
    compaction::prune_compacted_operations(&state, user_id, 1)
        .await
        .expect("prune_compacted_operations must succeed when temporary table already exists");

    assert_eq!(count_operations(&pool, user_id).await, 1);

    // 2. Run again with the table left behind once more.
    {
        let mut conn = single_conn_pool.acquire().await.unwrap();
        sqlx::query(
            "CREATE TEMPORARY TABLE IF NOT EXISTS compaction_survivor_ids (id BIGINT PRIMARY KEY) ON COMMIT PRESERVE ROWS",
        )
        .execute(&mut *conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO compaction_survivor_ids (id) VALUES (999999)")
            .execute(&mut *conn)
            .await
            .unwrap();
    }

    compaction::prune_compacted_operations(&state, user_id, 2)
        .await
        .expect("second call to prune_compacted_operations must succeed on same connection without dropping");

    assert_eq!(count_operations(&pool, user_id).await, 0);

    // 3. Run once more after normal cleanup.
    compaction::prune_compacted_operations(&state, user_id, 2)
        .await
        .expect("subsequent prune_compacted_operations call must succeed");
}

/// Large backlogs must not hog pool connections:
/// 1. A pass stops at `MAX_PRUNED_PER_PASS` (50,000); the rest waits.
/// 2. It sleeps `PRUNE_COOPERATIVE_DELAY` between chunks, so other tasks
///    can get connections.
#[sqlx::test(migrations = "./migrations")]
async fn prune_compacted_operations_respects_per_pass_limit_and_cooperative_yield(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "prune_limit@example.com").await;
    let (device_a, _token_a) = register_device(&server, "prune_limit@example.com", "Laptop").await;

    let user_id = user_id_for_email(&pool, "prune_limit@example.com").await;
    let device_id: Uuid = device_a.parse().unwrap();

    const OP_COUNT: i64 = compaction::MAX_PRUNED_PER_PASS + 5_000;
    let object_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO sync_operations \
            (operation_id, user_id, device_id, device_sequence, lamport_timestamp, server_cursor, \
             object_type, object_id, operation_type, encryption_version, payload) \
         SELECT gen_random_uuid(), $1, $2, seq, seq, seq, 'bookmark', $3, \
             CASE WHEN seq = 1 THEN 'create' ELSE 'update' END, 0, \
             CASE WHEN seq = 1 \
                 THEN jsonb_build_object('title', 'Example', 'url', 'https://example.com', 'parent', NULL, 'position', 'a0') \
                 ELSE jsonb_build_object('title', 'Title ' || seq) \
             END \
         FROM generate_series(1, $4::bigint) AS seq",
    )
    .bind(user_id)
    .bind(device_id)
    .bind(object_id)
    .bind(OP_COUNT)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("INSERT INTO sync_cursors (user_id, device_id, cursor_value) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(device_id)
        .bind(OP_COUNT)
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(count_operations(&pool, user_id).await, OP_COUNT);

    // Meanwhile, other tasks can still get connections and run queries.
    let probe_pool = pool.clone();
    let probe_task = tokio::spawn(async move {
        // Let pruning start first.
        tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        let mut conn =
            tokio::time::timeout(std::time::Duration::from_secs(2), probe_pool.acquire())
                .await
                .expect("connection checkout should not time out")
                .expect("connection checkout should succeed");

        let val: i32 = sqlx::query_scalar("SELECT 1")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        assert_eq!(val, 1);
    });

    // Pass 1 prunes exactly 50,000 and leaves 5,000.
    compaction::prune_compacted_operations(&state, user_id, OP_COUNT)
        .await
        .expect("first pass of prune_compacted_operations should succeed");

    probe_task.await.unwrap();

    let remaining_after_pass1 = count_operations(&pool, user_id).await;
    assert_eq!(
        remaining_after_pass1, 5_000,
        "first pass must cap deletions at MAX_PRUNED_PER_PASS (50,000), leaving 5,000 operations"
    );

    // Pass 2 prunes the rest.
    compaction::prune_compacted_operations(&state, user_id, OP_COUNT)
        .await
        .expect("second pass of prune_compacted_operations should succeed");

    let remaining_after_pass2 = count_operations(&pool, user_id).await;
    assert_eq!(
        remaining_after_pass2, 0,
        "second pass should delete the remaining 5,000 operations"
    );
}

/// If the first compaction hit `MAX_PRUNED_PER_PASS` and the account then
/// went quiet, later passes must still prune the rest. Runs through
/// `compaction::run_once` so the new-ops threshold is involved.
#[sqlx::test(migrations = "./migrations")]
async fn idle_account_still_drains_backlog_stranded_by_per_pass_cap(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "idle_drain@example.com").await;
    let (device_a, _token_a) = register_device(&server, "idle_drain@example.com", "Laptop").await;

    let user_id = user_id_for_email(&pool, "idle_drain@example.com").await;
    let device_id: Uuid = device_a.parse().unwrap();

    const OP_COUNT: i64 = compaction::MAX_PRUNED_PER_PASS + 5_000;
    let object_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO sync_operations \
            (operation_id, user_id, device_id, device_sequence, lamport_timestamp, server_cursor, \
             object_type, object_id, operation_type, encryption_version, payload) \
         SELECT gen_random_uuid(), $1, $2, seq, seq, seq, 'bookmark', $3, \
             CASE WHEN seq = 1 THEN 'create' ELSE 'update' END, 0, \
             CASE WHEN seq = 1 \
                 THEN jsonb_build_object('title', 'Example', 'url', 'https://example.com', 'parent', NULL, 'position', 'a0') \
                 ELSE jsonb_build_object('title', 'Title ' || seq) \
             END \
         FROM generate_series(1, $4::bigint) AS seq",
    )
    .bind(user_id)
    .bind(device_id)
    .bind(object_id)
    .bind(OP_COUNT)
    .execute(&pool)
    .await
    .unwrap();

    // Ack everything once, then go quiet.
    sqlx::query("INSERT INTO sync_cursors (user_id, device_id, cursor_value) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(device_id)
        .bind(OP_COUNT)
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(count_operations(&pool, user_id).await, OP_COUNT);

    // Pass 1: no snapshot yet, so it runs. Pruning stops at MAX_PRUNED_PER_PASS.
    compaction::run_once(&state).await.unwrap();
    assert_eq!(
        count_operations(&pool, user_id).await,
        5_000,
        "first pass must cap deletions at MAX_PRUNED_PER_PASS, leaving 5,000 operations"
    );

    // Later passes: nothing new, so the rebuild is skipped, but the
    // prune must still drain the rest.
    for _ in 0..2 {
        compaction::run_once(&state).await.unwrap();
    }

    assert_eq!(
        count_operations(&pool, user_id).await,
        0,
        "backlog stranded by the per-pass cap must fully drain even once the account goes idle"
    );
}

/// A delete with a lower Lamport time than an update must not remove the
/// object (docs/protocol.md §8.2). A deletes at lamport 5 offline; B
/// updates at lamport 10 first; then A uploads its delete. The object must
/// stay in `/snapshot`, before and after compaction.
#[sqlx::test(migrations = "./migrations")]
async fn stale_lamport_delete_does_not_erase_a_later_concurrent_update(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "remy@example.com").await;
    let (_device_a, token_a) = register_device(&server, "remy@example.com", "Laptop").await;
    let (_device_b, token_b) = register_device(&server, "remy@example.com", "Phone").await;

    let object_id = Uuid::now_v7();
    upload(
        &server,
        &token_a,
        bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Original"),
    )
    .await;

    // B's update arrives first, with a higher lamport.
    let update_op = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 1,
        "lamportTimestamp": 10,
        "objectType": "bookmark",
        "objectId": object_id,
        "operationType": "update",
        "encryptionVersion": 0,
        "payload": { "title": "Updated by B" }
    });
    upload(&server, &token_b, update_op).await;

    // A uploads its older delete.
    let delete_op = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 2,
        "lamportTimestamp": 5,
        "objectType": "bookmark",
        "objectId": object_id,
        "operationType": "delete",
        "encryptionVersion": 0,
        "payload": {}
    });
    upload(&server, &token_a, delete_op).await;

    sync_device(&server, &token_a).await;
    sync_device(&server, &token_b).await;

    let assert_object_survives = |snapshot: &serde_json::Value| {
        let objects = snapshot["objects"].as_array().unwrap();
        assert_eq!(
            objects.len(),
            1,
            "the update-won object must still be present: {snapshot}"
        );
        assert_eq!(objects[0]["objectId"], json!(object_id));
        assert_eq!(objects[0]["payload"]["title"], json!("Updated by B"));
        // The tombstone is still stored (§8.2, §8.7); it just doesn't hide
        // the object.
        let tombstones = snapshot["tombstones"].as_array().unwrap();
        assert_eq!(tombstones.len(), 1);
        assert_eq!(tombstones[0]["objectId"], json!(object_id));
    };

    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&token_a)
        .await;
    snapshot_res.assert_status_ok();
    assert_object_survives(&snapshot_res.json());

    compaction::run_once(&state).await.unwrap();

    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&token_a)
        .await;
    snapshot_res.assert_status_ok();
    assert_object_survives(&snapshot_res.json());
}

/// A closed tab must not come back after housekeeping deletes its tombstone
/// by age, even if compaction never caught up. Uses `housekeeping::run_once`
/// to delete the tombstone.
#[sqlx::test(migrations = "./migrations")]
async fn closed_tab_does_not_resurrect_after_its_tombstone_ages_out(pool: PgPool) {
    let mut config = test_config();
    config.ephemeral_tombstone_retention_secs = 60 * 60 * 24 * 30; // 30 days
    let state = AppState {
        db: pool.clone(),
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
    let server = server_for_state(state.clone());

    register_and_login(&server, "zoe@example.com").await;
    let (_device_a, token_a) = register_device(&server, "zoe@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    let create_op = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 1,
        "lamportTimestamp": 1,
        "objectType": "tab",
        "objectId": object_id,
        "operationType": "create",
        "encryptionVersion": 0,
        "payload": { "title": "Example", "url": "https://example.com", "index": 0, "windowId": Uuid::now_v7() }
    });
    upload(&server, &token_a, create_op).await;

    let close_op = json!({
        "operationId": Uuid::now_v7(),
        "deviceSequence": 2,
        "lamportTimestamp": 2,
        "objectType": "tab",
        "objectId": object_id,
        "operationType": "close",
        "encryptionVersion": 0,
        "payload": {}
    });
    upload(&server, &token_a, close_op).await;

    // The tab is already gone from the snapshot.
    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&token_a)
        .await;
    snapshot_res.assert_status_ok();
    assert!(
        snapshot_res.json::<serde_json::Value>()["objects"]
            .as_array()
            .unwrap()
            .is_empty(),
        "closed tab must not appear in snapshot while its tombstone is still active"
    );

    let user_id = user_id_for_email(&pool, "zoe@example.com").await;

    // Device A never acks past the close, so compaction stays at 0.
    // Backdate the tombstone past the 30-day window so housekeeping deletes it.
    sqlx::query!(
        "UPDATE tombstones SET created_at = now() - INTERVAL '31 days' \
         WHERE user_id = $1 AND object_type = 'tab'",
        user_id
    )
    .execute(&pool)
    .await
    .unwrap();

    let tombstones_before: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "c!" FROM tombstones WHERE user_id = $1"#,
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(tombstones_before, 1);

    housekeeping::run_once(&state).await;

    let tombstones_after: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "c!" FROM tombstones WHERE user_id = $1"#,
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        tombstones_after, 0,
        "housekeeping must have pruned the aged-out tab tombstone"
    );

    // The tombstone is gone, but the winning `close` op still hides the tab.
    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&token_a)
        .await;
    snapshot_res.assert_status_ok();
    let snapshot: serde_json::Value = snapshot_res.json();
    assert!(
        snapshot["objects"].as_array().unwrap().is_empty(),
        "closed tab must stay absent from snapshot even after its tombstone is pruned: {snapshot}"
    );

    // Compaction must not add the tab back, and `tab_count` stays 0.
    compaction::run_once(&state).await.unwrap();
    let tab_count: i64 = sqlx::query_scalar!(
        r#"SELECT tab_count as "c!" FROM sync_stats WHERE user_id = $1"#,
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        tab_count, 0,
        "compaction must not persist the zombie tab into sync_stats.tab_count"
    );
}

/// After compaction, `sync_stats.bookmark_count` must match `/snapshot`,
/// even when one device lags so the ack boundary is below the latest ops.
#[sqlx::test(migrations = "./migrations")]
async fn compaction_with_lagging_device_keeps_stats_equal_to_snapshot(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "wren@example.com").await;
    let (_device_a, token_a) = register_device(&server, "wren@example.com", "Laptop").await;
    let (_device_b, token_b) = register_device(&server, "wren@example.com", "Phone").await;

    // Each bookmark is a new object, so every op is a `create` (`bookmark_op`
    // only makes a create when `seq == 1`).
    fn create_bookmark_op(object_id: Uuid, seq: i64, title: &str) -> serde_json::Value {
        json!({
            "operationId": Uuid::now_v7(),
            "deviceSequence": seq,
            "lamportTimestamp": seq,
            "objectType": "bookmark",
            "objectId": object_id,
            "operationType": "create",
            "encryptionVersion": 0,
            "payload": { "title": title, "url": "https://example.com", "parent": null, "position": "a0" }
        })
    }

    // A creates the first bookmarks and both devices ack them.
    const ACKED_BOOKMARKS: i64 = 3;
    for seq in 1..=ACKED_BOOKMARKS {
        let object_id = Uuid::now_v7();
        upload(
            &server,
            &token_a,
            create_bookmark_op(object_id, seq, &format!("Acked {seq}")),
        )
        .await;
    }
    sync_device(&server, &token_a).await;
    sync_device(&server, &token_b).await;

    // A creates more, but B never syncs again, so the boundary stays at
    // `ACKED_BOOKMARKS`. `/snapshot` already shows the new ones.
    const LAGGING_BOOKMARKS: i64 = 5;
    for i in 0..LAGGING_BOOKMARKS {
        let seq = ACKED_BOOKMARKS + 1 + i;
        let object_id = Uuid::now_v7();
        upload(
            &server,
            &token_a,
            create_bookmark_op(object_id, seq, &format!("Lagging {i}")),
        )
        .await;
    }

    let user_id = user_id_for_email(&pool, "wren@example.com").await;

    // First compaction for this user, so the threshold doesn't apply.
    compaction::run_once(&state).await.unwrap();

    // The snapshot stops at the ack boundary (that part was always right).
    let snapshot_cursor: i64 = sqlx::query_scalar!(
        "SELECT snapshot_cursor FROM sync_snapshots WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        snapshot_cursor, ACKED_BOOKMARKS,
        "the persisted snapshot must still stop at the ack boundary, not the account's true head"
    );

    let (bookmark_count, _, _) = {
        let row = sqlx::query!(
            "SELECT bookmark_count, history_visit_count, tab_count FROM sync_stats WHERE user_id = $1",
            user_id
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        (row.bookmark_count, row.history_visit_count, row.tab_count)
    };

    // `/snapshot` always computes "as of now"; compare against it.
    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&token_a)
        .await;
    snapshot_res.assert_status_ok();
    let snapshot: serde_json::Value = snapshot_res.json();
    let live_bookmark_count = snapshot["objects"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| o["objectType"] == "bookmark")
        .count() as i64;

    assert_eq!(
        live_bookmark_count,
        ACKED_BOOKMARKS + LAGGING_BOOKMARKS,
        "sanity check: every created bookmark must actually be live"
    );
    assert_eq!(
        bookmark_count, live_bookmark_count,
        "sync_stats.bookmark_count must equal what /snapshot reports, not just the ack-boundary-scoped subset \
         (got {bookmark_count}, snapshot has {live_bookmark_count})"
    );
}

/// Bulk op builder mirroring `sync_flow.rs`'s `bulk_history_op` (kept local
/// rather than shared across the two test binaries, matching how the rest
/// of this file already duplicates its own small op builders).
fn bulk_history_op(op_id: Uuid, object_id: Uuid, seq: i64, visit_count: i64) -> serde_json::Value {
    json!({
        "operationId": op_id,
        "deviceSequence": seq,
        "lamportTimestamp": seq,
        "objectType": "historyVisit",
        "objectId": object_id,
        "operationType": "bulkImport",
        "encryptionVersion": 0,
        "payload": { "v": 1, "bulkVersion": 1, "visitCount": visit_count, "segments": [] },
        "visitCount": visit_count
    })
}

/// Compaction self-heal (fix.md §3/§7 test 4): a bulk history chunk that was
/// folded into a snapshot *before* the permanent-dedup fix shipped has no
/// `sync_objects` ledger row for it — simulated here by deleting the row
/// `compact_user`'s own self-heal insert just wrote on the first compaction
/// pass. A later compaction pass (forced here by pushing the ack boundary
/// past `MIN_NEW_OPERATIONS_TO_COMPACT` with 200 filler bookmark ops, so the
/// early-return gate in `compact_user` doesn't skip the recompute) must
/// insert the ledger row back, `ON CONFLICT DO NOTHING`, from the object set
/// it folds into the new snapshot — without needing any `sync_operations`
/// row for the bulk op to still exist.
#[sqlx::test(migrations = "./migrations")]
async fn compaction_self_heals_missing_bulk_ledger_row(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());
    register_and_login(&server, "self-heal@example.com").await;
    let (_device_id, access_token) =
        register_device(&server, "self-heal@example.com", "Laptop").await;
    let user_id = user_id_for_email(&pool, "self-heal@example.com").await;

    let object_id = Uuid::now_v7();
    upload(
        &server,
        &access_token,
        bulk_history_op(Uuid::now_v7(), object_id, 1, 42),
    )
    .await;
    sync_device(&server, &access_token).await;
    compaction::run_once(&state).await.unwrap();

    // Sanity check: the first compaction's own self-heal already wrote the
    // ledger row (the bulk object was live, so it's in the folded set).
    let row_after_first_compaction: Option<Uuid> = sqlx::query_scalar!(
        "SELECT object_id FROM sync_objects WHERE user_id = $1 AND object_type = 'historyVisit' AND object_id = $2",
        user_id,
        object_id
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(row_after_first_compaction.is_some());

    // Simulate pre-deploy state: the row is gone, but the object is still
    // folded into the persisted snapshot from the compaction above.
    sqlx::query!(
        "DELETE FROM sync_objects WHERE user_id = $1 AND object_type = 'historyVisit' AND object_id = $2",
        user_id,
        object_id
    )
    .execute(&pool)
    .await
    .unwrap();

    // Push the ack boundary far enough past the existing snapshot cursor
    // (`MIN_NEW_OPERATIONS_TO_COMPACT` = 200) that the next `run_once` does a
    // real recompute instead of taking the "too little new activity" early
    // return, which would otherwise leave the deleted row deleted.
    for seq in 2..=201i64 {
        // Each filler is its own brand-new object, so it must be a `create`
        // (an origination op) regardless of `seq` — unlike `bookmark_op`,
        // which only produces `create` when `seq == 1`, this loop needs 200
        // originations at device sequences 2..=201.
        let op = json!({
            "operationId": Uuid::now_v7(),
            "deviceSequence": seq,
            "lamportTimestamp": seq,
            "objectType": "bookmark",
            "objectId": Uuid::now_v7(),
            "operationType": "create",
            "encryptionVersion": 0,
            "payload": { "title": "filler", "url": "https://example.com", "parent": null, "position": "a0" }
        });
        upload(&server, &access_token, op).await;
    }
    // Not `sync_device` (which starts from cursor=0): the first compaction
    // above already pruned everything below its boundary, so a fresh
    // download from 0 now gets `cursor_too_old` instead of a page. Resync
    // from the snapshot's own cursor instead — a real client would do the
    // same "cursor_too_old -> refetch /snapshot -> resume from its cursor"
    // dance; reading `sync_snapshots` directly here is just the test's
    // shortcut to the same starting point.
    let snapshot_cursor: i64 = sqlx::query_scalar!(
        r#"SELECT COALESCE(MAX(snapshot_cursor), 0) as "c!" FROM sync_snapshots WHERE user_id = $1"#,
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let res = download(&server, &access_token, snapshot_cursor).await;
    res.assert_status_ok();
    let next_cursor = res.json::<serde_json::Value>()["nextCursor"]
        .as_i64()
        .unwrap();
    download(&server, &access_token, next_cursor)
        .await
        .assert_status_ok();
    compaction::run_once(&state).await.unwrap();

    let row_after_self_heal: Option<Uuid> = sqlx::query_scalar!(
        "SELECT object_id FROM sync_objects WHERE user_id = $1 AND object_type = 'historyVisit' AND object_id = $2",
        user_id,
        object_id
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(
        row_after_self_heal.is_some(),
        "compaction must self-heal the missing bulk-history ledger row from the object set it folds into the new snapshot"
    );
}
