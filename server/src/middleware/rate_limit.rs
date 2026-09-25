use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;

use crate::error::AppError;

/// Token-bucket state for one (bucket, key). `tokens` is fractional so it
/// refills smoothly. `window` is stored so `sweep` can use it.
struct TokenBucket {
    last_refill: Instant,
    tokens: f64,
    window: Duration,
}

/// State for one [`RateLimitPartition`]. Each partition has its own map,
/// capacity, and cooldown clocks, so one can't use up the other's space.
struct Partition {
    windows: DashMap<(&'static str, String), TokenBucket>,
    /// Entries per bucket, so one bucket can't crowd out the others.
    bucket_counts: DashMap<&'static str, AtomicUsize>,
    /// Max entries in `windows`. See `MAX_UNTRUSTED_ENTRIES`.
    capacity: usize,
    /// When the last emergency sweep ran, as nanos since
    /// `RateLimiter::created_at`. Limits those sweeps to one per
    /// `EMERGENCY_SWEEP_COOLDOWN` so a full map doesn't cost a scan per request.
    last_emergency_sweep_nanos: AtomicU64,
    /// When the last eviction scan found nothing. See `EVICTION_SCAN_COOLDOWN`.
    last_failed_eviction_scan_nanos: AtomicU64,
}

impl Partition {
    fn new(capacity: usize) -> Self {
        Self {
            windows: DashMap::new(),
            bucket_counts: DashMap::new(),
            capacity,
            last_emergency_sweep_nanos: AtomicU64::new(0),
            // u64::MAX means "no failed scan yet". 0 would wrongly block
            // the first eviction.
            last_failed_eviction_scan_nanos: AtomicU64::new(u64::MAX),
        }
    }

    fn bucket_count(&self, bucket: &'static str) -> usize {
        self.bucket_counts
            .get(bucket)
            .map(|c| c.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    fn increment_bucket_count(&self, bucket: &'static str) {
        self.bucket_counts
            .entry(bucket)
            .or_insert_with(|| AtomicUsize::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }

    fn decrement_bucket_count(&self, bucket: &'static str) {
        if let Some(counter) = self.bucket_counts.get(bucket) {
            let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |val| {
                Some(val.saturating_sub(1))
            });
        }
    }

    /// True if an eviction scan found nothing within `EVICTION_SCAN_COOLDOWN`
    /// of `now_nanos`; a new scan would likely fail again.
    fn eviction_scan_on_cooldown(&self, now_nanos: u64) -> bool {
        let last = self.last_failed_eviction_scan_nanos.load(Ordering::Relaxed);
        let cooldown_nanos = EVICTION_SCAN_COOLDOWN.as_nanos() as u64;
        last != u64::MAX && now_nanos.saturating_sub(last) < cooldown_nanos
    }

    /// Removes `key` if still present. Returns true if a slot was freed.
    fn remove(&self, key: &(&'static str, String)) -> bool {
        match self.windows.remove(key) {
            Some((k, _)) => {
                self.decrement_bucket_count(k.0);
                true
            }
            None => false,
        }
    }

    /// Removes entries that have been idle for a full window. They're back
    /// at full tokens, so dropping them changes nothing and frees memory.
    fn sweep(&self) {
        let now = Instant::now();
        self.windows.retain(|(b, _), bucket| {
            let keep = now.duration_since(bucket.last_refill) < bucket.window;
            if !keep {
                self.decrement_bucket_count(b);
            }
            keep
        });
    }
}

/// In-memory token-bucket rate limiter, keyed by any string (IP, device id,
/// ...). No external service needed, since the server runs as one process.
///
/// Tokens refill steadily at `limit / window` per second, so a client can't
/// burst twice at a window boundary like with a fixed window.
pub struct RateLimiter {
    /// Untrusted keys (IPs, presented tokens) are kept apart from verified
    /// user/device keys so they can't use up their capacity.
    untrusted: Partition,
    authenticated: Partition,
    /// Base time for the `*_nanos` fields in `Partition`.
    created_at: Instant,
}

/// Max entries per partition. Stops an attacker who sends a new key on
/// every request from growing the map without limit. Only new keys are
/// affected, and only when full.
const MAX_UNTRUSTED_ENTRIES: usize = 25_000;
const MAX_AUTHENTICATED_ENTRIES: usize = 25_000;
/// Max entries one bucket may hold when the partition is full, so one bucket
/// (e.g. refresh token hashes) can't starve the others (e.g. login).
pub const MAX_ENTRIES_PER_BUCKET: usize = 5_000;

/// How much the rate-limit key is trusted. A route can use both, e.g.
/// refresh limits by presented token, then by verified device id.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RateLimitPartition {
    Untrusted,
    Authenticated,
}

/// Min time between emergency sweeps. Short, but not zero, so a flood of
/// new keys can't force a full scan on every request.
const EMERGENCY_SWEEP_COOLDOWN: Duration = Duration::from_secs(1);

/// Max entries one eviction scan looks at.
const EVICTION_SCAN_CAP: usize = 64;

/// After a scan finds nothing to evict, skip scans for this long. Stops
/// every new key from paying for a scan that will fail anyway.
const EVICTION_SCAN_COOLDOWN: Duration = Duration::from_millis(200);

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            untrusted: Partition::new(MAX_UNTRUSTED_ENTRIES),
            authenticated: Partition::new(MAX_AUTHENTICATED_ENTRIES),
            created_at: Instant::now(),
        }
    }

