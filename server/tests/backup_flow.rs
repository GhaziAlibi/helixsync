// Backups: dump, restore, schedule and pruning, against a real database.
// Each test gets its own database (`sqlx::test`) and its own temp folder.
mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum_test::{TestServer, TestServerConfig, Transport};
use chrono::{DateTime, Duration, TimeZone, Utc};
use helixsync_server::backup::catalog;
use helixsync_server::backup::dump::{self, AlreadyRunning};
use helixsync_server::backup::files::{self, Kind};
use helixsync_server::backup::pipeline;
use helixsync_server::backup::restore;
use helixsync_server::backup::scheduler;
use helixsync_server::config::{BackupConfig, Config};
use helixsync_server::database;
use helixsync_server::middleware::rate_limit::RateLimiter;
use helixsync_server::state::AppState;
use helixsync_server::websocket::ConnectionRegistry;
use serde_json::json;
use sqlx::{Connection, PgConnection, PgPool};
use uuid::Uuid;

const KEY: &str = "k3Yb0ardCat-9fQ2xVzLmW7pRtN1uHsJ4aEoXyC6dGq8";

// --- helpers ---

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("helixsync-backup-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn backup_config(dir: &Path, keep_last: usize) -> BackupConfig {
    BackupConfig::new(true, Some(KEY.to_string()), "0 3 * * *", dir, keep_last)
}

/// A fixed point in time, `minutes` after 2026-11-13 00:00 UTC.
fn t(minutes: i64) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 13, 0, 0, 0).unwrap() + Duration::minutes(minutes)
}

fn full_config(backup: BackupConfig) -> Config {
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
        backup,
    }
}

fn state_for(pool: PgPool, backup: BackupConfig) -> AppState {
    AppState {
        db: pool,
        config: Arc::new(full_config(backup)),
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

/// A string full of what COPY text has to escape.
const AWKWARD: &str = "tab\there\nnewline \\ backslash \\N ünï \u{1F600} \"quote\" 'single' \r";

async fn insert_user(pool: &PgPool, email: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, kdf_salt, kdf_params, wrapped_account_key,
                            recovery_auth_hash, recovery_wrapped_account_key)
         VALUES ($1, 'hash', 'salt', '{\"m\":19456,\"t\":2,\"p\":1}'::jsonb, $2, 'rh', 'rw')
         RETURNING id",
    )
    .bind(email)
    .bind(AWKWARD)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn insert_device(pool: &PgPool, user_id: Uuid, name: &str) -> Uuid {
    sqlx::query_scalar("INSERT INTO devices (user_id, name) VALUES ($1, $2) RETURNING id")
        .bind(user_id)
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Rows in several tables, two sequences, awkward text, JSON and bytes.
async fn seed(pool: &PgPool, users: usize) {
    for i in 0..users {
        let user = insert_user(pool, &format!("user{i}@example.com")).await;
        let device = insert_device(pool, user, &format!("Laptop {i} {AWKWARD}")).await;
        for j in 0..5i64 {
            sqlx::query(
                "INSERT INTO sync_operations
                   (operation_id, user_id, device_id, device_sequence, lamport_timestamp,
                    server_cursor, object_type, object_id, operation_type, payload, payload_bytes)
                 VALUES ($1, $2, $3, $4, $4, $4, 'bookmark', $5, 'create', $6, 10)",
            )
            .bind(Uuid::now_v7())
            .bind(user)
            .bind(device)
            .bind(j + 1)
            .bind(Uuid::now_v7())
            .bind(json!({ "title": AWKWARD, "n": j, "nested": { "a": [1, 2, 3] } }))
            .execute(pool)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO audit_logs (user_id, device_id, event_type) VALUES ($1, $2, 'login')",
        )
        .bind(user)
        .bind(device)
        .execute(pool)
        .await
        .unwrap();
        let bytes: Vec<u8> = (0..=255u8).chain([0, b'\n', b'\\', b'\t']).collect();
        sqlx::query(
            "INSERT INTO bookmark_restore_points
               (id, user_id, kind, bookmark_count, encryption_version, envelope, size_bytes)
             VALUES ($1, $2, 'manual', 1, 0, $3, $4)",
        )
        .bind(Uuid::now_v7())
        .bind(user)
        .bind(&bytes)
        .bind(bytes.len() as i32)
        .execute(pool)
        .await
        .unwrap();
    }
}

/// Every table's rows (as JSON text) and every sequence's position. Audit
/// rows about backups are left out: taking and restoring backups writes them.
async fn fingerprint(pool: &PgPool) -> BTreeMap<String, Vec<String>> {
    let mut conn = pool.acquire().await.unwrap();
    let catalog = catalog::discover(&mut conn).await.unwrap();
    let mut out = BTreeMap::new();
    for table in &catalog.tables {
        let filter = if table.name == "audit_logs" {
            " WHERE t.event_type NOT LIKE 'backup\\_%'"
        } else {
            ""
        };
        let rows: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT row_to_json(t)::text FROM public.\"{}\" t{filter} ORDER BY 1",
            table.name
        ))
        .fetch_all(&mut *conn)
        .await
        .unwrap();
        out.insert(table.name.clone(), rows);
    }
    for sequence in &catalog.sequences {
        // Backup events are audit rows too, so this one moves with them.
        if sequence == "audit_logs_id_seq" {
            continue;
        }
        let value: Option<i64> = sqlx::query_scalar(
            "SELECT last_value FROM pg_sequences WHERE schemaname = 'public' AND sequencename = $1",
        )
        .bind(sequence)
        .fetch_one(&mut *conn)
        .await
        .unwrap();
        out.insert(format!("sequence {sequence}"), vec![format!("{value:?}")]);
    }
    out
}

