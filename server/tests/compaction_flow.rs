use std::sync::Arc;

use axum_test::{TestServer, TestServerConfig, Transport};
use chrono::Utc;
use helixsync_server::config::Config;
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
        // No tombstones exercised in these tests, but keep retention at
        // zero so a terminal operation (if any were involved) wouldn't
        // need a real wall-clock wait to become compactable.
        tombstone_retention_secs: 0,
        compaction_interval_secs: 60 * 60,
        // Every device across these tests is registered and used within the
        // same test run, so the real 30-day default never age anything out
        // by accident.
        inactive_device_compaction_grace_period_secs: 60 * 60 * 24 * 30,
        housekeeping_interval_secs: 60 * 60 * 24,
        device_credential_retention_secs: 60 * 60 * 24 * 7,
        audit_log_retention_secs: 60 * 60 * 24 * 90,
        database_max_connections: 5,
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

/// Regression coverage for the `devices.last_device_sequence` fix
/// (migration `0009_devices_last_sequence.sql`): `process_batch` used to
/// derive a device's last-used `device_sequence` via `SELECT
/// MAX(device_sequence) FROM sync_operations WHERE device_id = $1`, which
/// silently resets to 0 once compaction deletes every one of that device's
/// rows — exactly what `edit_after_compaction_is_accepted_not_rejected`
/// above proves happens to `sync_operations` for a fully-acknowledged
/// device. A device that then uploaded a *new* operation reusing a
/// `device_sequence` value it had already used (and had accepted) before
/// compaction would have been wrongly accepted instead of rejected
/// `sequence_conflict`, since the stale-derived `last_seq` had reset to 0
/// and any `device_sequence >= 1` looks "new" against that. This test
/// fully compacts a device away and then replays an old, already-used
/// `device_sequence` and asserts it is still correctly rejected.
#[sqlx::test(migrations = "./migrations")]
async fn device_sequence_does_not_reset_after_full_compaction(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = server_for_state(state.clone());

    register_and_login(&server, "gwen@example.com").await;
    let (_device_a, token_a) = register_device(&server, "gwen@example.com", "Laptop").await;

    let object_id = Uuid::now_v7();
    // Two accepted ops from this device: device_sequence 1 (create) and 2
    // (update) — its real last sequence is 2.
    upload(&server, &token_a, bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example")).await;
    upload(&server, &token_a, bookmark_op(Uuid::now_v7(), object_id, 2, 2, "Renamed")).await;

    // Fully acknowledge and compact — same mechanism
    // `edit_after_compaction_is_accepted_not_rejected` uses to drain every
    // row of this device's operations out of `sync_operations` entirely.
    sync_device(&server, &token_a).await;

    let user_id = user_id_for_email(&pool, "gwen@example.com").await;
    compaction::run_once(&state).await.unwrap();
    assert_eq!(
        count_operations(&pool, user_id).await,
        0,
        "every one of this device's rows must be gone after compaction — the precondition for the bug this test guards against"
    );

    // Without the fix, the server would have re-derived `last_seq` as
    // `MAX(device_sequence) FROM sync_operations` = NULL -> 0 here (no rows
    // left), so a replayed `device_sequence = 2` (already used and accepted
    // above) would look like a fresh, valid sequence number and be wrongly
    // accepted — colliding with the device's own prior history. A brand
    // new object is used for the origination op so the ownership
    // pre-check (`sync_objects`) can never itself be the reason for a
    // rejection here; only `sequence_conflict` should fire.
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
    let rejected = body["rejected"].as_array().unwrap();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0]["reason"], "sequence_conflict");

    // And a genuinely new, higher device_sequence must still work fine —
    // proving the fix didn't overcorrect into rejecting everything.
    // Deliberately a fresh `create` (an origination op, per
    // `bookmark_op`'s own seq==1 convention) on a brand-new object id, so
    // this can only ever fail on the sequence check, never on the
    // `sync_objects` ownership pre-check.
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

