use std::sync::atomic::{AtomicU64, Ordering};
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
    /// Wall-clock start point `last_emergency_sweep_nanos` is measured from
    /// (an `AtomicU64` can't hold an `Instant` directly).
    created_at: Instant,
    /// Nanoseconds since `created_at` at which the last capacity-triggered
    /// sweep (see `check_with_retry_after`) ran. Used to rate-limit those
    /// sweeps themselves to at most one per `EMERGENCY_SWEEP_COOLDOWN` —
    /// without this, once `windows` is at capacity and full of genuinely
    /// active (non-expired) entries, every subsequent request for a new key
    /// would trigger its own full `sweep()` (an O(n) scan) that frees
    /// nothing, turning the very defense against unbounded memory growth
    /// into an unbounded-CPU-per-request problem instead.
    last_emergency_sweep_nanos: AtomicU64,
}

/// Hard cap on the number of distinct (bucket, key) entries `windows` may
/// hold. Without this, an attacker who varies the rate-limit key on every
/// request (random `X-Forwarded-For` values, random device ids at
/// `/devices/register`, etc.) can insert entries faster than the periodic
/// `sweep()` (every `SWEEP_INTERVAL`) can remove them, growing `windows`
/// without bound. See `check_with_retry_after` for how this is enforced —
/// only *new* keys are affected, and only once the map is actually at
/// capacity.
const MAX_ENTRIES: usize = 50_000;

/// Minimum spacing between capacity-triggered emergency sweeps (see
/// `last_emergency_sweep_nanos`). Deliberately much shorter than
/// `SWEEP_INTERVAL` — this only matters while the map is actively at
/// capacity, a state the periodic sweep alone isn't keeping up with, so it
/// needs to be responsive; but it still needs to be nonzero so a sustained
/// flood of new keys can't force a full O(n) scan on every single request.
const EMERGENCY_SWEEP_COOLDOWN: Duration = Duration::from_secs(1);

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            windows: DashMap::new(),
            created_at: Instant::now(),
            last_emergency_sweep_nanos: AtomicU64::new(0),
        }
    }

    /// Runs `sweep()` if (and only if) no other caller has done so within
    /// the last `EMERGENCY_SWEEP_COOLDOWN`. The compare-exchange ensures
    /// that when many requests hit this concurrently while the map is
    /// saturated, only one of them actually pays for the O(n) scan — the
    /// rest just fall through and re-check `windows.len()` (cheap: DashMap
    /// sums per-shard lengths rather than iterating entries).
    fn maybe_emergency_sweep(&self) {
        let now_nanos = self.created_at.elapsed().as_nanos() as u64;
        let last = self.last_emergency_sweep_nanos.load(Ordering::Relaxed);
        let cooldown_nanos = EMERGENCY_SWEEP_COOLDOWN.as_nanos() as u64;
        if now_nanos.saturating_sub(last) < cooldown_nanos {
            return;
        }
        if self
            .last_emergency_sweep_nanos
            .compare_exchange(last, now_nanos, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            self.sweep();
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
    ///
    /// If `key` is new (not already tracked) and `windows` is at or over
    /// `MAX_ENTRIES`, an emergency sweep is attempted first (see
    /// `maybe_emergency_sweep`) to try to reclaim space from expired
    /// entries before giving up on the new key. If the map is still at
    /// capacity afterwards (i.e. it's full of genuinely active entries, not
    /// just ones waiting on the next periodic sweep — or another request
    /// already used up this window's emergency sweep), the new key is
    /// rejected the same way an ordinary rate-limited request would be,
    /// rather than growing the map further. Already-tracked keys are never
    /// affected by this: only brand new ones can be turned away, and only
    /// while the map is saturated.
    pub fn check_with_retry_after(
        &self,
        bucket: &'static str,
        key: &str,
        limit: u32,
        window: Duration,
    ) -> Result<(), Duration> {
        let map_key = (bucket, key.to_string());

        if !self.windows.contains_key(&map_key) && self.windows.len() >= MAX_ENTRIES {
            self.maybe_emergency_sweep();
            if self.windows.len() >= MAX_ENTRIES {
                // Genuinely full of active entries — reject rather than
                // grow past the cap. Reuse `window` as the retry hint since
                // that's roughly how long it'll take for other entries in
                // this bucket to age out and free up room.
                return Err(window);
            }
        }

        let now = Instant::now();
        let mut entry = self.windows.entry(map_key).or_insert_with(|| TokenBucket {
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
// Applied at the HTTP-upgrade handshake, before any auth frame has been
// read — keyed by IP rather than device id, since there's no device claim
// yet at that point (that's the whole reason this layer exists: see
// websocket::ws_handler's doc comment). Deliberately much more generous
// than WEBSOCKET_CONNECT_LIMIT's 30/min: one IP can legitimately be an
// entire office, university, or carrier-grade-NAT's worth of independent
// users/devices, so this must not clamp shared-IP traffic down to
// single-device levels. It's also cheap to check per-request relative to
// an authenticated route — no DB round trip, no JWT verification, just the
// token-bucket lookup — so it can afford to sit well above the per-device
// limit while still bounding raw connection-attempt (and thus fd/socket)
// volume from a single source.
pub const WEBSOCKET_HANDSHAKE_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "websocket_handshake",
    limit: 300,
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

    #[test]
    fn distinct_keys_do_not_grow_windows_past_capacity() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);
        // Far more distinct keys than MAX_ENTRIES, all with plenty of
        // quota left, so every rejection observed here can only be the
        // capacity guard kicking in, not the token bucket itself.
        for i in 0..(MAX_ENTRIES * 2) {
            let key = format!("key-{i}");
            limiter.check("test", &key, 1000, window);
        }
        assert!(limiter.windows.len() <= MAX_ENTRIES);
    }

    #[test]
    fn existing_key_is_unaffected_by_a_full_map() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);

        // Track one key first, then saturate the map with other keys.
        assert!(limiter.check("test", "known-key", 5, window));
        for i in 0..MAX_ENTRIES {
            let key = format!("filler-{i}");
            limiter.check("test", &key, 1000, window);
        }
        assert!(limiter.windows.len() >= MAX_ENTRIES);

        // The already-tracked key still has its normal remaining quota
        // (4 more of its 5-per-window tokens), unaffected by the map being
        // at capacity.
        for _ in 0..4 {
            assert!(limiter.check("test", "known-key", 5, window));
        }
        assert!(!limiter.check("test", "known-key", 5, window));
    }
}
