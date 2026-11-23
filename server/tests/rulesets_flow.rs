//! Selective-sync rulesets (docs/protocol.md §17): `/api/v1/rulesets`.

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use axum_test::{TestServer, TestServerConfig, Transport};
use helixsync_server::config::Config;
use helixsync_server::middleware::rate_limit::{RateLimiter, RULESET_WRITE_LIMIT};
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
        backup: Default::default(),
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

/// A browser: its own cookie jar, so two of them are two signed-in accounts.
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

const PASSWORD: &str = "correct horse battery staple";

/// Registers `email` in `server`; returns its CSRF token.
async fn register(server: &TestServer, email: &str) -> String {
    let res = server
        .post("/api/v1/auth/register")
        .json(&json!({
            "email": email,
            "authKey": common::test_auth_key(PASSWORD),
            "kdfSalt": common::test_kdf_salt(),
            "kdfParams": common::test_kdf_params(),
            "wrappedAk": common::test_wrapped_ak(),
            "recoveryAuthKey": common::test_recovery_auth_key(),
            "recoveryWrappedAk": common::test_recovery_wrapped_ak(),
        }))
        .await;
    res.assert_status_ok();
    res.json::<Value>()["csrfToken"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn register_device(server: &TestServer, email: &str, name: &str) -> (Uuid, String) {
    let res = server
        .post("/api/v1/devices/register")
        .json(&json!({
            "email": email,
            "authKey": common::test_auth_key(PASSWORD),
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

fn envelope(tag: &str) -> Value {
    json!({
        "v": 2,
        "keyVersion": 1,
        "alg": "xchacha20poly1305",
        "nonce": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "ciphertext": tag,
    })
}

async fn list(server: &TestServer) -> Vec<Value> {
    let res = server.get("/api/v1/rulesets").await;
    res.assert_status_ok();
    res.json::<Value>()["rulesets"].as_array().unwrap().clone()
}

async fn create(server: &TestServer, csrf: &str, id: Uuid, tag: &str) -> axum_test::TestResponse {
    server
        .post("/api/v1/rulesets")
        .add_header("x-csrf-token", csrf)
        .json(&json!({ "id": id, "envelope": envelope(tag) }))
        .await
}

async fn update(
    server: &TestServer,
    csrf: &str,
    id: Uuid,
    if_match: Option<i64>,
    tag: &str,
) -> axum_test::TestResponse {
    let mut req = server
        .put(&format!("/api/v1/rulesets/{id}"))
        .add_header("x-csrf-token", csrf);
    if let Some(rev) = if_match {
        req = req.add_header("if-match", rev.to_string());
    }
    req.json(&json!({ "envelope": envelope(tag) })).await
}

async fn assign(
    server: &TestServer,
    csrf: &str,
    id: Uuid,
    device_ids: &[Uuid],
) -> axum_test::TestResponse {
    server
        .put(&format!("/api/v1/rulesets/{id}/devices"))
        .add_header("x-csrf-token", csrf)
        .json(&json!({ "deviceIds": device_ids }))
        .await
}

async fn device_rulesets(server: &TestServer, token: &str) -> Vec<Value> {
    let res = server
        .get("/api/v1/rulesets/self")
        .authorization_bearer(token)
        .await;
    res.assert_status_ok();
    res.json::<Value>()["rulesets"].as_array().unwrap().clone()
}

fn ids(v: &Value) -> Vec<Uuid> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|d| d.as_str().unwrap().parse().unwrap())
        .collect()
}

async fn user_id(pool: &PgPool, email: &str) -> Uuid {
    sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(email)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Inserts `n` active devices directly (an API registration costs an Argon2
/// run each).
async fn insert_devices(pool: &PgPool, user: Uuid, n: usize) -> Vec<Uuid> {
    let mut out = Vec::new();
    for i in 0..n {
        out.push(
            sqlx::query_scalar("INSERT INTO devices (user_id, name) VALUES ($1, $2) RETURNING id")
                .bind(user)
                .bind(format!("bulk-{i}"))
                .fetch_one(pool)
                .await
                .unwrap(),
        );
    }
    out
}

#[sqlx::test(migrations = "./migrations")]
async fn registering_creates_an_empty_default_and_new_devices_join_it(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    register(&server, "a@example.com").await;

    let rulesets = list(&server).await;
    assert_eq!(rulesets.len(), 1);
    assert_eq!(rulesets[0]["isDefault"], true);
    assert_eq!(rulesets[0]["revision"], 1);
    assert!(rulesets[0]["envelope"].is_null());
    assert_eq!(ids(&rulesets[0]["deviceIds"]), Vec::<Uuid>::new());

    let (device_id, token) = register_device(&server, "a@example.com", "Laptop").await;
    let rulesets = list(&server).await;
    assert_eq!(ids(&rulesets[0]["deviceIds"]), vec![device_id]);

    let own = device_rulesets(&server, &token).await;
    assert_eq!(own.len(), 1);
    assert_eq!(own[0]["id"], rulesets[0]["id"]);
    assert_eq!(own[0]["isDefault"], true);
    assert!(own[0]["envelope"].is_null());
}

#[sqlx::test(migrations = "./migrations")]
async fn create_update_and_delete_a_ruleset(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    let csrf = register(&server, "a@example.com").await;

    let id = Uuid::now_v7();
    let res = create(&server, &csrf, id, "v1").await;
    assert_eq!(res.status_code(), StatusCode::CREATED);
    let body: Value = res.json();
    assert_eq!(body["id"], json!(id));
    assert_eq!(body["revision"], 1);
    assert_eq!(body["isDefault"], false);
    assert_eq!(body["envelope"], envelope("v1"));

    // Default first, then the new one.
    let rulesets = list(&server).await;
    assert_eq!(rulesets.len(), 2);
    assert_eq!(rulesets[0]["isDefault"], true);
    assert_eq!(rulesets[1]["id"], json!(id));

    let res = update(&server, &csrf, id, Some(1), "v2").await;
    res.assert_status_ok();
    let body: Value = res.json();
    assert_eq!(body["revision"], 2);
    assert_eq!(body["envelope"], envelope("v2"));

    // A quoted If-Match is accepted too.
    let res = server
        .put(&format!("/api/v1/rulesets/{id}"))
        .add_header("x-csrf-token", &csrf)
        .add_header("if-match", "\"2\"")
        .json(&json!({ "envelope": envelope("v3") }))
        .await;
    res.assert_status_ok();
    assert_eq!(res.json::<Value>()["revision"], 3);

    server
        .delete(&format!("/api/v1/rulesets/{id}"))
        .add_header("x-csrf-token", &csrf)
        .await
        .assert_status(StatusCode::NO_CONTENT);
    assert_eq!(list(&server).await.len(), 1);
    server
        .delete(&format!("/api/v1/rulesets/{id}"))
        .add_header("x-csrf-token", &csrf)
        .await
        .assert_status_not_found();
}

#[sqlx::test(migrations = "./migrations")]
async fn a_stale_revision_conflicts_and_a_missing_if_match_is_refused(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    let csrf = register(&server, "a@example.com").await;
    let id = Uuid::now_v7();
    create(&server, &csrf, id, "v1")
        .await
        .assert_status(StatusCode::CREATED);

    update(&server, &csrf, id, Some(1), "v2")
        .await
        .assert_status_ok();
    // A second save from the same base revision loses.
    let res = update(&server, &csrf, id, Some(1), "stale").await;
    res.assert_status(StatusCode::CONFLICT);
    assert_eq!(res.json::<Value>()["error"], "revision_conflict");
    update(&server, &csrf, id, None, "x")
        .await
        .assert_status_bad_request();
    // Unknown id is a 404, not a conflict.
    update(&server, &csrf, Uuid::now_v7(), Some(1), "x")
        .await
        .assert_status_not_found();

    // The stored envelope is still the winner's.
    let rulesets = list(&server).await;
    assert_eq!(rulesets[1]["envelope"], envelope("v2"));
    assert_eq!(rulesets[1]["revision"], 2);
}

#[sqlx::test(migrations = "./migrations")]
async fn the_default_can_be_edited_but_not_deleted(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    let csrf = register(&server, "a@example.com").await;
    let default_id: Uuid = list(&server).await[0]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();

    server
        .delete(&format!("/api/v1/rulesets/{default_id}"))
        .add_header("x-csrf-token", &csrf)
        .await
        .assert_status(StatusCode::CONFLICT);

    // The first save writes its envelope; the revision moves 1 -> 2.
    let res = update(&server, &csrf, default_id, Some(1), "rules").await;
    res.assert_status_ok();
    assert_eq!(res.json::<Value>()["revision"], 2);
    let rulesets = list(&server).await;
    assert_eq!(rulesets.len(), 1);
    assert_eq!(rulesets[0]["envelope"], envelope("rules"));
}

#[sqlx::test(migrations = "./migrations")]
async fn envelopes_are_validated(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    let csrf = register(&server, "a@example.com").await;

    let post = |body: Value| {
        let server = &server;
        let csrf = csrf.clone();
        async move {
            server
                .post("/api/v1/rulesets")
                .add_header("x-csrf-token", &csrf)
                .json(&body)
                .await
        }
    };
    let id = Uuid::now_v7();
    post(json!({ "id": id, "envelope": "text" }))
        .await
        .assert_status_bad_request();
    post(json!({ "id": id, "envelope": { "v": 1, "keyVersion": 1, "alg": "xchacha20poly1305", "nonce": "a", "ciphertext": "b" } }))
        .await
        .assert_status_bad_request();
    post(json!({ "id": id, "envelope": { "v": 2 } }))
        .await
        .assert_status_bad_request();
    let mut big = envelope("x");
    big["ciphertext"] = json!("A".repeat(65 * 1024));
    post(json!({ "id": id, "envelope": big }))
        .await
        .assert_status_bad_request();
    // A plain-JSON (unencrypted) ruleset is not an envelope.
    post(json!({ "id": id, "envelope": { "name": "Work", "rules": [] } }))
        .await
        .assert_status_bad_request();
    assert_eq!(list(&server).await.len(), 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn creating_twice_with_one_id_conflicts_and_the_account_is_capped(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    let csrf = register(&server, "a@example.com").await;
    let id = Uuid::now_v7();
    create(&server, &csrf, id, "a")
        .await
        .assert_status(StatusCode::CREATED);
    let res = create(&server, &csrf, id, "b").await;
    res.assert_status(StatusCode::CONFLICT);
    assert_eq!(res.json::<Value>()["error"], "ruleset_exists");

    // Another account can't take an id this one holds, and learns nothing.
    let other = browser(&state);
    let other_csrf = register(&other, "b@example.com").await;
    let res = create(&other, &other_csrf, id, "c").await;
    res.assert_status(StatusCode::CONFLICT);
    assert_eq!(res.json::<Value>()["error"], "ruleset_exists");

    // Default + 1 so far; the cap is 100 in all.
    sqlx::query(
        "INSERT INTO sync_rulesets (user_id, envelope)
         SELECT id, '{\"v\":2}'::jsonb FROM users u, generate_series(1, 98) WHERE u.email = 'a@example.com'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let res = create(&server, &csrf, Uuid::now_v7(), "z").await;
    res.assert_status(StatusCode::CONFLICT);
    assert_eq!(res.json::<Value>()["error"], "ruleset_limit_reached");
}

#[sqlx::test(migrations = "./migrations")]
async fn rulesets_belong_to_their_account(pool: PgPool) {
    let state = state_for(pool.clone());
    let alice = browser(&state);
    let alice_csrf = register(&alice, "alice@example.com").await;
    let (alice_device, _) = register_device(&alice, "alice@example.com", "A").await;
    let bob = browser(&state);
    let bob_csrf = register(&bob, "bob@example.com").await;
    let (bob_device, bob_token) = register_device(&bob, "bob@example.com", "B").await;

    let id = Uuid::now_v7();
    create(&alice, &alice_csrf, id, "secret")
        .await
        .assert_status(StatusCode::CREATED);

    assert_eq!(list(&bob).await.len(), 1, "only Bob's own Default");
    update(&bob, &bob_csrf, id, Some(1), "x")
        .await
        .assert_status_not_found();
    bob.delete(&format!("/api/v1/rulesets/{id}"))
        .add_header("x-csrf-token", &bob_csrf)
        .await
        .assert_status_not_found();
    assign(&bob, &bob_csrf, id, &[bob_device])
        .await
        .assert_status_not_found();

    // Bob can't assign his own ruleset to Alice's device, nor Alice's device
    // to his ruleset; the answer is the same as for an unknown device.
    let bob_default: Uuid = list(&bob).await[0]["id"].as_str().unwrap().parse().unwrap();
    assign(&bob, &bob_csrf, bob_default, &[alice_device])
        .await
        .assert_status_bad_request();
    assign(&bob, &bob_csrf, bob_default, &[Uuid::now_v7()])
        .await
        .assert_status_bad_request();
    assert_eq!(device_rulesets(&bob, &bob_token).await.len(), 1);

    // Alice's ruleset is untouched.
    assert_eq!(list(&alice).await[1]["envelope"], envelope("secret"));
}

#[sqlx::test(migrations = "./migrations")]
async fn a_device_can_be_in_several_rulesets_and_assignment_replaces_the_list(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    let csrf = register(&server, "a@example.com").await;
    let (d1, t1) = register_device(&server, "a@example.com", "One").await;
    let (d2, t2) = register_device(&server, "a@example.com", "Two").await;

    let work = Uuid::now_v7();
    let social = Uuid::now_v7();
    create(&server, &csrf, work, "work").await;
    create(&server, &csrf, social, "social").await;

    let res = assign(&server, &csrf, work, &[d1, d2]).await;
    res.assert_status_ok();
    assert_eq!(ids(&res.json::<Value>()["deviceIds"]).len(), 2);
    assign(&server, &csrf, social, &[d1])
        .await
        .assert_status_ok();

    // d1 is in Default + Work + Social; d2 in Default + Work.
    let own1 = device_rulesets(&server, &t1).await;
    assert_eq!(own1.len(), 3);
    assert_eq!(own1[0]["isDefault"], true, "Default first");
    let own2 = device_rulesets(&server, &t2).await;
    assert_eq!(own2.len(), 2);

    // Replace: Work now holds only d2.
    assign(&server, &csrf, work, &[d2, d2])
        .await
        .assert_status_ok();
    let rulesets = list(&server).await;
    let work_entry = rulesets.iter().find(|r| r["id"] == json!(work)).unwrap();
    assert_eq!(ids(&work_entry["deviceIds"]), vec![d2]);
    assert_eq!(device_rulesets(&server, &t1).await.len(), 2);

    // Empty list unassigns everyone; Default stays assignable and removable.
    assign(&server, &csrf, work, &[]).await.assert_status_ok();
    let default_id: Uuid = rulesets[0]["id"].as_str().unwrap().parse().unwrap();
    assign(&server, &csrf, default_id, &[])
        .await
        .assert_status_ok();
    assert_eq!(device_rulesets(&server, &t2).await.len(), 0);
}

#[sqlx::test(migrations = "./migrations")]
async fn bulk_assignment_of_hundreds_of_devices(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    let csrf = register(&server, "a@example.com").await;
    let user = user_id(&pool, "a@example.com").await;
    let devices = insert_devices(&pool, user, 300).await;
    let work = Uuid::now_v7();
    create(&server, &csrf, work, "work").await;

    let res = assign(&server, &csrf, work, &devices).await;
    res.assert_status_ok();
    assert_eq!(ids(&res.json::<Value>()["deviceIds"]).len(), 300);
    let rulesets = list(&server).await;
    let entry = rulesets.iter().find(|r| r["id"] == json!(work)).unwrap();
    assert_eq!(ids(&entry["deviceIds"]).len(), 300);

    // Shrink to 100, then drop to none.
    assign(&server, &csrf, work, &devices[..100])
        .await
        .assert_status_ok();
    let n: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_ruleset_assignments WHERE ruleset_id = $1")
            .bind(work)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(n, 100);
}

#[sqlx::test(migrations = "./migrations")]
async fn deleting_a_ruleset_removes_its_assignments(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    let csrf = register(&server, "a@example.com").await;
    let (d1, t1) = register_device(&server, "a@example.com", "One").await;
    let work = Uuid::now_v7();
    create(&server, &csrf, work, "work").await;
    assign(&server, &csrf, work, &[d1]).await.assert_status_ok();
    assert_eq!(device_rulesets(&server, &t1).await.len(), 2);

    server
        .delete(&format!("/api/v1/rulesets/{work}"))
        .add_header("x-csrf-token", &csrf)
        .await
        .assert_status(StatusCode::NO_CONTENT);
    let own = device_rulesets(&server, &t1).await;
    assert_eq!(own.len(), 1);
    assert_eq!(own[0]["isDefault"], true);
    let n: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sync_ruleset_assignments WHERE ruleset_id = $1")
            .bind(work)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(n, 0);
}

#[sqlx::test(migrations = "./migrations")]
async fn revoking_a_device_drops_its_assignments(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    let csrf = register(&server, "a@example.com").await;
    let (d1, _t1) = register_device(&server, "a@example.com", "One").await;
    let (d2, t2) = register_device(&server, "a@example.com", "Two").await;
    let work = Uuid::now_v7();
    create(&server, &csrf, work, "work").await;
    assign(&server, &csrf, work, &[d1, d2])
        .await
        .assert_status_ok();

    // Revoked from the dashboard.
    server
        .post(&format!("/api/v1/devices/{d1}/revoke"))
        .add_header("x-csrf-token", &csrf)
        .await
        .assert_status_ok();
    // Revoked by the device itself.
    server
        .post("/api/v1/devices/self/revoke")
        .authorization_bearer(&t2)
        .await
        .assert_status(StatusCode::NO_CONTENT);

    for r in list(&server).await {
        assert_eq!(ids(&r["deviceIds"]), Vec::<Uuid>::new());
    }
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_ruleset_assignments")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);

    // A revoked device can't be assigned.
    assign(&server, &csrf, work, &[d1])
        .await
        .assert_status_bad_request();
}

#[sqlx::test(migrations = "./migrations")]
async fn dashboard_routes_need_a_session_and_a_csrf_token_and_self_needs_a_device(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    let csrf = register(&server, "a@example.com").await;
    let (d1, token) = register_device(&server, "a@example.com", "One").await;
    let id = Uuid::now_v7();
    create(&server, &csrf, id, "x")
        .await
        .assert_status(StatusCode::CREATED);

    // Mutations without the CSRF header.
    server
        .post("/api/v1/rulesets")
        .json(&json!({ "id": Uuid::now_v7(), "envelope": envelope("x") }))
        .await
        .assert_status_forbidden();
    server
        .put(&format!("/api/v1/rulesets/{id}"))
        .add_header("if-match", "1")
        .json(&json!({ "envelope": envelope("y") }))
        .await
        .assert_status_forbidden();
    server
        .put(&format!("/api/v1/rulesets/{id}/devices"))
        .json(&json!({ "deviceIds": [d1] }))
        .await
        .assert_status_forbidden();
    server
        .delete(&format!("/api/v1/rulesets/{id}"))
        .await
        .assert_status_forbidden();

    // No credentials at all.
    let anon = browser(&state);
    anon.get("/api/v1/rulesets")
        .await
        .assert_status_unauthorized();
    anon.get("/api/v1/rulesets/self")
        .await
        .assert_status_unauthorized();

    // A device token is not a dashboard session.
    let device_only = browser(&state);
    device_only
        .get("/api/v1/rulesets")
        .authorization_bearer(&token)
        .await
        .assert_status_unauthorized();
    device_only
        .post("/api/v1/rulesets")
        .authorization_bearer(&token)
        .json(&json!({ "id": Uuid::now_v7(), "envelope": envelope("x") }))
        .await
        .assert_status_unauthorized();

    // A dashboard session is not a device.
    let session_only = browser(&state);
    session_only
        .post("/api/v1/auth/login")
        .json(&json!({ "email": "a@example.com", "authKey": common::test_auth_key(PASSWORD) }))
        .await
        .assert_status_ok();
    session_only
        .get("/api/v1/rulesets/self")
        .await
        .assert_status_unauthorized();
}

#[sqlx::test(migrations = "./migrations")]
async fn affected_devices_are_pinged_over_the_websocket(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    let csrf = register(&server, "a@example.com").await;
    let user = user_id(&pool, "a@example.com").await;
    let (d1, _) = register_device(&server, "a@example.com", "One").await;
    let (d2, _) = register_device(&server, "a@example.com", "Two").await;
    let (d3, _) = register_device(&server, "a@example.com", "Three").await;
    let mut rxs = Vec::new();
    for d in [d1, d2, d3] {
        let (tx, rx) = tokio::sync::mpsc::channel::<String>(8);
        state.ws_registry.register(user, d, tx);
        rxs.push(rx);
    }
    let ping = r#"{"type":"ruleset_changed"}"#;

    let work = Uuid::now_v7();
    create(&server, &csrf, work, "work").await;
    // Creating a ruleset affects nobody.
    assert!(rxs.iter_mut().all(|rx| rx.try_recv().is_err()));

    // Assigning pings the devices whose membership changed: d1 and d2.
    assign(&server, &csrf, work, &[d1, d2])
        .await
        .assert_status_ok();
    assert_eq!(rxs[0].try_recv().as_deref(), Ok(ping));
    assert_eq!(rxs[1].try_recv().as_deref(), Ok(ping));
    assert!(rxs[2].try_recv().is_err());

    // d2 leaves, d3 joins: d1 is unchanged and not pinged.
    assign(&server, &csrf, work, &[d1, d3])
        .await
        .assert_status_ok();
    assert!(rxs[0].try_recv().is_err());
    assert_eq!(rxs[1].try_recv().as_deref(), Ok(ping));
    assert_eq!(rxs[2].try_recv().as_deref(), Ok(ping));

    // Editing pings every assigned device.
    update(&server, &csrf, work, Some(1), "work2")
        .await
        .assert_status_ok();
    assert_eq!(rxs[0].try_recv().as_deref(), Ok(ping));
    assert!(rxs[1].try_recv().is_err());
    assert_eq!(rxs[2].try_recv().as_deref(), Ok(ping));

    // Deleting pings the devices that were in it.
    server
        .delete(&format!("/api/v1/rulesets/{work}"))
        .add_header("x-csrf-token", &csrf)
        .await
        .assert_status(StatusCode::NO_CONTENT);
    assert_eq!(rxs[0].try_recv().as_deref(), Ok(ping));
    assert!(rxs[1].try_recv().is_err());
    assert_eq!(rxs[2].try_recv().as_deref(), Ok(ping));
}

#[sqlx::test(migrations = "./migrations")]
async fn changes_are_audited(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    let csrf = register(&server, "a@example.com").await;
    let (d1, _) = register_device(&server, "a@example.com", "One").await;
    let id = Uuid::now_v7();
    create(&server, &csrf, id, "a").await;
    update(&server, &csrf, id, Some(1), "b").await;
    assign(&server, &csrf, id, &[d1]).await;
    server
        .delete(&format!("/api/v1/rulesets/{id}"))
        .add_header("x-csrf-token", &csrf)
        .await;

    let events: Vec<String> = sqlx::query_scalar(
        "SELECT event_type FROM audit_logs WHERE event_type LIKE 'ruleset_%' ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        events,
        [
            "ruleset_created",
            "ruleset_updated",
            "ruleset_assigned",
            "ruleset_deleted"
        ]
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn writes_are_rate_limited(pool: PgPool) {
    let state = state_for(pool.clone());
    let server = browser(&state);
    let csrf = register(&server, "a@example.com").await;
    let default_id: Uuid = list(&server).await[0]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();

    let mut limited = false;
    for _ in 0..(RULESET_WRITE_LIMIT.limit + 5) {
        let res = assign(&server, &csrf, default_id, &[]).await;
        if res.status_code() == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
            break;
        }
    }
    assert!(limited, "expected a 429 after the write limit");
}

#[sqlx::test(migrations = "./migrations")]
async fn the_version_endpoint_advertises_rulesets(pool: PgPool) {
    let state = state_for(pool);
    let server = browser(&state);
    let res = server.get("/api/v1/version").await;
    res.assert_status_ok();
    assert_eq!(res.json::<Value>()["rulesets"], true);
}

/// The migration, run on a database that already has accounts and devices:
/// every account gets an empty Default, every active device joins it, a
/// revoked one doesn't.
#[sqlx::test(migrations = false)]
async fn migration_backfills_existing_accounts_and_devices(pool: PgPool) {
    for sql in [
        include_str!("../migrations/0001_init.sql"),
        include_str!("../migrations/0002_restore_points.sql"),
        include_str!("../migrations/0003_recovery_safeguards.sql"),
    ] {
        sqlx::raw_sql(sql).execute(&pool).await.unwrap();
    }

    let mut users = Vec::new();
    for email in ["old1@example.com", "old2@example.com"] {
        users.push(
            sqlx::query_scalar::<_, Uuid>(
                "INSERT INTO users (email, password_hash, kdf_salt, kdf_params, wrapped_account_key,
                    recovery_auth_hash, recovery_wrapped_account_key)
                 VALUES ($1, 'h', 's', '{}'::jsonb, 'w', 'rh', 'rw') RETURNING id",
            )
            .bind(email)
            .fetch_one(&pool)
            .await
            .unwrap(),
        );
    }
    let active1: Uuid =
        sqlx::query_scalar("INSERT INTO devices (user_id, name) VALUES ($1, 'a') RETURNING id")
            .bind(users[0])
            .fetch_one(&pool)
            .await
            .unwrap();
    let active2: Uuid =
        sqlx::query_scalar("INSERT INTO devices (user_id, name) VALUES ($1, 'b') RETURNING id")
            .bind(users[1])
            .fetch_one(&pool)
            .await
            .unwrap();
    let revoked: Uuid = sqlx::query_scalar(
        "INSERT INTO devices (user_id, name, revoked_at) VALUES ($1, 'gone', now()) RETURNING id",
    )
    .bind(users[0])
    .fetch_one(&pool)
    .await
    .unwrap();

    sqlx::raw_sql(include_str!("../migrations/0004_rulesets.sql"))
        .execute(&pool)
        .await
        .unwrap();

    let defaults: Vec<(Uuid, Uuid, i64, bool)> = sqlx::query_as(
        "SELECT id, user_id, revision, envelope IS NULL FROM sync_rulesets WHERE is_default ORDER BY user_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(defaults.len(), 2);
    for (_, _, revision, empty) in &defaults {
        assert_eq!(*revision, 1);
        assert!(*empty);
    }

    let assigned: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT ruleset_id, device_id FROM sync_ruleset_assignments ORDER BY device_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(assigned.len(), 2);
    let default_of = |user: Uuid| defaults.iter().find(|d| d.1 == user).unwrap().0;
    assert!(assigned.contains(&(default_of(users[0]), active1)));
    assert!(assigned.contains(&(default_of(users[1]), active2)));
    assert!(!assigned.iter().any(|(_, d)| *d == revoked));

    // One Default per account.
    let dup = sqlx::query("INSERT INTO sync_rulesets (user_id, is_default) VALUES ($1, true)")
        .bind(users[0])
        .execute(&pool)
        .await;
    assert!(dup.is_err());
    // A non-Default ruleset needs an envelope.
    let empty = sqlx::query("INSERT INTO sync_rulesets (user_id) VALUES ($1)")
        .bind(users[0])
        .execute(&pool)
        .await;
    assert!(empty.is_err());
}