    fn partition(&self, partition: RateLimitPartition) -> &Partition {
        match partition {
            RateLimitPartition::Untrusted => &self.untrusted,
            RateLimitPartition::Authenticated => &self.authenticated,
        }
    }

    fn now_nanos(&self) -> u64 {
        self.created_at.elapsed().as_nanos() as u64
    }

    /// Frees one slot by removing an expired entry, or an entry from a
    /// bucket over its share. Scans at most `EVICTION_SCAN_CAP` entries and
    /// backs off after a failed scan. Returns false if nothing was freed.
    fn evict_one_entry(&self, part: &Partition, exempt_bucket: &'static str) -> bool {
        let now_nanos = self.now_nanos();
        if part.eviction_scan_on_cooldown(now_nanos) {
            // A recent scan found nothing; assume it would fail again.
            return false;
        }

        let now = Instant::now();
        let candidate = {
            let mut expired = None;
            let mut monopolizer = None;
            let mut checked = 0;
            for entry in part.windows.iter() {
                let (b, _) = entry.key();
                if now.duration_since(entry.value().last_refill) >= entry.value().window {
                    expired = Some(entry.key().clone());
                    break;
                }
                if monopolizer.is_none()
                    && *b != exempt_bucket
                    && part.bucket_count(b) >= MAX_ENTRIES_PER_BUCKET
                {
                    monopolizer = Some(entry.key().clone());
                }
                checked += 1;
                if checked >= EVICTION_SCAN_CAP {
                    break;
                }
            }
            expired.or(monopolizer)
        };

        let Some(key) = candidate else {
            part.last_failed_eviction_scan_nanos
                .store(now_nanos, Ordering::Relaxed);
            return false;
        };

        part.remove(&key)
    }

