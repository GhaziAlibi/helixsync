use std::sync::Arc;

use axum_test::{TestServer, TestServerConfig, Transport};
use helixsync_server::config::Config;
use helixsync_server::middleware::rate_limit::RateLimiter;
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
    }
}

fn state_for_config(pool: PgPool, config: Config) -> AppState {
    AppState {
        db: pool,
        config: Arc::new(config),
        rate_limiter: Arc::new(RateLimiter::new()),
        ws_registry: Arc::new(ConnectionRegistry::new()),
    }
}

fn server_for_state(state: AppState) -> TestServer {
    let config = TestServerConfig {
        transport: Some(Transport::HttpRandomPort),
        ..Default::default()
    };
    let make_service = helixsync_server::app(state)
        .into_make_service_with_connect_info::<std::net::SocketAddr>();
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
    let (device_id, access_token) = register_device(&server, "alice@example.com", "Test Laptop").await;
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

    // Retry the exact same operation (simulating a dropped response + retry).
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
async fn stale_device_sequence_is_rejected(pool: PgPool) {
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

    // Same or lower device_sequence with a *different* operationId must be rejected.
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
    let rejected = body2["rejected"].as_array().unwrap();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0]["reason"], "sequence_conflict");
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

    // Two devices concurrently (same Lamport timestamp) update different
    // fields of the same bookmark: device A changes the title, device B
    // changes the url. Per docs/protocol.md §8.2 both changes must survive
    // in the snapshot rather than one operation's whole payload winning.
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
    // The move field was untouched by either concurrent update, so it must
    // still reflect the original create's parent/position.
    assert_eq!(merged["position"], json!("a0"));
}

#[sqlx::test(migrations = "./migrations")]
async fn revoked_device_is_rejected(pool: PgPool) {
    let server = server_for(pool.clone());
    register_and_login(&server, "frank@example.com").await;
    let (device_id, access_token) = register_device(&server, "frank@example.com", "Laptop").await;

    // Revoke the device directly at the data layer (simulating the web UI action).
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

// The tests above only ever upload one operation per request. The batch
// upload path (`sync::routes::process_batch`) resolves dedup/ownership/
// sequence checks for the whole request up front rather than one query per
// op, so it needs its own coverage for the interactions that only arise
// *within* a single multi-op batch — see the assertions below.

#[sqlx::test(migrations = "./migrations")]
async fn batch_upload_resolves_ownership_for_object_created_earlier_in_same_batch(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "ivan@example.com").await;
    let (_device_id, access_token) = register_device(&server, "ivan@example.com", "Laptop").await;

    // A create and a subsequent update for the *same* object, both in one
    // request. The update's ownership check must see the create even
    // though it hasn't been committed by a prior request — the create
    // appears earlier in this same batch.
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
    assert_eq!(objects[0]["payload"]["title"], json!("Renamed in same batch"));
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

/// history_retention is stored/validated (sync::settings) but was never
/// enforced anywhere — this exercises `history_retention_cutoff` /
/// `compute_objects`'s historyVisit filtering directly through the same
/// `/snapshot` and `/stats` routes a real client calls. Since the server
/// can't read a visit's own timestamp (payload is E2E encrypted), the
/// cutoff is measured from `sync_operations.created_at` — backdated here
/// directly at the data layer, the same way other tests here backdate/
/// mutate rows to simulate a state that can't be reached through the HTTP
/// API alone within a single test run.
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

    // Simulate the old visit having actually been uploaded 10 days ago —
    // outside the 7d retention window just configured, unlike the "recent"
    // one left at its real (just-now) upload time.
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
    assert_eq!(objects.len(), 1, "expired visit must not appear in the snapshot: {objects:?}");
    assert_eq!(objects[0]["objectId"], json!(recent_object_id));

    // `/stats` is now backed by `sync_stats` (migrations/0007_sync_stats.sql),
    // which `process_batch` maintains via per-batch origination/tombstone/
    // restore deltas — see the module doc comment there. That mechanism has
    // no way to react to a historyVisit aging *past* retention with no new
    // operation involved: retention expiry is a function of wall-clock time
    // (`history_retention_cutoff`, evaluated fresh on every `/snapshot`/
    // compaction call), not an event `process_batch` ever sees. So
    // immediately after the backdate above — before any compaction pass —
    // `sync_stats` is still counting the now-expired visit: the incremental
    // path is only ever eventually consistent with retention, not
    // real-time-accurate the way `/snapshot`'s direct `compute_objects`
    // call above is. Checked directly against the table (not through
    // `/stats`) since a second HTTP call here would just hit the 30-second
    // `STATS_CACHE` and prove nothing about the underlying reconciliation
    // this test is actually about.
    let user_id = user_id_for_email(&pool, "nora@example.com").await;
    let (_, history_visits_before_compaction, _) = sync_stats_row(&pool, user_id).await;
    assert_eq!(
        history_visits_before_compaction, 2,
        "incremental sync_stats has no retention-decay signal, so it still counts the not-yet-reconciled expired visit"
    );

    // `sync::compaction::compact_user`'s authoritative reconciliation is
    // what actually converges `sync_stats` toward the configured retention
    // window — it recomputes the live object set (itself already
    // retention-filtered, same as `/snapshot`) and overwrites the row. Ack
    // the device's cursor first so `compact_user`'s ack boundary covers
    // both uploaded operations.
    sync_device(&server, &access_token).await;
    compaction::run_once(&state).await.unwrap();

    let stats_res = server
        .get("/api/v1/sync/stats")
        .authorization_bearer(&access_token)
        .await;
    stats_res.assert_status_ok();
    let stats: serde_json::Value = stats_res.json();
    assert_eq!(stats["historyVisits"], json!(1), "compaction must reconcile sync_stats to exclude the expired visit");
}

