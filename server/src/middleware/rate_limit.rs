use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;

use crate::error::AppError;

/// Per (bucket, key) token-bucket state. `tokens` is a fractional count so
/// refill can happen continuously (see `check_with_retry_after`) rather than
/// in discrete per-window jumps; `window` is kept per-entry (not just read
/// from the caller's `RateLimitConfig`) since `sweep` needs it and entries
/// are looked up without a config in hand.
struct TokenBucket {
    last_refill: Instant,
    tokens: f64,
    window: Duration,
}

/// A token-bucket rate limiter keyed by an arbitrary string (IP, device id,
/// etc). Configurable per bucket. This is intentionally simple (no external
/// service dependency) since HelixSync is meant to run self-hosted with a
/// single server process.
///
/// Replaces an earlier fixed-window implementation (SRV-4): a fixed window
/// lets a client spend its full quota at the tail end of one window and
/// again the instant the next window opens, a burst of up to 2x `limit` in
/// a short span straddling the boundary. A token bucket refills continuously
/// at `limit / window` tokens/sec instead of resetting atomically, so that
/// boundary re-burst can't happen — a client that exhausts its bucket only
/// gets tokens back gradually, not all at once.
pub struct RateLimiter {
    windows: DashMap<(&'static str, String), TokenBucket>,
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
        self.check_with_retry_after(bucket, key, limit, window).is_ok()
    }

    /// Same token-bucket check as `check`, but on rejection also reports how
    /// long until at least one token refills. `check` is defined in terms of
    /// this so there's exactly one copy of the bucket logic; existing
    /// callers of `check`/`enforce` are unaffected since their signature and
    /// behavior haven't changed. Added for the WebSocket connect path, which
    /// needs to tell a rejected client when it's safe to retry instead of
    /// just closing on it.
    ///
    /// A fresh (bucket, key) starts at full capacity (`limit` tokens), so
    /// the first `limit` calls succeed immediately — an intentional initial
    /// burst allowance, not the SRV-4 bug (which was the *boundary* re-burst,
    /// not bursting itself). Each call refills tokens for the elapsed time
    /// since the last call at a rate of `limit / window` tokens/sec, capped
    /// at `limit`, then consumes one token if available.
    pub fn check_with_retry_after(
        &self,
        bucket: &'static str,
        key: &str,
        limit: u32,
        window: Duration,
    ) -> Result<(), Duration> {
        let now = Instant::now();
        let mut entry = self.windows.entry((bucket, key.to_string())).or_insert_with(|| TokenBucket {
            last_refill: now,
            tokens: limit as f64,
            window,
        });

        let rate = limit as f64 / window.as_secs_f64(); // tokens/sec
        let elapsed = now.duration_since(entry.last_refill);
        entry.tokens = (entry.tokens + elapsed.as_secs_f64() * rate).min(limit as f64);
        entry.last_refill = now;
        entry.window = window;

        if entry.tokens >= 1.0 {
            entry.tokens -= 1.0;
            Ok(())
        } else {
            let seconds_until_token = (1.0 - entry.tokens) / rate;
            Err(Duration::from_secs_f64(seconds_until_token))
        }
    }

    /// Drops entries that are guaranteed to be back at full capacity — i.e.
    /// ones where a full `window`'s worth of refill time has passed since
    /// `last_refill`, which always adds at least `limit` tokens (capped at
    /// `limit`) regardless of how empty the bucket was. Such entries carry
    /// no remaining rate-limiting effect and are pure dead weight. Without
    /// this the map grows by one entry per distinct (bucket, key) —
    /// notably every client IP that has ever hit an unauthenticated
    /// endpoint (login, register, device register, token refresh) — for
    /// as long as the process runs, since nothing else ever removes an
    /// entry.
    fn sweep(&self) {
        let now = Instant::now();
        self.windows
            .retain(|_, bucket| now.duration_since(bucket.last_refill) < bucket.window);
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
///
/// Uses `check_with_retry_after` (rather than the bare `check`) so the
/// real wait duration reaches `AppError::RateLimited` instead of being
/// discarded — every non-WebSocket rate-limited route goes through this
/// function, so this is what puts a `Retry-After` header on their 429s.
pub fn enforce(limiter: &RateLimiter, config: RateLimitConfig, key: &str) -> Result<(), AppError> {
    limiter
        .check_with_retry_after(config.bucket, key, config.limit, config.window)
        .map_err(AppError::RateLimited)
}

/// Like `enforce`, but for the one call site (the WebSocket connect path)
/// that needs the remaining-window duration on rejection rather than a bare
/// `AppError`, so it can tell the client when to retry instead of just
/// closing on it.
pub fn enforce_with_retry_after(
    limiter: &RateLimiter,
    config: RateLimitConfig,
    key: &str,
) -> Result<(), Duration> {
    limiter.check_with_retry_after(config.bucket, key, config.limit, config.window)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_key_allows_limit_requests_immediately() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);
        for _ in 0..5 {
            assert!(limiter.check("test", "key", 5, window));
        }
    }

    #[test]
    fn limit_plus_one_request_is_rejected() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);
        for _ in 0..5 {
            assert!(limiter.check("test", "key", 5, window));
        }
        assert!(!limiter.check("test", "key", 5, window));
    }

    // SRV-4 regression: a fixed-window limiter would let the full quota
    // reappear atomically the instant a window boundary passed. With a
    // token bucket there's no boundary to straddle, so the very next call
    // right after exhausting the bucket must still be rejected.
    #[test]
    fn no_full_quota_reappears_immediately_after_exhaustion() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);
        for _ in 0..3 {
            assert!(limiter.check("test", "key", 3, window));
        }
        assert!(!limiter.check("test", "key", 3, window));
        // Immediately again, no delay at all — must still be rejected.
        assert!(!limiter.check("test", "key", 3, window));
    }

    #[test]
    fn partial_refill_allows_request_after_waiting() {
        let limiter = RateLimiter::new();
        // 20 tokens/sec, so one token refills in 50ms.
        let window = Duration::from_millis(50);
        let limit = 1;
        assert!(limiter.check("test", "key", limit, window));
        assert!(!limiter.check("test", "key", limit, window));
        std::thread::sleep(Duration::from_millis(60));
        assert!(limiter.check("test", "key", limit, window));
    }

    #[test]
    fn check_with_retry_after_reports_wait_duration_on_rejection() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);
        assert!(limiter.check_with_retry_after("test", "key", 1, window).is_ok());
        let err = limiter
            .check_with_retry_after("test", "key", 1, window)
            .expect_err("bucket should be empty");
        assert!(err > Duration::from_secs(0));
        assert!(err <= window);
    }
}
