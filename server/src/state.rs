use std::sync::Arc;

use dashmap::DashMap;
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::middleware::rate_limit::RateLimiter;
use crate::websocket::ConnectionRegistry;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub rate_limiter: Arc<RateLimiter>,
    pub ws_registry: Arc<ConnectionRegistry>,
    /// Per-device instant of the last time `devices::touch_last_seen` was
    /// triggered, used to skip spawning a background DB task (and the pool
    /// checkout that comes with it) when a device was already touched
    /// recently — see `devices::routes::touch_last_seen_background` for the
    /// full guard.
    ///
    /// Unlike `RateLimiter::windows` (swept on a timer via `spawn_sweeper`
    /// in `middleware::rate_limit`), entries here are never evicted. That's
    /// intentional: this map grows by at most one entry per distinct device
    /// that has ever synced since process start, and the number of distinct
    /// devices is bounded by the `devices` table (itself bounded by real
    /// users), not by request volume — unlike the rate limiter, which is
    /// keyed per (bucket, client IP/device id) and would otherwise grow
    /// without bound against unauthenticated traffic. A few thousand devices
    /// worth of `(Uuid, Instant)` entries is negligible, so a sweeper would
    /// add complexity without a real problem to solve.
    pub last_seen_cache: Arc<DashMap<Uuid, std::time::Instant>>,
    /// Per-device `(cached_at, is_active)` for the revocation check every
    /// device-authenticated request pays in
    /// `auth::extractors::AuthenticatedDevice::from_request_parts` — that
    /// check is a DB round trip (and pool checkout) on every single upload,
    /// download, snapshot, and stats call, which adds up under concurrent
    /// load against the pool's `max_connections`.
    ///
    /// Unlike `last_seen_cache`, entries here are read with a short TTL
    /// (`auth::extractors::DEVICE_REVOCATION_CACHE_TTL`) rather than treated
    /// as valid forever: a stale "active" entry has a real security
    /// consequence (a revoked device kept accepting requests), so the cache
    /// can only shave off the common-case round trip, not skip the freshness
    /// check entirely. `devices::routes::revoke_device` also writes `false`
    /// into this map directly on revocation, so the TTL window only matters
    /// for revocations that happen through some path other than that
    /// handler. Sized the same way as `last_seen_cache` — bounded by the
    /// number of distinct devices, not by request volume — so it needs no
    /// sweeper either.
    pub device_revocation_cache: Arc<DashMap<Uuid, (std::time::Instant, bool)>>,
}