    /// Frees one slot by removing the oldest entry in `bucket` itself. Used
    /// when the caller's own bucket is full, e.g. an attacker flooding
    /// `login` with many keys. Without this, new legitimate keys would be
    /// locked out until entries expire.
    ///
    /// Existing keys never reach here, so an attacker gains nothing by
    /// evicting their own entries. Same scan cap and cooldown as `evict_one_entry`.
    fn evict_lru_in_bucket(&self, part: &Partition, bucket: &'static str) -> bool {
        let now_nanos = self.now_nanos();
        if part.eviction_scan_on_cooldown(now_nanos) {
            return false;
        }

        let candidate = {
            let mut oldest: Option<((&'static str, String), Instant)> = None;
            let mut checked = 0;
            for entry in part.windows.iter() {
                let (b, _) = entry.key();
                if *b == bucket {
                    let refill = entry.value().last_refill;
                    let is_older = oldest.as_ref().is_none_or(|(_, t)| refill < *t);
                    if is_older {
                        oldest = Some((entry.key().clone(), refill));
                    }
                }
                checked += 1;
                if checked >= EVICTION_SCAN_CAP {
                    break;
                }
            }
            oldest.map(|(k, _)| k)
        };

        let Some(key) = candidate else {
            part.last_failed_eviction_scan_nanos
                .store(now_nanos, Ordering::Relaxed);
            return false;
        };

        part.remove(&key)
    }

    /// Runs `Partition::sweep` unless one ran within `EMERGENCY_SWEEP_COOLDOWN`.
    /// The compare-exchange makes sure only one caller does the scan.
    fn maybe_emergency_sweep(&self, part: &Partition) {
        let now_nanos = self.now_nanos();
        let last_sweep = &part.last_emergency_sweep_nanos;
        let last = last_sweep.load(Ordering::Relaxed);
        let cooldown_nanos = EMERGENCY_SWEEP_COOLDOWN.as_nanos() as u64;
        if now_nanos.saturating_sub(last) < cooldown_nanos {
            return;
        }
        if last_sweep
            .compare_exchange(last, now_nanos, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            part.sweep();
        }
    }

    /// Returns true if the request is within `limit` per `window`.
    pub fn check(
        &self,
        partition: RateLimitPartition,
        bucket: &'static str,
        key: &str,
        limit: u32,
        window: Duration,
    ) -> bool {
        self.check_with_retry_after(partition, bucket, key, limit, window)
            .is_ok()
    }

    /// Like `check`, but on rejection returns how long until a token is
    /// available.
    ///
    /// A new key starts with a full bucket (`limit` tokens). Each call adds
    /// tokens for the elapsed time (capped at `limit`) and takes one.
    ///
    /// When the partition is full, a new key first tries to free space (sweep
    /// or eviction). If none can be freed, it's rejected like a rate-limited
    /// request. Existing keys are never affected.
    pub fn check_with_retry_after(
        &self,
        partition: RateLimitPartition,
        bucket: &'static str,
        key: &str,
        limit: u32,
        window: Duration,
    ) -> Result<(), Duration> {
        let part = self.partition(partition);
        let (windows, capacity) = (&part.windows, part.capacity);
        let map_key = (bucket, key.to_string());

        if !windows.contains_key(&map_key) && windows.len() >= capacity {
            let bucket_count = part.bucket_count(bucket);
            if bucket_count >= MAX_ENTRIES_PER_BUCKET {
                self.maybe_emergency_sweep(part);
                let count_after = part.bucket_count(bucket);
                if count_after >= MAX_ENTRIES_PER_BUCKET {
                    // Still over its share: evict this bucket's oldest entry
                    // instead of locking out new keys.
                    if !self.evict_lru_in_bucket(part, bucket) {
                        return Err(window);
                    }
                } else if windows.len() >= capacity {
                    // Partition still full of other buckets' entries.
                    return Err(window);
                }
            } else {
                // Under its share: free an expired or over-share entry.
                // If nothing can be freed, reject instead of going over the cap.
                if !self.evict_one_entry(part, bucket) && windows.len() >= capacity {
                    return Err(window);
                }
            }
        }

        let now = Instant::now();
        let (mut entry, is_new) = match windows.entry(map_key) {
            dashmap::mapref::entry::Entry::Occupied(occ) => (occ.into_ref(), false),
            dashmap::mapref::entry::Entry::Vacant(vac) => {
                let entry = vac.insert(TokenBucket {
                    last_refill: now,
                    tokens: limit as f64,
                    window,
                });
                (entry, true)
            }
        };

        if is_new {
            part.increment_bucket_count(bucket);
        }

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

    fn sweep(&self) {
        self.untrusted.sweep();
        self.authenticated.sweep();
    }
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

const SWEEP_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Starts the periodic sweep. Call once from `main.rs`.
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
    pub partition: RateLimitPartition,
}

pub const LOGIN_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "login",
    limit: 10,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Untrusted,
};
pub const REGISTER_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "register",
    limit: 5,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Untrusted,
};
pub const TOKEN_REFRESH_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "token_refresh",
    limit: 30,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Untrusted,
};
pub const TOKEN_REFRESH_IP_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "token_refresh_ip",
    limit: 300,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Untrusted,
};
pub const TOKEN_REFRESH_AUTHENTICATED_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "token_refresh",
    limit: 30,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Authenticated,
};
pub const DEVICE_REGISTER_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "device_register",
    limit: 10,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Untrusted,
};
// Per-account login limit, keyed by normalized email. Stops guesses spread
// across many IPs. Untrusted, since the email isn't verified yet.
pub const LOGIN_EMAIL_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "login_email",
    limit: 10,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Untrusted,
};
pub const DEVICE_REGISTER_EMAIL_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "device_register_email",
    limit: 10,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Untrusted,
};
pub const SYNC_UPLOAD_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "sync_upload",
    limit: 600,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Authenticated,
};
pub const SYNC_DOWNLOAD_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "sync_download",
    limit: 600,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Authenticated,
};
// Lower than `/changes`: these rebuild full object state, which costs more.
pub const SYNC_SNAPSHOT_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "sync_snapshot",
    limit: 20,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Authenticated,
};
pub const SYNC_STATS_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "sync_stats",
    limit: 30,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Authenticated,
};
pub const WEBSOCKET_CONNECT_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "websocket_connect",
    limit: 30,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Authenticated,
};
// Per-IP limit on the websocket upgrade, before auth. Much higher than
// WEBSOCKET_CONNECT_LIMIT because many users can share one IP (office, NAT).
pub const WEBSOCKET_HANDSHAKE_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "websocket_handshake",
    limit: 300,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Untrusted,
};
// Backstop in case the extension's 60s settings cache ever breaks.
pub const SYNC_SETTINGS_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "sync_settings",
    limit: 60,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Authenticated,
};

