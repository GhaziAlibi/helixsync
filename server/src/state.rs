use std::sync::Arc;
use std::time::Instant;

use dashmap::DashMap;
use sqlx::PgPool;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::config::Config;
use crate::middleware::rate_limit::RateLimiter;
use crate::websocket::ConnectionRegistry;

/// `(as_of, is_active)` per device id. See `AppState::device_revocation_cache`.
pub type DeviceRevocationCache = DashMap<Uuid, (Instant, bool)>;

/// `(as_of, Some((user_id, email)) | None)` per session hash. See
/// `AppState::web_session_cache`.
pub type WebSessionCache = DashMap<String, (Instant, Option<(Uuid, String)>)>;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub rate_limiter: Arc<RateLimiter>,
    pub ws_registry: Arc<ConnectionRegistry>,
    /// Last time each device's `last_seen_at` was touched, to skip redundant
    /// DB writes (see `devices::routes::touch_last_seen_background`).
    /// Never swept: its size is bounded by the number of devices.
    pub last_seen_cache: Arc<DashMap<Uuid, Instant>>,
    /// Cached `(as_of, is_active)` per device, so device auth doesn't hit the
    /// DB on every request. Read with a short TTL (`DEVICE_REVOCATION_CACHE_TTL`).
    ///
    /// Writers keep whichever value has the later `as_of`. Readers use the time
    /// just before their DB query, so a stale read can never overwrite a
    /// newer revocation. Bounded by device count, so never swept.
    pub device_revocation_cache: Arc<DeviceRevocationCache>,
    /// Cached `(as_of, cached)` per session hash, so web auth doesn't hit the
    /// DB on every request. `Some((user_id, email))` means valid; `None` is a
    /// tombstone for a revoked or logged-out session.
    ///
    /// Uses the same TTL and `as_of` rules as `device_revocation_cache`.
    /// Grows by one entry per login, so a background task sweeps it
    /// (`spawn_web_session_cache_sweeper`).
    pub web_session_cache: Arc<WebSessionCache>,
    /// One upload permit per device. `process_batch` takes it before opening
    /// a DB transaction, so concurrent uploads from one device wait here
    /// instead of each holding a pool connection. Bounded by device count.
    pub upload_locks: Arc<DashMap<Uuid, Arc<Semaphore>>>,
    /// Limits concurrent `/snapshot` builds across the process to cap memory
    /// (see `sync::routes::SNAPSHOT_CONCURRENCY_LIMIT`).
    pub snapshot_semaphore: Arc<Semaphore>,
    /// Limits concurrent Argon2 jobs across the process
    /// (see `crypto::ARGON2_CONCURRENCY_LIMIT`).
    pub argon2_semaphore: Arc<Semaphore>,
}
