use std::sync::Arc;
use std::time::Instant;

use axum_test::{TestServer, TestServerConfig, Transport, WsMessage};
use helixsync_server::config::Config;
use helixsync_server::state::AppState;
use helixsync_server::websocket::ConnectionRegistry;
use serde_json::json;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tokio::sync::{mpsc, Barrier};
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
        tombstone_retention_secs: 60 * 60 * 24 * 30,
        compaction_interval_secs: 60 * 60,
        inactive_device_compaction_grace_period_secs: 60 * 60 * 24 * 30,
        never_synced_device_compaction_grace_period_secs: 60 * 60 * 24 * 30,
        housekeeping_interval_secs: 60 * 60 * 24,
        device_credential_retention_secs: 60 * 60 * 24 * 7,
        audit_log_retention_secs: 60 * 60 * 24 * 90,
        ephemeral_tombstone_retention_secs: 60 * 60 * 24 * 30,
        database_max_connections: 5,
        // Short so tests don't wait 30s for the re-check tick.
        websocket_ping_interval_secs: 1,
        max_devices_per_account: 25,
        request_timeout_secs: 30,
        websocket_send_timeout_secs: 10,
        upload_semaphore_acquire_timeout_secs: 20,
        shutdown_deadline_secs: 30,
    }
}

struct Harness {
    server: TestServer,
    state: AppState,
}

fn harness_for(pool: PgPool, config: Config) -> Harness {
    harness_for_with_cache(pool, config, Arc::new(dashmap::DashMap::new()))
}

/// Like `harness_for`, but shares a given `device_revocation_cache` between
/// two `AppState`s (one with a broken DB, one healthy).
fn harness_for_with_cache(
    pool: PgPool,
    config: Config,
    device_revocation_cache: Arc<dashmap::DashMap<Uuid, (Instant, bool)>>,
) -> Harness {
    let state = AppState {
        db: pool,
        config: Arc::new(config),
        rate_limiter: Arc::new(helixsync_server::middleware::rate_limit::RateLimiter::new()),
        ws_registry: Arc::new(ConnectionRegistry::new()),
        last_seen_cache: Arc::new(dashmap::DashMap::new()),
        device_revocation_cache,
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
    let make_service = helixsync_server::app(state.clone())
        .into_make_service_with_connect_info::<std::net::SocketAddr>();
    let server = TestServer::new_with_config(make_service, test_server_config).unwrap();
    Harness { server, state }
}

async fn register_and_login(server: &TestServer, email: &str) {
    let res = server
        .post("/api/v1/auth/register")
        .json(&json!({ "email": email, "password": "correct horse battery staple" }))
        .await;
    res.assert_status_ok();
}

async fn register_device(server: &TestServer, email: &str, name: &str) -> (Uuid, String) {
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
        Uuid::parse_str(body["deviceId"].as_str().unwrap()).unwrap(),
        body["accessToken"].as_str().unwrap().to_string(),
    )
}

/// A device revoked without `revoke_device` (e.g. a direct DB update) must
/// still be disconnected. We only update the cache, so the socket's periodic
/// re-check is the only thing that can catch it. With a 1s ping interval,
/// the next tick must send `session_expired` and close.
#[sqlx::test(migrations = "./migrations")]
async fn revoked_device_socket_closes_on_next_ping_tick(pool: PgPool) {
    let harness = harness_for(pool, test_config());
    register_and_login(&harness.server, "revoked-device@example.com").await;
    let (device_id, access_token) =
        register_device(&harness.server, "revoked-device@example.com", "Laptop").await;

    let mut ws = harness
        .server
        .get_websocket("/api/v1/ws")
        .await
        .into_websocket()
        .await;

    ws.send_text(access_token).await;
    let connected: serde_json::Value = ws.receive_json().await;
    assert_eq!(connected["type"], "connected");

    // Revoke without calling `revoke_device`, so only the periodic re-check
    // can catch it.
    harness
        .state
        .device_revocation_cache
        .insert(device_id, (Instant::now(), false));

    // Skip pings until the close message arrives.
    loop {
        match ws.receive_message().await {
            WsMessage::Ping(_) => continue,
            WsMessage::Text(text) => {
                let value: serde_json::Value = serde_json::from_str(&text).unwrap();
                assert_eq!(value["type"], "session_expired");
                break;
            }
            other => panic!("expected a session_expired text frame, got {other:?}"),
        }
    }

    match ws.receive_message().await {
        WsMessage::Close(_) => {}
        other => panic!("expected the server to close the socket, got {other:?}"),
    }
}

