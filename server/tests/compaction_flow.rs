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
        // No tombstones exercised in these tests, but keep retention at
        // zero so a terminal operation (if any were involved) wouldn't
        // need a real wall-clock wait to become compactable.
        tombstone_retention_secs: 0,
        compaction_interval_secs: 60 * 60,
    }
}

fn state_for(pool: PgPool) -> AppState {
    AppState {
        db: pool,
        config: Arc::new(test_config()),
        rate_limiter: Arc::new(RateLimiter::new()),
        ws_registry: Arc::new(ConnectionRegistry::new()),
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

fn bookmark_op(op_id: Uuid, object_id: Uuid, seq: i64, lamport: i64, title: &str) -> serde_json::Value {
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

/// Fully syncs a device and makes sure its ack is actually persisted
/// server-side. docs/protocol.md §4.4: the `cursor` a request sends is what
/// the client claims to have *already* applied — the server only learns a
/// device advanced to `nextCursor` on that device's *next* request (same as
/// a real client's next polling cycle; see `sync/engine.ts::downloadAndApply`,
/// which only sends the advanced cursor on a subsequent call). So a single
/// download isn't enough to record an ack for compaction purposes; this
/// helper does the follow-up round-trip a real client's next sync cycle
/// would.
async fn sync_device(server: &TestServer, token: &str) {
    let res = download(server, token, 0).await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let next_cursor = body["nextCursor"].as_i64().unwrap();
    download(server, token, next_cursor).await.assert_status_ok();
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
    upload(&server, &token_a, bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example")).await;

    // Device A acknowledges past the only operation; device B never does.
    sync_device(&server, &token_a).await;

    let user_id = user_id_for_email(&pool, "ann@example.com").await;
    assert_eq!(count_operations(&pool, user_id).await, 1);

    compaction::run_once(&state).await.unwrap();

    // Untouched: an active device (B) has never acknowledged anything, so
    // the compaction boundary must stay at 0 and nothing gets deleted or
    // snapshotted.
    assert_eq!(count_operations(&pool, user_id).await, 1);
    assert_eq!(count_snapshots(&pool, user_id).await, 0);

    // Confirm the data is still genuinely intact for the never-synced device.
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
    upload(&server, &token_a, bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example")).await;
    upload(&server, &token_a, bookmark_op(Uuid::now_v7(), object_id, 2, 2, "Renamed")).await;

    // Only device A ever acknowledges anything; device B never calls
    // /changes at all before being revoked.
    sync_device(&server, &token_a).await;

    sqlx::query("UPDATE devices SET revoked_at = now() WHERE id = $1::uuid")
        .bind(&device_b)
        .execute(&pool)
        .await
        .unwrap();

    let user_id = user_id_for_email(&pool, "bea@example.com").await;
    compaction::run_once(&state).await.unwrap();

    // The revoked device (never acknowledged anything) must not have
    // blocked compaction — the boundary is based on device A alone, so
    // everything up to A's ack cursor is compacted into a snapshot.
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
    upload(&server, &token_a, bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example")).await;
    upload(&server, &token_a, bookmark_op(Uuid::now_v7(), object_id, 2, 2, "Renamed")).await;

    // Both devices fully acknowledge, so compaction can remove everything.
    sync_device(&server, &token_a).await;
    sync_device(&server, &token_b).await;

    let user_id = user_id_for_email(&pool, "cleo@example.com").await;
    compaction::run_once(&state).await.unwrap();
    assert_eq!(count_operations(&pool, user_id).await, 0);
    assert_eq!(count_snapshots(&pool, user_id).await, 1);

    // Device B's local state gets wiped (e.g. reinstalled extension) and
    // reconnects from scratch with the same device credentials — the
    // server-side cursor floor is now past what a from-scratch cursor=0
    // request can be served incrementally, so it must be told to resync.
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

    // Resuming incrementally from the snapshot's cursor works cleanly.
    let resumed = download(&server, &token_b, resync_cursor).await;
    resumed.assert_status_ok();
    let resumed_body: serde_json::Value = resumed.json();
    assert!(resumed_body["operations"].as_array().unwrap().is_empty());
}

/// Regression coverage for the "skip recompaction when too few new
/// operations have landed since the last snapshot" guard: without it,
/// `compact_user` re-parsed and rewrote this user's entire snapshot blob
/// on every single pass once *any* new operation had been acknowledged,
/// no matter how small. This confirms a pass with only a couple of new
/// ops below the threshold is a genuine no-op (same snapshot row, same
/// operation count) rather than silently redoing the full rewrite anyway.
#[sqlx::test(migrations = "./migrations")]
async fn compaction_skips_recompaction_below_new_operation_threshold(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "dev@example.com").await;
    let (_device_a, token_a) = register_device(&server, "dev@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    upload(&server, &token_a, bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example")).await;
    // Tracks the device's own cursor across rounds, like a real client
    // would (docs/protocol.md §4.4) — `sync_device` always restarts from
    // 0, which only works for a device's *first* sync: once compaction has
    // run once, cursor 0 falls below the floor and a second `sync_device`
    // call would get `cursor_too_old` instead of acknowledging normally.
    let cursor = download(&server, &token_a, 0).await.json::<serde_json::Value>()["nextCursor"]
        .as_i64()
        .unwrap();
    download(&server, &token_a, cursor).await.assert_status_ok();

    let user_id = user_id_for_email(&pool, "dev@example.com").await;

    // First pass: no snapshot exists yet, so it must proceed regardless of
    // how few operations there are.
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

    // A couple more operations land and get fully acknowledged — well
    // under any reasonable "worth recompacting" threshold. Built by hand
    // rather than via `bookmark_op` (whose create-vs-update choice is
    // "is `seq` literally 1", true only for a *device's* very first
    // operation ever — device_sequence continues from 2 here, but this is
    // still `other_object`'s own first operation, so it must be a `create`).
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
    let cursor = download(&server, &token_a, cursor).await.json::<serde_json::Value>()["nextCursor"]
        .as_i64()
        .unwrap();
    download(&server, &token_a, cursor).await.assert_status_ok();
    assert_eq!(count_operations(&pool, user_id).await, 2, "new ops land as raw rows before compaction");

    compaction::run_once(&state).await.unwrap();

    // Skipped: still exactly one snapshot, at the same cursor, and the two
    // new raw operation rows are left alone rather than folded in and
    // deleted.
    assert_eq!(count_snapshots(&pool, user_id).await, 1);
    let cursor_after_skip: i64 = sqlx::query_scalar!(
        "SELECT snapshot_cursor FROM sync_snapshots WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(cursor_after_skip, first_cursor, "compaction must not have advanced the snapshot");
    assert_eq!(count_operations(&pool, user_id).await, 2, "raw rows below the threshold must survive untouched");
}

/// Regression coverage for `compact_user`'s candidate-delete rewrite: it
/// used to fetch every row `<= ack_boundary` into Rust, filter for
/// survivors (a terminal op still inside its retention window) there, then
/// delete everything else via `id = ANY(delete_ids)`. It now instead only
/// ever fetches rows that could possibly be terminal
/// (`operation_type IN ('delete', 'close')`) and deletes everything
/// *except* the resulting (usually tiny) survivor set. Both the "most rows
/// get deleted" and "a terminal op survives its own retention window"
/// cases need to still hold under that inverted query shape.
#[sqlx::test(migrations = "./migrations")]
async fn terminal_operation_survives_its_own_retention_window(pool: PgPool) {
    // A full day of retention — long enough that "just deleted" can never
    // accidentally already be past it.
    let state = state_with_tombstone_retention(pool.clone(), 60 * 60 * 24);
    let server = server_for_state(state.clone());

    register_and_login(&server, "paul@example.com").await;
    let (_device_a, token_a) = register_device(&server, "paul@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    upload(&server, &token_a, bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example")).await;
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
    assert_eq!(count_operations(&pool, user_id).await, 2, "create + delete before compaction");

    compaction::run_once(&state).await.unwrap();

    // The non-terminal `create` is gone (folded into the snapshot, like
    // any other ack'd op), but the terminal `delete` survives — it's
    // still within its retention window.
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

    // The tombstone's effect is independently durable regardless — the
    // object is excluded from a fresh snapshot whether or not its raw
    // delete-op row has been swept yet.
    let snapshot_res = server
        .get("/api/v1/sync/snapshot")
        .authorization_bearer(&token_a)
        .await;
    snapshot_res.assert_status_ok();
    let snapshot: serde_json::Value = snapshot_res.json();
    assert!(snapshot["objects"].as_array().unwrap().is_empty());
    assert_eq!(snapshot["tombstones"].as_array().unwrap().len(), 1);
}

/// Regression coverage for the `object_not_found` data-loss bug fixed by
/// migration `0006_sync_objects.sql`: the batch-upload ownership pre-check
/// used to query `sync_operations` directly for whether the caller already
/// owned an object, but compaction deletes every `sync_operations` row
/// (including an object's originating `create`) once it's folded into a
/// snapshot. That made any edit to an object uploaded before compaction ran
/// against it permanently rejected `object_not_found`, forever, once the
/// object's raw rows were gone. The fix is a dedicated `sync_objects`
/// existence ledger, populated when an origination op is accepted and never
/// pruned by compaction — this test creates an object, compacts it away
/// entirely (mirroring `reconnecting_device_gets_cursor_too_old_and_resyncs_via_snapshot`'s
/// proof that `sync_operations` ends up empty), then uploads an ordinary
/// `update` to that same object and asserts it's accepted rather than
/// rejected.
#[sqlx::test(migrations = "./migrations")]
async fn edit_after_compaction_is_accepted_not_rejected(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "finn@example.com").await;
    let (_device_a, token_a) = register_device(&server, "finn@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    upload(&server, &token_a, bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example")).await;

    // Fully acknowledge and compact — this is what deletes the object's
    // `create` row out of `sync_operations` entirely, folding its effect
    // into a `sync_snapshots` row instead.
    sync_device(&server, &token_a).await;

    let user_id = user_id_for_email(&pool, "finn@example.com").await;
    compaction::run_once(&state).await.unwrap();
    assert_eq!(
        count_operations(&pool, user_id).await,
        0,
        "the create op's raw row must be gone after compaction, same as the existing cursor_too_old test proves"
    );
    assert_eq!(count_snapshots(&pool, user_id).await, 1);

    // Sanity check: the existence ledger survived compaction (it must,
    // since compaction never touches `sync_objects`) and still records this
    // object as owned by this user.
    let ledger_rows: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "c!" FROM sync_objects WHERE user_id = $1 AND object_id = $2"#,
        user_id,
        object_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(ledger_rows, 1);

    // The bug: an ordinary rename (a non-origination `update`) of the
    // now-fully-compacted object used to be rejected `object_not_found`
    // because its origination `create` row no longer existed in
    // `sync_operations`. It must now be accepted.
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