async fn empty_all_tables(pool: &PgPool) {
    let mut conn = pool.acquire().await.unwrap();
    let catalog = catalog::discover(&mut conn).await.unwrap();
    let names: Vec<String> = catalog
        .tables
        .iter()
        .map(|t| format!("public.\"{}\"", t.name))
        .collect();
    sqlx::query(&format!("TRUNCATE TABLE {}", names.join(", ")))
        .execute(&mut *conn)
        .await
        .unwrap();
}

async fn manual_backup(pool: &PgPool, dir: &Path, now: DateTime<Utc>) -> PathBuf {
    dump::run(pool, &backup_config(dir, 7), Kind::Manual, now)
        .await
        .unwrap()
        .path
}

fn never_asked(_: &restore::Preview) -> anyhow::Result<bool> {
    panic!("the operator must not be asked: the file is refused first");
}

fn file_count(dir: &Path, kind: Kind) -> usize {
    files::list(dir)
        .unwrap()
        .iter()
        .filter(|f| f.kind == kind)
        .count()
}

fn read_script(path: &Path) -> String {
    let mut text = String::new();
    std::io::Read::read_to_string(&mut pipeline::open_file(path, KEY).unwrap(), &mut text).unwrap();
    text
}

/// Writes `script` as a backup file named for `now` and returns its name.
fn write_script(dir: &Path, script: &str, now: DateTime<Utc>) -> String {
    let name = files::file_name(now, Kind::Manual);
    std::fs::write(
        dir.join(&name),
        pipeline::seal_bytes(script.as_bytes(), KEY).unwrap(),
    )
    .unwrap();
    name
}

// --- dump ---