/// An access token that expires while the socket is open must also close
/// it. The token TTL is shortened to 2s for the test.
#[sqlx::test(migrations = "./migrations")]
async fn expired_token_socket_closes_on_next_ping_tick(pool: PgPool) {
    let config = Config {
        access_token_ttl_secs: 2,
        ..test_config()
    };
    let harness = harness_for(pool, config);
    register_and_login(&harness.server, "expiring-token@example.com").await;
    let (_device_id, access_token) =
        register_device(&harness.server, "expiring-token@example.com", "Laptop").await;

    let mut ws = harness
        .server
        .get_websocket("/api/v1/ws")
        .await
        .into_websocket()
        .await;

    ws.send_text(access_token).await;
    let connected: serde_json::Value = ws.receive_json().await;
    assert_eq!(connected["type"], "connected");

    // The token expires during this loop; the next tick must close the socket.
    loop {
        match ws.receive_message().await {
            WsMessage::Ping(_) => continue,
            WsMessage::Text(text) => {
                let value: serde_json::Value = serde_json::from_str(&text).unwrap();
                assert_eq!(value["type"], "session_expired");
                break;
            }
            other => panic!("expected a session_expired text frame, got {other:?}"),
        }
    }

    match ws.receive_message().await {
        WsMessage::Close(_) => {}
        other => panic!("expected the server to close the socket, got {other:?}"),
    }
}

/// Clients should only send the auth frame. Any later text/binary frame
/// must close the connection.
#[sqlx::test(migrations = "./migrations")]
async fn unexpected_data_frame_closes_the_socket(pool: PgPool) {
    let harness = harness_for(pool, test_config());
    register_and_login(&harness.server, "chatty-client@example.com").await;
    let (_device_id, access_token) =
        register_device(&harness.server, "chatty-client@example.com", "Laptop").await;

    let mut ws = harness
        .server
        .get_websocket("/api/v1/ws")
        .await
        .into_websocket()
        .await;

    ws.send_text(access_token).await;
    let connected: serde_json::Value = ws.receive_json().await;
    assert_eq!(connected["type"], "connected");

    // A frame the server never expects from a client.
    ws.send_message(WsMessage::Binary(vec![0u8; 4096])).await;

    // A ping may arrive first; skip pings until the socket closes.
    loop {
        match ws.receive_message().await {
            WsMessage::Ping(_) => continue,
            WsMessage::Close(_) => break,
            other => panic!(
                "expected the server to close the socket after an unexpected data frame, got {other:?}"
            ),
        }
    }
}