/// Regression coverage for SRV-PERF-1: an abandoned device (old phone,
/// uninstalled extension, a work browser never explicitly revoked) that
/// never acknowledges anything used to pin `ack_boundary` at 0 forever,
/// since `compact_user`'s boundary query only excluded *revoked* devices,
/// not merely stale ones. `compaction_waits_for_every_active_device_to_acknowledge`
/// (above) proves a never-synced device correctly blocks compaction *within*
/// its grace period; this proves it stops blocking once it's aged past that
/// grace period, exactly as docs/protocol.md §11 anticipates via the
/// `cursor_too_old` snapshot-resync fallback for any device that reconnects
/// after falling behind.
#[sqlx::test(migrations = "./migrations")]
async fn stale_never_revoked_device_ages_out_of_compaction_boundary(pool: PgPool) {
    // A short grace period so the test doesn't need to wait a real 30 days
    // — just push the stale device's timestamps further into the past than
    // this.
    let state = state_with_inactive_device_grace_period(pool.clone(), 60);
    let server = server_for_state(state.clone());

    register_and_login(&server, "gale@example.com").await;
    let (_device_a, token_a) = register_device(&server, "gale@example.com", "Laptop").await;
    // Device B is registered and never syncs, mirroring an abandoned old
    // phone/uninstalled extension that the user never bothered to revoke
    // from the dashboard.
    let (device_b, _token_b) = register_device(&server, "gale@example.com", "Phone").await;

    let object_id = Uuid::now_v7();
    upload(&server, &token_a, bookmark_op(Uuid::now_v7(), object_id, 1, 1, "Example")).await;

    // Device A acknowledges past the only operation; device B never does.
    sync_device(&server, &token_a).await;

    let user_id = user_id_for_email(&pool, "gale@example.com").await;
    assert_eq!(count_operations(&pool, user_id).await, 1);

    // Age device B's `created_at` (and `last_seen_at`, covering the "synced
    // once then went dark" variant too) well past the grace period, exactly
    // like `revoked_device_never_blocks_compaction` directly UPDATEs
    // `devices.revoked_at` via raw SQL rather than through any API route
    // (there isn't one for backdating timestamps).
    sqlx::query(
        "UPDATE devices SET created_at = now() - INTERVAL '1 hour', last_seen_at = now() - INTERVAL '1 hour' \
         WHERE id = $1::uuid",
    )
    .bind(&device_b)
    .execute(&pool)
    .await
    .unwrap();

    compaction::run_once(&state).await.unwrap();

    // Now that device B is stale beyond the grace period, it no longer
    // blocks compaction — the boundary is based on device A alone, so
    // everything up to A's ack cursor is compacted into a snapshot, same
    // outcome as a revoked device.
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

/// Regression coverage for SRV-PERF-8's backward-compatibility fallback:
/// migration `0008_compress_sync_snapshots.sql` converted every
/// *pre-existing* `sync_snapshots.data` row from JSONB to plain
/// UTF8-encoded JSON text bytes (BYTEA) — it could not gzip them, since a
/// raw SQL migration can't invoke the application's compressor. Only rows
/// written by `sync::compaction` *after* this deploys are actually
/// gzip-compressed via `compress_snapshot_data`. So
/// `sync::routes::decompress_snapshot_data` must transparently fall back
/// to plain UTF8 JSON parsing whenever gzip-decoding fails. This directly
/// exercises that fallback path: a `sync_snapshots` row is inserted by raw
/// SQL with uncompressed JSON bytes (mirroring a row left over from before
/// this migration), and the `/snapshot` route must still return its
/// contents correctly.
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
    }];
    // Deliberately NOT gzip-compressed — this is exactly the format
    // migration 0008 leaves pre-existing rows in.
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
    assert_eq!(objects.len(), 1, "legacy uncompressed row must still be readable: {snapshot}");
    assert_eq!(objects[0]["objectId"], json!(object_id));
    assert_eq!(objects[0]["payload"]["title"], json!("Legacy bookmark"));
    assert_eq!(snapshot["snapshotCursor"].as_i64().unwrap(), 1);
}