/// Control for the test above: with retention left at "unlimited", the
/// same backdated visit must still be served — `history_retention_cutoff`
/// returning `None` has to be a true no-op, not silently apply some
/// default window.
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

#[sqlx::test(migrations = "./migrations")]
async fn batch_upload_dedupes_tombstone_writes_for_same_object(pool: PgPool) {
    let server = server_for(pool);
    register_and_login(&server, "mallory@example.com").await;
    let (_device_id, access_token) = register_device(&server, "mallory@example.com", "Laptop").await;

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

// --- sync_stats regression coverage (migrations/0007_sync_stats.sql) ---
//
// These exercise the three-part design directly:
//   - `stats_reflects_counts_across_batches` and
//     `stats_nets_out_same_batch_create_then_delete` /
//     `stats_decreases_when_object_deleted_in_later_batch` cover
//     `process_batch`'s incremental net-delta upkeep.
//   - `compaction_reconciles_stats_after_snapshot` covers
//     `compaction::compact_user`'s authoritative overwrite.
// The lazy-backfill path (no `sync_stats` row yet) only matters for
// accounts that predate this migration and haven't synced or been
// compacted since upgrading — not reachable from a fresh `sqlx::test`
// database, since `process_batch` (the primary write path exercised by
// every test in this file) always populates the row itself now.

async fn user_id_for_email(pool: &PgPool, email: &str) -> Uuid {
    sqlx::query_scalar!("SELECT id FROM users WHERE email = $1", email)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Direct read of the `sync_stats` table, bypassing the `/stats` HTTP
/// route's 30-second `STATS_CACHE`. Needed whenever a test wants to observe
/// the count change *within* a single run — two HTTP calls close together
/// would otherwise just return the same cached response instead of proving
/// anything about the underlying table. Missing row reads as all-zero,
/// mirroring the column defaults (`process_batch` only ever writes a row
/// once a batch has a nonzero delta to apply).
async fn sync_stats_row(pool: &PgPool, user_id: Uuid) -> (i32, i32, i32) {
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

/// Generic operation builder for the `sync_stats` tests below — unlike
/// `sample_bookmark_op`/`history_visit_op`, payload contents don't matter
/// here (only object type / operation type / bucket membership do), so an
/// empty payload keeps each test focused on the counting behavior being
/// verified rather than on payload shape.
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

/// Round-trips a device's cursor through `/changes` twice, same as
/// `sync_device` in `compaction_flow.rs`: docs/protocol.md §4.4 means the
/// server only learns a device has acknowledged up to `nextCursor` on that
/// device's *next* request, so a single download isn't enough to advance
/// `compact_user`'s ack boundary past the operations just uploaded.
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

/// Basic correctness: bookmarks, a history visit, and a tab created across
/// two separate upload batches must all be reflected in `/stats`' counts.
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

    // Second batch, uploaded separately so the assertion below exercises
    // cross-batch accumulation rather than everything landing in one
    // `process_batch` call.
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

/// Same-batch churn: a bookmark created and deleted within the same upload
/// batch must net to zero — it appears in both `originations` and
/// `tombstones` for that batch, contributing +1 and -1, and must never have
/// been observably live.
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
    assert_eq!(bookmarks, 0, "create+delete in the same batch must net to zero, not undercount/overcount");

    let stats_res = server
        .get("/api/v1/sync/stats")
        .authorization_bearer(&access_token)
        .await;
    stats_res.assert_status_ok();
    let stats: serde_json::Value = stats_res.json();
    assert_eq!(stats["bookmarks"], json!(0));
}

/// Cross-batch: an object created in one batch and deleted in a later batch
/// must have its count decrease accordingly — the second batch's -1 delta
/// applies on top of the first batch's +1, both against the same
/// `sync_stats` row via the `ON CONFLICT ... DO UPDATE SET x = sync_stats.x
/// + EXCLUDED.x` upsert.
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
    assert_eq!(bookmarks_after_create, 1, "creation batch must apply a +1 delta");

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

/// Compaction reconciliation: `compact_user` must *overwrite* (not merely
/// leave alone) the `sync_stats` row with the authoritative count from the
/// live object set it just persisted into a snapshot. Deliberately corrupts
/// the row first to prove this is an overwrite and not just an accidental
/// match — if compaction only incremented, or skipped reconciliation
/// entirely, the corrupted values would survive.
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

    // Fully ack the device's cursor so `compact_user`'s ack boundary can
    // advance past these operations (see `sync_device`'s doc comment).
    sync_device(&server, &access_token).await;

    let user_id = user_id_for_email(&pool, "sana@example.com").await;

    // Simulate whatever drift the incremental path (`process_batch`) could
    // in principle accumulate over time — exactly the scenario compaction's
    // reconciliation exists to correct.
    sqlx::query!(
        "UPDATE sync_stats SET bookmark_count = 999, tab_count = 999, history_visit_count = 999 WHERE user_id = $1",
        user_id
    )
    .execute(&pool)
    .await
    .unwrap();

    compaction::run_once(&state).await.unwrap();

    let (bookmarks, history_visits, tabs) = sync_stats_row(&pool, user_id).await;
    assert_eq!(bookmarks, 1, "compaction must overwrite the corrupted bookmark_count with the true count");
    assert_eq!(history_visits, 1, "compaction must overwrite the corrupted history_visit_count with the true count");
    assert_eq!(tabs, 1, "compaction must overwrite the corrupted tab_count with the true count");

    // The fast path, now backed by the reconciled row, must report the
    // same corrected counts through the actual HTTP route.
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