/// A DB error during the websocket's device check must not write "revoked"
/// into the shared cache, or the device's HTTP requests would get 401s too.
///
/// Uses two `AppState`s sharing one `device_revocation_cache`: one with a
/// DB that can't be reached, one healthy. The socket fails on the broken
/// one; the cache must stay empty and HTTP on the healthy one must work.
#[sqlx::test(migrations = "./migrations")]
async fn db_error_on_ws_check_does_not_poison_http_revocation_cache(pool: PgPool) {
    let config = test_config();
    let healthy = harness_for(pool, config.clone());

    register_and_login(&healthy.server, "flaky-db@example.com").await;
    let (device_id, access_token) =
        register_device(&healthy.server, "flaky-db@example.com", "Laptop").await;

    // Nothing listens on this port, so every query fails fast.
    // `connect_lazy` doesn't connect until the first query.
    let broken_pool = PgPoolOptions::new()
        // Short, so the test doesn't wait the default 30s.
        .acquire_timeout(std::time::Duration::from_millis(500))
        .connect_lazy("postgres://baduser:badpass@127.0.0.1:1/nonexistent")
        .expect("connect_lazy must not eagerly connect");

    let broken = harness_for_with_cache(
        broken_pool,
        config,
        healthy.state.device_revocation_cache.clone(),
    );

    // The connect check hits the broken DB and fails. The cache must be
    // left alone and the socket closed.
    let mut ws = broken
        .server
        .get_websocket("/api/v1/ws")
        .await
        .into_websocket()
        .await;
    ws.send_text(access_token.clone()).await;

    match ws.receive_message().await {
        WsMessage::Close(_) => {}
        other => panic!(
            "expected the broken-pool connect to fail closed and close the socket, got {other:?}"
        ),
    }

    // A DB error must never write "revoked" into the cache.
    assert!(
        healthy
            .state
            .device_revocation_cache
            .get(&device_id)
            .is_none(),
        "a DB error during the WS check must not write anything into device_revocation_cache"
    );

    // So HTTP from the same device on the healthy DB is not a 401.
    let stats_res = healthy
        .server
        .get("/api/v1/sync/stats")
        .authorization_bearer(&access_token)
        .await;
    stats_res.assert_status_ok();
}

/// An old connection's `unregister` must never delete a new connection for
/// the same user that registered at the same moment.
///
/// No DB needed. Runs both calls at once many times (using a `Barrier`) so
/// they really race.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn racing_register_survives_stale_unregister_cleanup() {
    for _ in 0..200 {
        let registry = Arc::new(ConnectionRegistry::new());
        let user_id = Uuid::new_v4();
        let old_device_id = Uuid::new_v4();
        let new_device_id = Uuid::new_v4();

        let (old_tx, _old_rx) = mpsc::channel::<String>(32);
        let old_id = registry.register(user_id, old_device_id, old_tx);

        // Start both tasks at the same time so they race.
        let barrier = Arc::new(Barrier::new(2));

        let unregister_task = {
            let registry = registry.clone();
            let barrier = barrier.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                registry.unregister(user_id, old_id);
            })
        };

        let (new_tx, mut new_rx) = mpsc::channel::<String>(32);
        let register_task = {
            let registry = registry.clone();
            let barrier = barrier.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                registry.register(user_id, new_device_id, new_tx);
            })
        };

        unregister_task.await.unwrap();
        register_task.await.unwrap();

        // Whichever ran first, the new connection must still be live.
        registry.notify_changes(user_id, 42, None);
        assert_eq!(
            new_rx.recv().await.as_deref(),
            Some(r#"{"type":"changes_available","cursor":42}"#),
            "a fresh register raced with unregister's cleanup of the old \
             connection and the new connection did not survive"
        );
    }
}

/// Same race, but with `disconnect_device` instead of `unregister`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn racing_register_survives_stale_disconnect_device_cleanup() {
    for _ in 0..200 {
        let registry = Arc::new(ConnectionRegistry::new());
        let user_id = Uuid::new_v4();
        let old_device_id = Uuid::new_v4();
        let new_device_id = Uuid::new_v4();

        let (old_tx, mut old_rx) = mpsc::channel::<String>(32);
        registry.register(user_id, old_device_id, old_tx);

        let barrier = Arc::new(Barrier::new(2));

        let disconnect_task = {
            let registry = registry.clone();
            let barrier = barrier.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                registry.disconnect_device(user_id, old_device_id);
            })
        };

        let (new_tx, mut new_rx) = mpsc::channel::<String>(32);
        let register_task = {
            let registry = registry.clone();
            let barrier = barrier.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                registry.register(user_id, new_device_id, new_tx);
            })
        };

        disconnect_task.await.unwrap();
        register_task.await.unwrap();

        // The revoked device's channel still closes.
        assert_eq!(old_rx.recv().await, None);

        registry.notify_changes(user_id, 7, None);
        assert_eq!(
            new_rx.recv().await.as_deref(),
            Some(r#"{"type":"changes_available","cursor":7}"#),
            "a fresh register raced with disconnect_device's cleanup of the \
             old connection and the new connection did not survive"
        );
    }
}
