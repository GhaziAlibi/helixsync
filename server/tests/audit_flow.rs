use std::io;
use std::sync::{Arc, Mutex};

use helixsync_server::audit;
use helixsync_server::config::Config;
use helixsync_server::middleware::rate_limit::RateLimiter;
use helixsync_server::state::AppState;
use helixsync_server::websocket::ConnectionRegistry;
use sqlx::PgPool;
use tracing_subscriber::fmt::MakeWriter;
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

/// In-memory `tracing` writer so tests can check log output without a
/// global subscriber.
#[derive(Clone)]
struct BufWriter(Arc<Mutex<Vec<u8>>>);

impl io::Write for BufWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for BufWriter {
    type Writer = BufWriter;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// `tracing` remembers per call site whether anyone listens. If the first
/// call happens with no subscriber, later scoped subscribers are ignored.
/// Setting a global default once up front avoids that.
fn ensure_tracing_interest_cache_is_seeded_open() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let _ = tracing::subscriber::set_global_default(
            tracing_subscriber::fmt().with_test_writer().finish(),
        );
    });
}

/// A failed audit insert must log an error. Forces a failure with a
/// `user_id` that doesn't exist (foreign-key violation).
#[sqlx::test(migrations = "./migrations")]
async fn log_write_failure_is_logged_instead_of_silently_discarded(pool: PgPool) {
    ensure_tracing_interest_cache_is_seeded_open();
    let state = state_for(pool);
    let buf = Arc::new(Mutex::new(Vec::new()));
    let subscriber = tracing_subscriber::fmt()
        .with_writer(BufWriter(buf.clone()))
        .with_ansi(false)
        .finish();

    let nonexistent_user_id = Uuid::new_v4();
    // The task may move between threads, so use `with_subscriber` (applied
    // on every poll) instead of the thread-local `set_default`.
    use tracing::instrument::WithSubscriber;
    audit::log(
        &state,
        Some(nonexistent_user_id),
        None,
        "login_failed_regression_probe",
    )
    .with_subscriber(subscriber)
    .await;

    let output = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
    assert!(
        output.contains("audit: log write failed"),
        "expected the insert failure to produce an error log line, got: {output:?}"
    );
    assert!(
        output.contains("login_failed_regression_probe"),
        "expected the failed event's type to be included in the log line, got: {output:?}"
    );
}

/// The forced failure really skips the insert, and `audit::log` still
/// returns normally (an audit failure never fails the request).
#[sqlx::test(migrations = "./migrations")]
async fn log_write_failure_does_not_insert_a_row_or_panic(pool: PgPool) {
    ensure_tracing_interest_cache_is_seeded_open();
    let state = state_for(pool.clone());
    let nonexistent_user_id = Uuid::new_v4();

    audit::log(
        &state,
        Some(nonexistent_user_id),
        None,
        "login_failed_regression_probe",
    )
    .await;

    let row_count = sqlx::query_scalar!(
        "SELECT count(*) FROM audit_logs WHERE event_type = 'login_failed_regression_probe'"
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .unwrap_or(0);

    assert_eq!(
        row_count, 0,
        "the failed insert should not have written a row"
    );
}
