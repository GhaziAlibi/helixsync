use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;

use crate::error::AppError;

/// A simple fixed-window rate limiter keyed by an arbitrary string (IP,
/// device id, etc). Configurable per bucket. This is intentionally simple
/// (no external service dependency) since HelixSync is meant to run
/// self-hosted with a single server process.
pub struct RateLimiter {
    windows: DashMap<(&'static str, String), (Instant, u32, Duration)>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            windows: DashMap::new(),
        }
    }

    /// Returns true if the request is allowed under `limit` requests per
    /// `window` for the given bucket+key.
    pub fn check(&self, bucket: &'static str, key: &str, limit: u32, window: Duration) -> bool {
        let now = Instant::now();
        let mut entry = self
            .windows
            .entry((bucket, key.to_string()))
            .or_insert((now, 0, window));

        if now.duration_since(entry.0) > entry.2 {
            entry.0 = now;
            entry.1 = 0;
            entry.2 = window;
        }

        if entry.1 >= limit {
            false
        } else {
            entry.1 += 1;
            true
        }
    }

    /// Drops entries whose window has already elapsed — i.e. ones that
    /// would reset on their next `check()` anyway, so they carry no
    /// remaining rate-limiting effect and are pure dead weight. Without
    /// this the map grows by one entry per distinct (bucket, key) —
    /// notably every client IP that has ever hit an unauthenticated
    /// endpoint (login, register, device register, token refresh) — for
    /// as long as the process runs, since nothing else ever removes an
    /// entry.
    fn sweep(&self) {
        let now = Instant::now();
        self.windows
            .retain(|_, (window_start, _, window)| now.duration_since(*window_start) <= *window);
    }
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

const SWEEP_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Spawns a periodic sweep of `limiter` for the lifetime of the process.
/// Call once from `main.rs` after `AppState` is constructed, mirroring
/// `sync::compaction::spawn`.
pub fn spawn_sweeper(limiter: Arc<RateLimiter>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            limiter.sweep();
        }
    });
}

/// Configuration for a rate-limited route bucket.
#[derive(Clone, Copy)]
pub struct RateLimitConfig {
    pub bucket: &'static str,
    pub limit: u32,
    pub window: Duration,
}

pub const LOGIN_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "login",
    limit: 10,
    window: Duration::from_secs(60),
};
pub const REGISTER_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "register",
    limit: 5,
    window: Duration::from_secs(60),
};
pub const TOKEN_REFRESH_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "token_refresh",
    limit: 30,
    window: Duration::from_secs(60),
};
pub const DEVICE_REGISTER_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "device_register",
    limit: 10,
    window: Duration::from_secs(60),
};
pub const SYNC_UPLOAD_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "sync_upload",
    limit: 600,
    window: Duration::from_secs(60),
};
pub const SYNC_DOWNLOAD_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "sync_download",
    limit: 600,
    window: Duration::from_secs(60),
};
// Lower than the incremental-download limit above: unlike `/changes`, both
// of these recompute an object's full merged state via `compute_objects`
// (a full history reduction when no snapshot row covers it yet), so each
// request is far more expensive than one incremental page.
pub const SYNC_SNAPSHOT_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "sync_snapshot",
    limit: 20,
    window: Duration::from_secs(60),
};
pub const SYNC_STATS_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "sync_stats",
    limit: 30,
    window: Duration::from_secs(60),
};
pub const WEBSOCKET_CONNECT_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "websocket_connect",
    limit: 30,
    window: Duration::from_secs(60),
};
// Previously the only sync route with no limit at all — cheap per request
// (a single primary-key lookup), but the extension used to call it once
// per applied remote tab/window/group operation with no client-side cache,
// so an unbounded client bug here had no backstop. The extension now caches
// this for 60s (extension/src/api/client.ts), so this exists purely as
// defense in depth against a future regression of that cache, not as the
// primary mitigation.
pub const SYNC_SETTINGS_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "sync_settings",
    limit: 60,
    window: Duration::from_secs(60),
};

/// Enforce a rate limit bucket for `key`, returning `AppError::RateLimited`
/// if exceeded. Called directly from handlers (keyed by client IP for
/// unauthenticated endpoints, or by user/device id for authenticated ones)
/// rather than as generic tower middleware, since limits vary per-route.
pub fn enforce(limiter: &RateLimiter, config: RateLimitConfig, key: &str) -> Result<(), AppError> {
    if limiter.check(config.bucket, key, config.limit, config.window) {
        Ok(())
    } else {
        Err(AppError::RateLimited)
    }
}