/// Regression coverage for SRV-1: a `historyVisit` already folded into a
/// *persisted* `sync_snapshots` row (i.e. it did not arrive as a fresh
/// `sync_operations` row this call, so the `new_rows` SQL filter in
/// `compute_objects` never sees it) must still be excluded once it falls
/// outside the configured retention window. Before this fix, `objects` was
/// seeded from the base snapshot with no filtering at all — only rows
/// freshly read from `sync_operations` were checked against
/// `history_cutoff` — so a historyVisit baked into any snapshot stayed
/// there forever, regardless of retention, since historyVisit is immutable
/// (never produces a second operation that could route it back through the
/// `new_rows` filter).
///
/// The base snapshot is inserted directly by raw SQL (uncompressed, same as
/// `snapshot_route_falls_back_to_uncompressed_legacy_data` above) to
/// simulate exactly that pre-existing, already-baked-in state without
/// depending on any particular upload/compaction sequence to produce it.
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
            // Well outside the 7d retention window just configured.
            created_at: Utc::now() - chrono::Duration::days(30),
        },
        SnapshotObject {
            object_type: "historyVisit".to_string(),
            object_id: recent_visit_id,
            operation_type: "visit".to_string(),
            encryption_version: 0,
            payload: json!({ "url": "https://recent.example.com" }),
            // Inside the retention window.
            created_at: Utc::now() - chrono::Duration::days(1),
        },
        SnapshotObject {
            object_type: "bookmark".to_string(),
            object_id: bookmark_id,
            operation_type: "create".to_string(),
            encryption_version: 0,
            payload: json!({ "title": "Old bookmark", "url": "https://example.com", "parent": null, "position": "a0" }),
            // Also well outside the retention window — must survive anyway,
            // since history_cutoff only ever applies to historyVisit.
            created_at: Utc::now() - chrono::Duration::days(30),
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
    let object_ids: Vec<serde_json::Value> = objects.iter().map(|o| o["objectId"].clone()).collect();

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

/// Regression coverage for the `sync_operations` DELETE chunking fix: the
/// final deletion in `compact_user` used to be a single unchunked statement,
/// which for a large ack'd backlog (typically a first-ever compaction pass,
/// since `MIN_NEW_OPERATIONS_TO_COMPACT` keeps ordinary hourly passes far
/// below this scale) could hold row locks and spike WAL for the duration of
/// one giant statement. It's now a loop of bounded deletes inside the same
/// transaction. This inserts more than one chunk's worth of operations
/// (`DELETE_CHUNK_SIZE` is 5,000; this uses 12,000, requiring three loop
/// iterations) and asserts the end state is identical to what a single
/// unchunked DELETE would have produced: every row gone, exactly one
/// snapshot written, at the expected cursor.
///
/// Rows are bulk-inserted directly by SQL rather than via `OP_COUNT` HTTP
/// uploads — looping that many real sync requests would make this test
/// prohibitively slow for no extra coverage, since the chunked loop's
/// correctness doesn't depend on how the rows were created, only on what's
/// already in `sync_operations` and `sync_cursors` when `compact_user` runs.
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

    // Acknowledge every inserted operation from this (only) active device,
    // same effect as the HTTP-driven `sync_device` helper but for a backlog
    // too large to walk through the API one operation at a time.
    sqlx::query("INSERT INTO sync_cursors (user_id, device_id, cursor_value) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(device_id)
        .bind(OP_COUNT)
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(count_operations(&pool, user_id).await, OP_COUNT);

    compaction::run_once(&state).await.unwrap();

    // Every operation is gone (none are terminal, so there's no survivor
    // set to exclude) and exactly one snapshot was written — the chunked
    // loop must have kept iterating past its first 5,000-row pass until the
    // full backlog was drained, then stopped.
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

/// SRV-2 regression: the chunked `sync_operations` delete loop used to run
/// inside the very same transaction as the `sync_stats` upsert, so any
/// concurrent upload from another of the user's devices — which also
/// upserts `sync_stats` (see `sync::routes::process_batch`) — blocked
/// behind that transaction's commit for as long as the (potentially
/// multi-second, on a large backlog) delete loop took. After the fix, the
/// snapshot-writing transaction (the only one touching `sync_stats`) commits
/// *before* the delete loop starts, and the delete loop's own per-chunk
/// transactions never touch `sync_stats` at all — so a concurrent upload has
/// nothing left to wait on.
///
/// This can't assert an exact bound on how long a blocked upload would have
/// taken pre-fix without injecting artificial slowness into the test
/// database, so treat it as a smoke/regression test (it exercises the exact
/// concurrent-upload-during-compaction scenario end-to-end and fails loudly
/// on a deadlock/hang) rather than a timing proof. The final row counts,
/// though, are asserted exactly and are not timing-dependent: `ack_boundary`
/// is pinned by both devices' already-recorded cursors before either task
/// starts, so it can't drift depending on whether the concurrent upload
/// happens to land before or after compaction reads it.
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

    // The backlog above was inserted directly via SQL, bypassing
    // `sync::routes::process_batch`'s normal cursor allocator — which hands
    // out fresh `server_cursor` values from a dedicated `sync_cursors` row
    // keyed by `device_id IS NULL` (see `current_cursor` /
    // the `cursor_value = cursor_value + count` allocation in
    // `process_batch`), entirely separate from the per-device ack cursors
    // below. Without advancing that row to `OP_COUNT` too, the concurrent
    // upload later in this test would allocate a `server_cursor` starting
    // back at 1 and collide with the backlog's own row 1.
    sqlx::query("INSERT INTO sync_cursors (user_id, device_id, cursor_value) VALUES ($1, NULL, $2)")
        .bind(user_id)
        .bind(OP_COUNT)
        .execute(&pool)
        .await
        .unwrap();

    // Ack the backlog from both active devices so `ack_boundary` reaches
    // `OP_COUNT` and compaction actually has something to delete. Both
    // cursors are written directly, mirroring
    // `chunked_delete_drains_backlog_larger_than_one_chunk` — going through
    // the real `/changes` round trip (`sync_device`) would only ack one
    // `DEFAULT_DOWNLOAD_LIMIT` (500-op) page per call, since this backlog is
    // far larger than a single page.
    sqlx::query("INSERT INTO sync_cursors (user_id, device_id, cursor_value) VALUES ($1, $2, $3), ($1, $4, $3)")
        .bind(user_id)
        .bind(device_id)
        .bind(OP_COUNT)
        .bind(device_b_id)
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(count_operations(&pool, user_id).await, OP_COUNT);

    // Run compaction (spends most of its time in the chunked delete loop)
    // concurrently with an ordinary upload from device_b.
    let compaction_state = state.clone();
    let compaction_task = tokio::spawn(async move { compaction::run_once(&compaction_state).await });

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

    // Every backlog operation is compacted away; only the concurrent
    // upload's own operation (whose cursor lands above `ack_boundary`)
    // survives.
    assert_eq!(count_operations(&pool, user_id).await, 1);
    assert_eq!(count_snapshots(&pool, user_id).await, 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn prune_compacted_operations_tolerates_preexisting_temp_table_and_connection_reuse(pool: PgPool) {
    let single_conn_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let state = state_for(single_conn_pool.clone());

    let setup_server = server_for_state(state_for(pool.clone()));
    register_and_login(&setup_server, "collision_test@example.com").await;
    let (_device_id, token) = register_device(&setup_server, "collision_test@example.com", "TestDevice").await;
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

    // 1. Simulate an aborted/cancelled run that left the temporary table behind
    // with a leftover survivor ID on this connection.
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

    // Call prune_compacted_operations on the same connection.
    // Thanks to CREATE TEMPORARY TABLE IF NOT EXISTS and TRUNCATE, this succeeds
    // without SQLSTATE 42P07 and prunes op1 properly.
    compaction::prune_compacted_operations(&state, user_id, 1)
        .await
        .expect("prune_compacted_operations must succeed when temporary table already exists");

    assert_eq!(count_operations(&pool, user_id).await, 1);

    // 2. Simulate running prune_compacted_operations a second time on the same connection
    // where the table was again left behind without dropping (e.g. from an uncompleted run).
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

    // 3. Running prune_compacted_operations once more after standard cleanup also succeeds
    compaction::prune_compacted_operations(&state, user_id, 2)
        .await
        .expect("subsequent prune_compacted_operations call must succeed");
}
