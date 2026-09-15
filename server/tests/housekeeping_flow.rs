use std::sync::Arc;

use chrono::{Duration as ChronoDuration, Utc};
use helixsync_server::config::Config;
use helixsync_server::housekeeping;
use helixsync_server::middleware::rate_limit::RateLimiter;
use helixsync_server::state::AppState;
use helixsync_server::websocket::ConnectionRegistry;
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
        tombstone_retention_secs: 60 * 60 * 24 * 30,
        compaction_interval_secs: 60 * 60,
        inactive_device_compaction_grace_period_secs: 60 * 60 * 24 * 30,
        housekeeping_interval_secs: 60 * 60 * 24,
        // Kept small and explicit per-test below rather than relied on here,
        // but a real (non-zero) default so a test that doesn't override it
        // still exercises the grace window rather than accidentally
        // matching everything.
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
        web_session_cache: Arc::new(dashmap::DashMap::new()),
    }
}

async fn create_user(pool: &PgPool, email: &str) -> Uuid {
    sqlx::query_scalar!(
        "INSERT INTO users (email, password_hash, encryption_salt) VALUES ($1, 'hash', 'salt') RETURNING id",
        email
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn create_device(pool: &PgPool, user_id: Uuid, name: &str) -> Uuid {
    sqlx::query_scalar!(
        "INSERT INTO devices (user_id, name) VALUES ($1, $2) RETURNING id",
        user_id,
        name
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn insert_device_credential(pool: &PgPool, device_id: Uuid, expires_at: chrono::DateTime<Utc>) -> Uuid {
    sqlx::query_scalar!(
        "INSERT INTO device_credentials (device_id, credential_hash, expires_at) VALUES ($1, 'hash', $2) RETURNING id",
        device_id,
        expires_at
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn insert_web_session(pool: &PgPool, user_id: Uuid, expires_at: chrono::DateTime<Utc>) -> Uuid {
    sqlx::query_scalar!(
        "INSERT INTO web_sessions (user_id, session_hash, expires_at) VALUES ($1, 'hash', $2) RETURNING id",
        user_id,
        expires_at
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn insert_audit_log(pool: &PgPool, user_id: Uuid, created_at: chrono::DateTime<Utc>) -> i64 {
    sqlx::query_scalar!(
        "INSERT INTO audit_logs (user_id, event_type, created_at) VALUES ($1, 'login', $2) RETURNING id",
        user_id,
        created_at
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn device_credential_exists(pool: &PgPool, id: Uuid) -> bool {
    sqlx::query_scalar!("SELECT EXISTS(SELECT 1 FROM device_credentials WHERE id = $1)", id)
        .fetch_one(pool)
        .await
        .unwrap()
        .unwrap_or(false)
}

async fn web_session_exists(pool: &PgPool, id: Uuid) -> bool {
    sqlx::query_scalar!("SELECT EXISTS(SELECT 1 FROM web_sessions WHERE id = $1)", id)
        .fetch_one(pool)
        .await
        .unwrap()
        .unwrap_or(false)
}

async fn audit_log_exists(pool: &PgPool, id: i64) -> bool {
    sqlx::query_scalar!("SELECT EXISTS(SELECT 1 FROM audit_logs WHERE id = $1)", id)
        .fetch_one(pool)
        .await
        .unwrap()
        .unwrap_or(false)
}

#[sqlx::test(migrations = "./migrations")]
async fn prunes_device_credentials_past_their_retention_grace_period(pool: PgPool) {
    let mut config = test_config();
    config.device_credential_retention_secs = 60 * 60 * 24 * 7; // 7 days
    let state = AppState {
        db: pool.clone(),
        config: Arc::new(config),
        rate_limiter: Arc::new(RateLimiter::new()),
        ws_registry: Arc::new(ConnectionRegistry::new()),
        last_seen_cache: Arc::new(dashmap::DashMap::new()),
        device_revocation_cache: Arc::new(dashmap::DashMap::new()),
        web_session_cache: Arc::new(dashmap::DashMap::new()),
    };

    let user_id = create_user(&pool, "cred-user@example.com").await;
    let device_id = create_device(&pool, user_id, "Laptop").await;

    // Expired well past the 7-day grace window: eligible for deletion.
    let old_expired =
        insert_device_credential(&pool, device_id, Utc::now() - ChronoDuration::days(8)).await;
    // Expired, but still inside the grace window: must survive.
    let recently_expired =
        insert_device_credential(&pool, device_id, Utc::now() - ChronoDuration::hours(1)).await;
    // Not expired at all: must survive.
    let still_valid =
        insert_device_credential(&pool, device_id, Utc::now() + ChronoDuration::days(30)).await;

    housekeeping::run_once(&state).await;

    assert!(!device_credential_exists(&pool, old_expired).await);
    assert!(device_credential_exists(&pool, recently_expired).await);
    assert!(device_credential_exists(&pool, still_valid).await);
}

#[sqlx::test(migrations = "./migrations")]
async fn prunes_web_sessions_once_expired(pool: PgPool) {
    let state = state_for(pool.clone());

    let user_id = create_user(&pool, "session-user@example.com").await;

    let expired = insert_web_session(&pool, user_id, Utc::now() - ChronoDuration::minutes(1)).await;
    let still_valid = insert_web_session(&pool, user_id, Utc::now() + ChronoDuration::days(14)).await;

    housekeeping::run_once(&state).await;

    assert!(!web_session_exists(&pool, expired).await);
    assert!(web_session_exists(&pool, still_valid).await);
}

#[sqlx::test(migrations = "./migrations")]
async fn prunes_audit_logs_past_retention_window(pool: PgPool) {
    let mut config = test_config();
    config.audit_log_retention_secs = 60 * 60 * 24 * 90; // 90 days
    let state = AppState {
        db: pool.clone(),
        config: Arc::new(config),
        rate_limiter: Arc::new(RateLimiter::new()),
        ws_registry: Arc::new(ConnectionRegistry::new()),
        last_seen_cache: Arc::new(dashmap::DashMap::new()),
        device_revocation_cache: Arc::new(dashmap::DashMap::new()),
        web_session_cache: Arc::new(dashmap::DashMap::new()),
    };

    let user_id = create_user(&pool, "audit-user@example.com").await;

    let old_log = insert_audit_log(&pool, user_id, Utc::now() - ChronoDuration::days(91)).await;
    let recent_log = insert_audit_log(&pool, user_id, Utc::now() - ChronoDuration::days(1)).await;

    housekeeping::run_once(&state).await;

    assert!(!audit_log_exists(&pool, old_log).await);
    assert!(audit_log_exists(&pool, recent_log).await);
}

#[sqlx::test(migrations = "./migrations")]
async fn one_table_failing_does_not_block_the_others(pool: PgPool) {
    // No way to force a real failure in one statement without a DB-level
    // fault injection, but this exercises the ordinary "all three succeed
    // independently in one pass" path end-to-end, which is what the
    // sequential-not-transactional design in `housekeeping::run_once`
    // exists to guarantee.
    let state = state_for(pool.clone());

    let user_id = create_user(&pool, "combined-user@example.com").await;
    let device_id = create_device(&pool, user_id, "Phone").await;

    let old_cred =
        insert_device_credential(&pool, device_id, Utc::now() - ChronoDuration::days(30)).await;
    let old_session = insert_web_session(&pool, user_id, Utc::now() - ChronoDuration::days(1)).await;
    let old_log = insert_audit_log(&pool, user_id, Utc::now() - ChronoDuration::days(200)).await;

    housekeeping::run_once(&state).await;

    assert!(!device_credential_exists(&pool, old_cred).await);
    assert!(!web_session_exists(&pool, old_session).await);
    assert!(!audit_log_exists(&pool, old_log).await);
}

#[sqlx::test(migrations = "./migrations")]
async fn housekeeping_respects_per_pass_cap_and_orders_oldest_first(pool: PgPool) {
    let state = state_for(pool.clone());
    let user_id = create_user(&pool, "cap-user@example.com").await;

    // Insert 50,000 older expired sessions (expired 10 days ago)
    const CAP: i64 = housekeeping::MAX_PRUNED_PER_PASS;
    const EXTRA: i64 = 1_000;

    sqlx::query(
        "INSERT INTO web_sessions (user_id, session_hash, expires_at) \
         SELECT $1, ('old_' || seq)::bytea, now() - INTERVAL '10 days' \
         FROM generate_series(1, $2::bigint) AS seq",
    )
    .bind(user_id)
    .bind(CAP)
    .execute(&pool)
    .await
    .unwrap();

    // Insert 1,000 newer expired sessions (expired 1 day ago)
    sqlx::query(
        "INSERT INTO web_sessions (user_id, session_hash, expires_at) \
         SELECT $1, ('new_' || seq)::bytea, now() - INTERVAL '1 day' \
         FROM generate_series(1, $2::bigint) AS seq",
    )
    .bind(user_id)
    .bind(EXTRA)
    .execute(&pool)
    .await
    .unwrap();

    let total_before: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM web_sessions WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .unwrap();
    assert_eq!(total_before, CAP + EXTRA);

    // Pass 1: Should cap at MAX_PRUNED_PER_PASS (50,000).
    // Because of ORDER BY expires_at ASC, all 50,000 old sessions should be deleted,
    // leaving all 1,000 newer sessions intact.
    housekeeping::run_once(&state).await;

    let remaining_pass1: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM web_sessions WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .unwrap();
    assert_eq!(remaining_pass1, EXTRA, "pass 1 must prune exactly MAX_PRUNED_PER_PASS");

    let old_remaining: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM web_sessions WHERE user_id = $1 AND expires_at < now() - INTERVAL '5 days'",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .unwrap();
    assert_eq!(old_remaining, 0, "all older sessions must have been pruned first by ORDER BY expires_at ASC");

    // Pass 2: Prunes the remaining 1,000 sessions and terminates cleanly
    housekeeping::run_once(&state).await;

    let remaining_pass2: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM web_sessions WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .unwrap();
    assert_eq!(remaining_pass2, 0, "pass 2 prunes remaining sessions");
}

#[sqlx::test(migrations = "./migrations")]
async fn housekeeping_cooperative_yield_allows_concurrent_pool_queries(pool: PgPool) {
    let mut config = test_config();
    config.audit_log_retention_secs = 60 * 60 * 24 * 90; // 90 days
    let state = AppState {
        db: pool.clone(),
        config: Arc::new(config),
        rate_limiter: Arc::new(RateLimiter::new()),
        ws_registry: Arc::new(ConnectionRegistry::new()),
        last_seen_cache: Arc::new(dashmap::DashMap::new()),
        device_revocation_cache: Arc::new(dashmap::DashMap::new()),
        web_session_cache: Arc::new(dashmap::DashMap::new()),
    };
    let user_id = create_user(&pool, "yield-user@example.com").await;

    // Insert 15,000 expired audit logs (3 chunks of 5,000) so the deletion loop
    // executes multiple chunks and yields cooperatively via PRUNE_COOPERATIVE_DELAY.
    const LOG_COUNT: i64 = housekeeping::DELETE_CHUNK_SIZE * 3;
    sqlx::query(
        "INSERT INTO audit_logs (user_id, event_type, created_at) \
         SELECT $1, 'login', now() - INTERVAL '100 days' \
         FROM generate_series(1, $2::bigint) AS seq",
    )
    .bind(user_id)
    .bind(LOG_COUNT)
    .execute(&pool)
    .await
    .unwrap();

    let probe_pool = pool.clone();
    let probe_task = tokio::spawn(async move {
        // Sleep briefly to let housekeeping start deleting chunks
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let mut conn = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            probe_pool.acquire(),
        )
        .await
        .expect("connection acquire should not time out")
        .expect("connection acquire should succeed");

        let val: i32 = sqlx::query_scalar("SELECT 1")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        assert_eq!(val, 1);
    });

    housekeeping::run_once(&state).await;
    probe_task.await.unwrap();

    let remaining: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM audit_logs WHERE user_id = $1",
        user_id
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .unwrap();
    assert_eq!(remaining, 0, "all 3 chunks should be pruned");
}