#[sqlx::test(migrations = "./migrations")]
async fn dump_writes_an_encrypted_file_that_reads_back_as_a_script(pool: PgPool) {
    seed(&pool, 3).await;
    let dir = TempDir::new();
    let path = manual_backup(&pool, dir.path(), t(30)).await;

    assert_eq!(
        path.file_name().unwrap().to_str().unwrap(),
        "helixsync-backup-20261113T003000Z-manual.sql.zst.age"
    );
    let raw = std::fs::read(&path).unwrap();
    assert!(raw.starts_with(b"age-encryption.org/v1"));
    assert!(
        !raw.windows(7).any(|w| w == b"example"),
        "the file must be encrypted"
    );

    let script = read_script(&path);
    assert!(script.starts_with("-- HelixSync backup\n-- format: 1\n"));
    assert!(script.contains("-- migration_version: 3\n"));
    assert!(script.contains("COPY public.\"users\" ("));
    assert!(script.contains("FROM stdin;\n"));
    assert!(script.contains("SELECT pg_catalog.setval('public.\"sync_operations_id_seq\"'"));
    assert!(script.contains("-- rows \"users\" 3\n"));
    assert!(script.ends_with("-- end\n"));
    // Never the migration bookkeeping.
    assert!(!script.contains("_sqlx_migrations"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    // Nothing else is left behind.
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn two_backups_at_once_are_refused(pool: PgPool) {
    let dir = TempDir::new();
    // Another session holds the backup lock, as a running backup would.
    let mut other = PgConnection::connect_with(&pool.connect_options())
        .await
        .unwrap();
    let key: i64 = dump::BACKUP_LOCK_KEY;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(key)
        .execute(&mut other)
        .await
        .unwrap();

    let err = dump::run(&pool, &backup_config(dir.path(), 7), Kind::Manual, t(0))
        .await
        .unwrap_err();
    assert!(err.downcast_ref::<AlreadyRunning>().is_some(), "{err:#}");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(key)
        .execute(&mut other)
        .await
        .unwrap();
    dump::run(&pool, &backup_config(dir.path(), 7), Kind::Manual, t(1))
        .await
        .unwrap();
}

#[sqlx::test(migrations = "./migrations")]
async fn leftover_partial_files_are_removed_at_the_next_run(pool: PgPool) {
    let dir = TempDir::new();
    let stale = dir
        .path()
        .join("helixsync-backup-20261112T030000Z.sql.zst.age.partial");
    let foreign = dir.path().join("notes.partial");
    std::fs::write(&stale, b"half").unwrap();
    std::fs::write(&foreign, b"mine").unwrap();

    manual_backup(&pool, dir.path(), t(0)).await;
    assert!(!stale.exists());
    assert!(
        foreign.exists(),
        "only helixsync-backup-* files are touched"
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn a_backup_taken_while_writes_continue_is_consistent(pool: PgPool) {
    seed(&pool, 2).await;
    let dir = TempDir::new();

    // Each transaction adds a user and a device together.
    let writer = tokio::spawn({
        let pool = pool.clone();
        async move {
            for i in 0..120 {
                let mut tx = pool.begin().await.unwrap();
                let user: Uuid = sqlx::query_scalar(
                    "INSERT INTO users (email, password_hash, kdf_salt, kdf_params, wrapped_account_key,
                                        recovery_auth_hash, recovery_wrapped_account_key)
                     VALUES ($1, 'h', 's', '{}'::jsonb, 'w', 'r', 'rw') RETURNING id",
                )
                .bind(format!("live{i}@example.com"))
                .fetch_one(&mut *tx)
                .await
                .unwrap();
                sqlx::query("INSERT INTO devices (user_id, name) VALUES ($1, 'd')")
                    .bind(user)
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                tx.commit().await.unwrap();
            }
        }
    });
    tokio::task::yield_now().await;
    let path = manual_backup(&pool, dir.path(), t(0)).await;
    writer.await.unwrap();

    // Load it over the (now larger) database: it passes the loader's own row
    // count checks, and every user has exactly one device in the snapshot.
    let config = backup_config(dir.path(), 7);
    restore::run(&pool, &config, path.to_str(), t(5), |_| Ok(true))
        .await
        .unwrap();
    let (users, devices): (i64, i64) =
        sqlx::query_as("SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM devices)")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(users, devices);
    assert!(users >= 2);
}

// --- restore ---

#[sqlx::test(migrations = "./migrations")]
async fn round_trip_into_an_empty_database_and_sequences_continue(pool: PgPool) {
    seed(&pool, 4).await;
    let dir = TempDir::new();
    let before = fingerprint(&pool).await;
    let max_audit_id: i64 = sqlx::query_scalar("SELECT max(id) FROM audit_logs")
        .fetch_one(&pool)
        .await
        .unwrap();
    manual_backup(&pool, dir.path(), t(0)).await;

    empty_all_tables(&pool).await;
    assert_ne!(fingerprint(&pool).await, before);

    let report = restore::run(
        &pool,
        &backup_config(dir.path(), 7),
        None,
        t(10),
        never_asked,
    )
    .await
    .unwrap();
    assert_eq!(fingerprint(&pool).await, before);
    assert!(
        report.safety_backup.is_none(),
        "an empty database has nothing to save"
    );
    assert!(!report.rebuilt_schema);
    assert_eq!(file_count(dir.path(), Kind::PreRestore), 0);

    // The next id continues after the restored ones.
    let next: i64 =
        sqlx::query_scalar("INSERT INTO audit_logs (event_type) VALUES ('after') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(next > max_audit_id, "{next} <= {max_audit_id}");

    let restored: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_logs WHERE event_type = 'backup_restored'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(restored, 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn round_trip_into_a_database_without_a_schema(pool: PgPool) {
    seed(&pool, 3).await;
    let dir = TempDir::new();
    let before = fingerprint(&pool).await;
    manual_backup(&pool, dir.path(), t(0)).await;

    // A brand new server: no tables and no migration history.
    let mut conn = pool.acquire().await.unwrap();
    let catalog = catalog::discover(&mut conn).await.unwrap();
    let names: Vec<String> = catalog
        .tables
        .iter()
        .map(|t| format!("public.\"{}\"", t.name))
        .chain(["public.\"_sqlx_migrations\"".to_string()])
        .collect();
    sqlx::query(&format!("DROP TABLE {} CASCADE", names.join(", ")))
        .execute(&mut *conn)
        .await
        .unwrap();
    drop(conn);

    let report = restore::run(
        &pool,
        &backup_config(dir.path(), 7),
        None,
        t(10),
        never_asked,
    )
    .await
    .unwrap();
    assert!(report.rebuilt_schema);
    assert_eq!(fingerprint(&pool).await, before);
    // The migrations are recorded again.
    let mut conn = pool.acquire().await.unwrap();
    assert_eq!(
        catalog::migration_version(&mut conn).await.unwrap(),
        Some(3)
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn restore_over_existing_data_replaces_it_and_saves_a_safety_backup(pool: PgPool) {
    seed(&pool, 3).await;
    let dir = TempDir::new();
    let config = backup_config(dir.path(), 7);
    let original = fingerprint(&pool).await;
    manual_backup(&pool, dir.path(), t(0)).await;

    // Change the data after the backup.
    sqlx::query("DELETE FROM users WHERE email = 'user0@example.com'")
        .execute(&pool)
        .await
        .unwrap();
    insert_user(&pool, "newcomer@example.com").await;
    let changed = fingerprint(&pool).await;
    assert_ne!(changed, original);

    let mut asked = 0;
    let report = restore::run(&pool, &config, None, t(60), |preview| {
        asked += 1;
        assert!(preview
            .current
            .iter()
            .any(|(table, rows)| table == "users" && *rows == 3));
        assert_eq!(preview.summary.header.migration_version, 3);
        Ok(true)
    })
    .await
    .unwrap();
    assert_eq!(asked, 1);
    assert_eq!(
        fingerprint(&pool).await,
        original,
        "the backup replaced the data"
    );

    let safety = report
        .safety_backup
        .expect("the data it replaced was saved");
    assert!(safety
        .to_str()
        .unwrap()
        .ends_with("-prerestore.sql.zst.age"));
    assert_eq!(file_count(dir.path(), Kind::PreRestore), 1);

    // Restoring that safety backup brings the previous state back. It is
    // never picked by default, only when named.
    restore::run(
        &pool,
        &config,
        safety.file_name().unwrap().to_str(),
        t(120),
        |_| Ok(true),
    )
    .await
    .unwrap();
    assert_eq!(fingerprint(&pool).await, changed);
}

#[sqlx::test(migrations = "./migrations")]
async fn declining_the_confirmation_changes_nothing(pool: PgPool) {
    seed(&pool, 2).await;
    let dir = TempDir::new();
    manual_backup(&pool, dir.path(), t(0)).await;
    insert_user(&pool, "extra@example.com").await;
    let before = fingerprint(&pool).await;

    let err = restore::run(&pool, &backup_config(dir.path(), 7), None, t(5), |_| {
        Ok(false)
    })
    .await
    .unwrap_err();
    assert!(err.to_string().contains("not confirmed"), "{err:#}");
    assert_eq!(fingerprint(&pool).await, before);
    assert_eq!(file_count(dir.path(), Kind::PreRestore), 0);
}

#[sqlx::test(migrations = "./migrations")]
async fn when_the_safety_backup_cannot_be_written_nothing_is_changed(pool: PgPool) {
    seed(&pool, 2).await;
    let dir = TempDir::new();
    manual_backup(&pool, dir.path(), t(0)).await;
    insert_user(&pool, "extra@example.com").await;
    let before = fingerprint(&pool).await;

    // The safety backup's name is already taken.
    std::fs::write(
        dir.path().join(files::file_name(t(5), Kind::PreRestore)),
        b"in the way",
    )
    .unwrap();
    let err = restore::run(&pool, &backup_config(dir.path(), 7), None, t(5), |_| {
        Ok(true)
    })
    .await
    .unwrap_err();
    assert!(err.to_string().contains("safety backup"), "{err:#}");
    assert_eq!(fingerprint(&pool).await, before);
}

#[sqlx::test(migrations = "./migrations")]
async fn a_load_that_fails_midway_leaves_the_data_untouched(pool: PgPool) {
    seed(&pool, 2).await;
    let dir = TempDir::new();
    let config = backup_config(dir.path(), 7);
    let before = fingerprint(&pool).await;

    // Well-formed as a file, but the row is not a valid UUID, so Postgres
    // rejects it after the tables were emptied inside the transaction.
    let script = "-- HelixSync backup\n-- format: 1\n-- server_version: 1.0.0\n-- migration_version: 3\n-- created_at: 2026-11-13T00:00:00Z\n\nCOPY public.\"users\" (\"id\", \"email\") FROM stdin;\nnot-a-uuid\tx@example.com\n\\.\n\n-- rows \"users\" 1\n-- end\n";
    let name = write_script(dir.path(), script, t(0));

    let err = restore::run(&pool, &config, Some(&name), t(5), |_| Ok(true))
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("users"), "{err:#}");
    assert_eq!(fingerprint(&pool).await, before);
    // The safety backup was written before the attempt, and works.
    assert_eq!(file_count(dir.path(), Kind::PreRestore), 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn files_that_cannot_be_trusted_are_refused_before_any_change(pool: PgPool) {
    seed(&pool, 2).await;
    let dir = TempDir::new();
    let config = backup_config(dir.path(), 7);
    let good = manual_backup(&pool, dir.path(), t(0)).await;
    insert_user(&pool, "extra@example.com").await;
    let before = fingerprint(&pool).await;
    let script = read_script(&good);

    let mut refused: Vec<(&str, String)> = Vec::new();

    // Tampered: an extra statement, sealed with the right key.
    let evil = script.replacen(
        "\n-- rows ",
        "\nDROP TABLE public.users CASCADE;\n-- rows ",
        1,
    );
    refused.push(("tampered statement", write_script(dir.path(), &evil, t(1))));

    // Truncated: the end of the encrypted file is gone.
    let raw = std::fs::read(&good).unwrap();
    let truncated = files::file_name(t(2), Kind::Manual);
    std::fs::write(dir.path().join(&truncated), &raw[..raw.len() - 60]).unwrap();
    refused.push(("truncated", truncated));

    // Not an age file at all.
    let junk = files::file_name(t(3), Kind::Manual);
    std::fs::write(dir.path().join(&junk), b"this is not a backup").unwrap();
    refused.push(("not a backup", junk));

    // Taken by a newer server.
    let newer = script.replace("-- migration_version: 3", "-- migration_version: 999");
    refused.push((
        "newer than the binary",
        write_script(dir.path(), &newer, t(4)),
    ));

    // Not a schema version this server ever had.
    let unknown = script.replace("-- migration_version: 3", "-- migration_version: 0");
    refused.push(("unknown version", write_script(dir.path(), &unknown, t(5))));

    // Row counts that disagree with the data.
    let miscounted = script.replace("-- rows \"users\" 2", "-- rows \"users\" 3");
    refused.push(("row counts", write_script(dir.path(), &miscounted, t(6))));

    for (what, name) in &refused {
        let result = restore::run(&pool, &config, Some(name), t(10), never_asked).await;
        assert!(result.is_err(), "{what} should be refused");
        assert_eq!(fingerprint(&pool).await, before, "{what} changed data");
    }
    assert_eq!(file_count(dir.path(), Kind::PreRestore), 0);

    // A wrong key is refused the same way.
    let wrong = BackupConfig::new(
        true,
        Some("another-key-another-key-another-key-xx".into()),
        "0 3 * * *",
        dir.path(),
        7,
    );
    let err = restore::run(
        &pool,
        &wrong,
        Some(good.to_str().unwrap()),
        t(10),
        never_asked,
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("BACKUP_ENCRYPTION_KEY"), "{err:#}");
    assert_eq!(fingerprint(&pool).await, before);
}

#[sqlx::test(migrations = "./migrations")]
async fn a_backup_of_an_older_schema_is_restored_by_a_newer_server(pool: PgPool) {
    seed(&pool, 3).await;
    let dir = TempDir::new();
    let config = backup_config(dir.path(), 7);

    // Take the database back to schema version 2 (before the recovery
    // safeguards), as a server that old would have it.
    for statement in [
        "DROP TABLE auth_request_approvals",
        "ALTER TABLE users DROP COLUMN recovery_code_confirmed_at",
        "ALTER TABLE auth_requests DROP CONSTRAINT auth_requests_kind_check",
        "ALTER TABLE auth_requests ADD CONSTRAINT auth_requests_kind_check CHECK (kind IN ('web', 'device'))",
        "DELETE FROM _sqlx_migrations WHERE version = 3",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    let version_two = fingerprint(&pool).await;
    let path = manual_backup(&pool, dir.path(), t(0)).await;
    assert!(read_script(&path).contains("-- migration_version: 2\n"));

    // The newer server upgrades the database, and the data moves on.
    database::run_migrations(&pool).await.unwrap();
    insert_user(&pool, "later@example.com").await;

    let report = restore::run(&pool, &config, None, t(60), |_| Ok(true))
        .await
        .unwrap();
    assert!(report.rebuilt_schema);
    assert!(report.safety_backup.is_some());

    // The schema is the current one again, holding the old data.
    let mut conn = pool.acquire().await.unwrap();
    assert_eq!(
        catalog::migration_version(&mut conn).await.unwrap(),
        Some(3)
    );
    drop(conn);
    let after = fingerprint(&pool).await;
    for (table, rows) in &version_two {
        if table == "users" {
            // The version 3 column exists again, empty.
            assert_eq!(rows.len(), after[table].len());
            assert!(after[table]
                .iter()
                .all(|r| r.contains("\"recovery_code_confirmed_at\":null")));
            continue;
        }
        assert_eq!(&after[table], rows, "{table}");
    }
    assert!(after.contains_key("auth_request_approvals"));
}

#[sqlx::test(migrations = "./migrations")]
async fn restore_is_refused_while_another_session_is_connected(pool: PgPool) {
    let options = (*pool.connect_options()).clone();
    pool.close().await;

    // Nobody else is connected: allowed.
    restore::ensure_no_other_sessions(&options).await.unwrap();

    // The server (or anything else) is connected: refused.
    let other = PgConnection::connect_with(&options).await.unwrap();
    let err = restore::ensure_no_other_sessions(&options)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("stop the HelixSync server"),
        "{err:#}"
    );
    drop(other);
}

#[sqlx::test(migrations = "./migrations")]
async fn a_device_ahead_of_the_restored_data_is_sent_to_a_snapshot(pool: PgPool) {
    let dir = TempDir::new();
    let config = backup_config(dir.path(), 7);
    let state = state_for(pool.clone(), config.clone());
    let server = TestServer::new_with_config(
        helixsync_server::app(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
        TestServerConfig {
            transport: Some(Transport::HttpRandomPort),
            ..Default::default()
        },
    );

    let email = "cursor@example.com";
    server
        .post("/api/v1/auth/register")
        .json(&json!({
            "email": email,
            "authKey": common::test_auth_key("pw"),
            "kdfSalt": common::test_kdf_salt(),
            "kdfParams": common::test_kdf_params(),
            "wrappedAk": common::test_wrapped_ak(),
            "recoveryAuthKey": common::test_recovery_auth_key(),
            "recoveryWrappedAk": common::test_recovery_wrapped_ak(),
        }))
        .await
        .assert_status_ok();
    let registered: serde_json::Value = server
        .post("/api/v1/devices/register")
        .json(&json!({ "email": email, "authKey": common::test_auth_key("pw"), "name": "Laptop" }))
        .await
        .json();
    let token = registered["accessToken"].as_str().unwrap().to_string();

    let upload = |seq: i64| {
        let server = &server;
        let token = token.clone();
        async move {
            server
                .post("/api/v1/sync/operations")
                .add_header("x-protocol-version", "1")
                .authorization_bearer(&token)
                .json(&json!({ "operations": [{
                    "operationId": Uuid::now_v7(),
                    "deviceSequence": seq,
                    "lamportTimestamp": seq,
                    "objectType": "bookmark",
                    "objectId": Uuid::now_v7(),
                    "operationType": "create",
                    "encryptionVersion": 0,
                    "payload": { "title": "x", "url": "https://example.com", "parent": null, "position": "a0" }
                }] }))
                .await
                .assert_status_ok();
        }
    };

    upload(1).await;
    manual_backup(&pool, dir.path(), t(0)).await;
    upload(2).await;
    upload(3).await;

    // The device is at cursor 3 and saw all of it.
    server
        .get("/api/v1/sync/changes?cursor=3")
        .authorization_bearer(&token)
        .await
        .assert_status_ok();

    restore::run(&pool, &config, None, t(30), |_| Ok(true))
        .await
        .unwrap();

    // The restored data only reaches cursor 1, so cursor 3 can't be real.
    let res = server
        .get("/api/v1/sync/changes?cursor=3")
        .authorization_bearer(&token)
        .await;
    res.assert_status(axum::http::StatusCode::CONFLICT);
    let body: serde_json::Value = res.json();
    assert_eq!(body["error"], json!("cursor_invalid"));
    assert_eq!(body["snapshotUrl"], json!("/api/v1/sync/snapshot"));
}

// --- scheduler ---

#[sqlx::test(migrations = "./migrations")]
async fn a_scheduled_run_that_is_not_due_writes_nothing(pool: PgPool) {
    let dir = TempDir::new();
    let state = state_for(pool.clone(), backup_config(dir.path(), 7));
    let cron = scheduler::parse_cron("0 3 * * *").unwrap();

    // Today's 03:00 run happened.
    dump::run(&pool, &state.config.backup, Kind::Scheduled, t(3 * 60 + 1))
        .await
        .unwrap();
    assert!(scheduler::catch_up(&state, &cron, t(10 * 60)).await);
    assert_eq!(file_count(dir.path(), Kind::Scheduled), 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn a_missed_run_is_caught_up_once(pool: PgPool) {
    let dir = TempDir::new();
    let state = state_for(pool.clone(), backup_config(dir.path(), 7));
    let cron = scheduler::parse_cron("0 3 * * *").unwrap();

    // The server was down at today's 03:00; the last run was yesterday's.
    let yesterday = t(3 * 60 + 1) - Duration::days(1);
    dump::run(&pool, &state.config.backup, Kind::Scheduled, yesterday)
        .await
        .unwrap();

    let now = t(10 * 60);
    assert!(scheduler::catch_up(&state, &cron, now).await);
    assert_eq!(file_count(dir.path(), Kind::Scheduled), 2);
    // A second start the same day finds nothing missed.
    assert!(scheduler::catch_up(&state, &cron, now + Duration::minutes(5)).await);
    assert_eq!(file_count(dir.path(), Kind::Scheduled), 2);

    // The outcome is recorded in the audit log.
    let completed: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_logs WHERE event_type = 'backup_completed'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(completed, 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn the_first_start_takes_a_first_backup(pool: PgPool) {
    let dir = TempDir::new();
    let state = state_for(pool.clone(), backup_config(dir.path(), 7));
    let cron = scheduler::parse_cron("0 3 * * *").unwrap();
    assert!(scheduler::catch_up(&state, &cron, t(10 * 60)).await);
    assert_eq!(file_count(dir.path(), Kind::Scheduled), 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn a_failed_run_leaves_no_file_and_is_audited(pool: PgPool) {
    let dir = TempDir::new();
    let state = state_for(pool.clone(), backup_config(dir.path(), 7));
    let cron = scheduler::parse_cron("0 3 * * *").unwrap();

    // The run's file name is taken by a folder, so it cannot be written.
    std::fs::create_dir(
        dir.path()
            .join(files::file_name(t(10 * 60), Kind::Scheduled)),
    )
    .unwrap();

    assert!(!scheduler::catch_up(&state, &cron, t(10 * 60)).await);
    assert!(files::list(dir.path()).unwrap().is_empty());
    assert_eq!(
        std::fs::read_dir(dir.path()).unwrap().count(),
        1,
        "no .partial left behind"
    );
    let failed: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_logs WHERE event_type = 'backup_failed'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(failed, 1);
}

// --- pruning ---

#[sqlx::test(migrations = "./migrations")]
async fn pruning_keeps_exactly_the_configured_number_and_leaves_foreign_files(pool: PgPool) {
    let dir = TempDir::new();
    let config = backup_config(dir.path(), 3);
    let foreign = [
        "notes.txt",
        "helixsync-backup-notes.txt",
        "helixsync-backup-20200101T000000Z.sql",
    ];
    for name in foreign {
        std::fs::write(dir.path().join(name), b"mine").unwrap();
    }

    for i in 0..6 {
        helixsync_server::backup::run_audited(&pool, &config, Kind::Scheduled, t(i * 10))
            .await
            .unwrap();
    }
    let kept: Vec<_> = files::list(dir.path())
        .unwrap()
        .into_iter()
        .map(|f| f.created_at)
        .collect();
    assert_eq!(kept, vec![t(30), t(40), t(50)]);
    for name in foreign {
        assert!(dir.path().join(name).exists(), "{name}");
    }
}

#[sqlx::test(migrations = "./migrations")]
async fn the_newest_safety_backup_survives_pruning(pool: PgPool) {
    seed(&pool, 1).await;
    let dir = TempDir::new();
    let config = backup_config(dir.path(), 2);
    manual_backup(&pool, dir.path(), t(0)).await;
    restore::run(&pool, &config, None, t(10), |_| Ok(true))
        .await
        .unwrap();
    assert_eq!(file_count(dir.path(), Kind::PreRestore), 1);

    for i in 2..6 {
        helixsync_server::backup::run_audited(&pool, &config, Kind::Scheduled, t(i * 10))
            .await
            .unwrap();
    }
    assert_eq!(file_count(dir.path(), Kind::PreRestore), 1, "never pruned");
    assert_eq!(file_count(dir.path(), Kind::Scheduled), 2);
}