/// Checks a rate limit and returns `AppError::RateLimited` (with retry
/// time) if exceeded. Called from handlers since limits differ per route.
pub fn enforce(limiter: &RateLimiter, config: RateLimitConfig, key: &str) -> Result<(), AppError> {
    enforce_with_retry_after(limiter, config, key).map_err(AppError::RateLimited)
}

/// Like `enforce`, but returns the retry time directly (used by the websocket).
pub fn enforce_with_retry_after(
    limiter: &RateLimiter,
    config: RateLimitConfig,
    key: &str,
) -> Result<(), Duration> {
    limiter.check_with_retry_after(
        config.partition,
        config.bucket,
        key,
        config.limit,
        config.window,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_key_allows_limit_requests_immediately() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);
        for _ in 0..5 {
            assert!(limiter.check(RateLimitPartition::Untrusted, "test", "key", 5, window));
        }
    }

    #[test]
    fn limit_plus_one_request_is_rejected() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);
        for _ in 0..5 {
            assert!(limiter.check(RateLimitPartition::Untrusted, "test", "key", 5, window));
        }
        assert!(!limiter.check(RateLimitPartition::Untrusted, "test", "key", 5, window));
    }

    // A token bucket has no window boundary, so the quota must not come
    // back all at once right after being used up.
    #[test]
    fn no_full_quota_reappears_immediately_after_exhaustion() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);
        for _ in 0..3 {
            assert!(limiter.check(RateLimitPartition::Untrusted, "test", "key", 3, window));
        }
        assert!(!limiter.check(RateLimitPartition::Untrusted, "test", "key", 3, window));
        // Immediately again, no delay at all — must still be rejected.
        assert!(!limiter.check(RateLimitPartition::Untrusted, "test", "key", 3, window));
    }

    #[test]
    fn partial_refill_allows_request_after_waiting() {
        let limiter = RateLimiter::new();
        // 20 tokens/sec, so one token refills in 50ms.
        let window = Duration::from_millis(50);
        let limit = 1;
        assert!(limiter.check(RateLimitPartition::Untrusted, "test", "key", limit, window));
        assert!(!limiter.check(RateLimitPartition::Untrusted, "test", "key", limit, window));
        std::thread::sleep(Duration::from_millis(60));
        assert!(limiter.check(RateLimitPartition::Untrusted, "test", "key", limit, window));
    }

    #[test]
    fn check_with_retry_after_reports_wait_duration_on_rejection() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);
        assert!(limiter
            .check_with_retry_after(RateLimitPartition::Untrusted, "test", "key", 1, window)
            .is_ok());
        let err = limiter
            .check_with_retry_after(RateLimitPartition::Untrusted, "test", "key", 1, window)
            .expect_err("bucket should be empty");
        assert!(err > Duration::from_secs(0));
        assert!(err <= window);
    }

    #[test]
    fn distinct_keys_do_not_grow_windows_past_capacity() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);
        // Many more keys than the cap, each with quota left, so any rejection
        // comes from the capacity guard.
        for i in 0..(MAX_UNTRUSTED_ENTRIES * 2) {
            let key = format!("key-{i}");
            limiter.check(RateLimitPartition::Untrusted, "test", &key, 1000, window);
        }
        assert!(limiter.untrusted.windows.len() <= MAX_UNTRUSTED_ENTRIES);
    }

    #[test]
    fn existing_key_is_unaffected_by_a_full_map() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);

        // Track one key first, then saturate the map with other keys.
        assert!(limiter.check(
            RateLimitPartition::Untrusted,
            "test",
            "known-key",
            5,
            window
        ));
        for i in 0..MAX_UNTRUSTED_ENTRIES {
            let key = format!("filler-{i}");
            limiter.check(RateLimitPartition::Untrusted, "test", &key, 1000, window);
        }
        assert!(limiter.untrusted.windows.len() >= MAX_UNTRUSTED_ENTRIES);

        // The existing key keeps its quota even though the map is full.
        for _ in 0..4 {
            assert!(limiter.check(
                RateLimitPartition::Untrusted,
                "test",
                "known-key",
                5,
                window
            ));
        }
        assert!(!limiter.check(
            RateLimitPartition::Untrusted,
            "test",
            "known-key",
            5,
            window
        ));
    }

    #[test]
    fn saturating_untrusted_partition_does_not_block_authenticated_partition() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);

        // Fill the untrusted partition using one bucket, past its share.
        for i in 0..MAX_UNTRUSTED_ENTRIES {
            let key = format!("filler-{i}");
            limiter.check(RateLimitPartition::Untrusted, "test", &key, 1000, window);
        }
        assert!(limiter.untrusted.windows.len() >= MAX_UNTRUSTED_ENTRIES);

        // A new key in that same bucket still gets in by evicting the
        // bucket's oldest entry.
        assert!(limiter.check(
            RateLimitPartition::Untrusted,
            "test",
            "new-untrusted-key",
            1000,
            window
        ));
        // Still capped: eviction swaps one entry for another.
        assert!(limiter.untrusted.windows.len() <= MAX_UNTRUSTED_ENTRIES);

        // The authenticated partition should still have space and allow new keys
        assert!(limiter.check(
            RateLimitPartition::Authenticated,
            "test",
            "new-authenticated-key",
            1000,
            window
        ));
        assert!(limiter.authenticated.windows.len() == 1);
    }

    #[test]
    fn token_refresh_authenticated_limit_uses_authenticated_partition() {
        let limiter = RateLimiter::new();
        assert_eq!(
            TOKEN_REFRESH_AUTHENTICATED_LIMIT.partition,
            RateLimitPartition::Authenticated
        );
        assert_eq!(TOKEN_REFRESH_AUTHENTICATED_LIMIT.bucket, "token_refresh");

        // When untrusted partition is saturated, TOKEN_REFRESH_AUTHENTICATED_LIMIT is still accepted
        for i in 0..MAX_UNTRUSTED_ENTRIES {
            let key = format!("filler-{i}");
            enforce(&limiter, TOKEN_REFRESH_LIMIT, &key).unwrap();
        }
        assert!(limiter.untrusted.windows.len() >= MAX_UNTRUSTED_ENTRIES);

        // A new key in the full bucket is still accepted, and the cap holds.
        assert!(enforce(&limiter, TOKEN_REFRESH_LIMIT, "new-token-hash").is_ok());
        assert!(limiter.untrusted.windows.len() <= MAX_UNTRUSTED_ENTRIES);

        // The two partitions are independent.
        assert!(enforce(
            &limiter,
            TOKEN_REFRESH_AUTHENTICATED_LIMIT,
            "device-uuid-123"
        )
        .is_ok());
        assert!(limiter
            .authenticated
            .windows
            .contains_key(&("token_refresh", "device-uuid-123".to_string())));
    }

    #[test]
    fn saturating_one_untrusted_bucket_does_not_block_other_untrusted_buckets() {
        let limiter = RateLimiter::new();

        // Flood the untrusted partition via token_refresh up to capacity
        for i in 0..MAX_UNTRUSTED_ENTRIES {
            let key = format!("token-{i}");
            assert!(enforce(&limiter, TOKEN_REFRESH_LIMIT, &key).is_ok());
        }
        assert!(limiter.untrusted.windows.len() >= MAX_UNTRUSTED_ENTRIES);

        // Another token_refresh key still gets in (evicts the oldest), and
        // the cap holds.
        assert!(enforce(&limiter, TOKEN_REFRESH_LIMIT, "new-token-hash").is_ok());
        assert!(limiter.untrusted.windows.len() <= MAX_UNTRUSTED_ENTRIES);

        // Other untrusted buckets must not be starved:
        // 1. New login attempt
        assert!(enforce(&limiter, LOGIN_LIMIT, "192.168.1.1").is_ok());

        // 2. New registration attempt
        assert!(enforce(&limiter, REGISTER_LIMIT, "192.168.1.2").is_ok());

        // 3. New device registration
        assert!(enforce(&limiter, DEVICE_REGISTER_LIMIT, "192.168.1.3").is_ok());

        // 4. New websocket handshake
        assert!(enforce(&limiter, WEBSOCKET_HANDSHAKE_LIMIT, "192.168.1.4").is_ok());

        // Partition capacity must remain strictly bounded
        assert!(limiter.untrusted.windows.len() <= MAX_UNTRUSTED_ENTRIES);
    }

    #[test]
    fn expired_entries_are_reclaimed_when_at_capacity() {
        let limiter = RateLimiter::new();
        let short_window = Duration::from_millis(40);

        // Fill a bucket up to MAX_ENTRIES_PER_BUCKET
        for i in 0..MAX_ENTRIES_PER_BUCKET {
            let key = format!("key-{i}");
            assert!(limiter.check(
                RateLimitPartition::Untrusted,
                "temp",
                &key,
                10,
                short_window
            ));
        }

        // Wait for entries to expire
        std::thread::sleep(Duration::from_millis(50));

        // Expired entries get reclaimed, so the new key gets in.
        assert!(limiter.check(
            RateLimitPartition::Untrusted,
            "temp",
            "after-expiry",
            10,
            short_window
        ));
    }

    // Spread keys over several buckets, each under its share, until the
    // partition is full. Eviction must stay cheap and the cap must hold.
    #[test]
    fn saturation_spread_across_buckets_stays_within_hard_cap_without_unbounded_scans() {
        let limiter = RateLimiter::new();
        let window = Duration::from_secs(60);

        let buckets: [&'static str; 6] = [
            "bucket_a", "bucket_b", "bucket_c", "bucket_d", "bucket_e", "bucket_f",
        ];
        // Strictly under MAX_ENTRIES_PER_BUCKET per bucket, but the total
        // across all six reaches MAX_UNTRUSTED_ENTRIES.
        let per_bucket = MAX_ENTRIES_PER_BUCKET - 1;
        assert!(buckets.len() * per_bucket >= MAX_UNTRUSTED_ENTRIES);

        let start = Instant::now();
        for bucket in buckets {
            for i in 0..per_bucket {
                let key = format!("{bucket}-{i}");
                limiter.check(RateLimitPartition::Untrusted, bucket, &key, 1000, window);
            }
        }
        let elapsed = start.elapsed();
        // Loose bound; bounded scans should finish well under a second.
        assert!(
            elapsed < Duration::from_secs(5),
            "saturating across buckets took {elapsed:?} — evict_one_entry may be scanning unboundedly"
        );

        // The cap holds even though no bucket went over its share.
        assert!(limiter.untrusted.windows.len() <= MAX_UNTRUSTED_ENTRIES);

        // A new key in a new bucket is rejected, not forced in.
        assert!(!limiter.check(
            RateLimitPartition::Untrusted,
            "bucket_g",
            "overflow-key",
            1000,
            window
        ));
        assert!(limiter.untrusted.windows.len() <= MAX_UNTRUSTED_ENTRIES);
    }
}
