use std::env;

use axum::http::HeaderValue;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    pub jwt_signing_key: Vec<u8>,
    pub access_token_ttl_secs: i64,
    pub refresh_token_ttl_secs: i64,
    pub web_session_ttl_secs: i64,
    pub require_encryption: bool,
    /// True when the server sits behind a trusted proxy (e.g. nginx in
    /// docker-compose). Then `middleware::client_ip` trusts `X-Real-IP` /
    /// `X-Forwarded-For`. Keep false otherwise, or clients can spoof their IP.
    pub behind_proxy: bool,
    pub cors_allowed_origins: Vec<String>,
    pub protocol_version: u32,
    pub minimum_supported_protocol_version: u32,
    pub api_version: String,
    /// Extra time the raw log row of a delete is kept after compaction could
    /// remove it. Audit margin only (docs/protocol.md §9, §11).
    pub tombstone_retention_secs: i64,
    /// How often compaction runs (docs/protocol.md §11).
    pub compaction_interval_secs: u64,
    /// Devices inactive longer than this no longer hold back compaction.
    /// If they come back, they fall back to a snapshot (`cursor_too_old`).
    pub inactive_device_compaction_grace_period_secs: i64,
    /// Devices that never called `/changes` stop holding back compaction
    /// after this long since registration. Shorter than the inactive grace
    /// period, since uploads alone keep `last_seen_at` fresh.
    pub never_synced_device_compaction_grace_period_secs: i64,
    /// How often housekeeping runs. Its deletes are cheap, so less often than compaction.
    pub housekeeping_interval_secs: u64,
    /// Grace period before housekeeping deletes an expired device credential.
    pub device_credential_retention_secs: i64,
    /// How long audit logs are kept, measured from `created_at`.
    pub audit_log_retention_secs: i64,
    /// How long `tab` / `window` tombstones are kept. These can't be restored
    /// or reused, so they're safe to delete. Bookmark tombstones are never
    /// swept; they stay until a `restore`.
    pub ephemeral_tombstone_retention_secs: i64,
    /// Max Postgres connections in the pool.
    pub database_max_connections: u32,
    /// How often the websocket pings and re-checks token expiry and
    /// revocation. Configurable so tests can make it short.
    pub websocket_ping_interval_secs: u64,
    /// Max active (non-revoked) devices per account. Every device takes part
    /// in compaction, so this stops one account from adding unlimited devices.
    pub max_devices_per_account: i64,
    /// Max time a single HTTP request may run (see `lib.rs::app`).
    pub request_timeout_secs: u64,
    /// Max time for one websocket send. A client that stops reading could
    /// otherwise block the connection task forever.
    pub websocket_send_timeout_secs: u64,
    /// Max wait for the per-device upload lock. Waiting requests hold their
    /// body in memory, so they shouldn't queue forever.
    pub upload_semaphore_acquire_timeout_secs: u64,
    /// Max time graceful shutdown waits for requests to finish before exiting.
    pub shutdown_deadline_secs: u64,
}

// The parse_* helpers take the raw value instead of reading env vars, so
// tests don't race on shared process env.

/// Parses a non-negative `i64` (zero is allowed). Missing uses `default`;
/// an invalid value fails startup.
fn parse_nonnegative_secs(name: &str, raw: Option<&str>, default: i64) -> anyhow::Result<i64> {
    match raw {
        None => Ok(default),
        Some(v) => {
            let parsed: i64 = v
                .parse()
                .map_err(|_| anyhow::anyhow!("{name} must be an integer, got {v:?}"))?;
            if parsed < 0 {
                return Err(anyhow::anyhow!("{name} must not be negative, got {parsed}"));
            }
            Ok(parsed)
        }
    }
}

/// Parses a positive `u64` interval (zero would panic in `tokio::time::interval`).
/// Missing uses `default`; an invalid value fails startup.
fn parse_positive_interval_secs(
    name: &str,
    raw: Option<&str>,
    default: u64,
) -> anyhow::Result<u64> {
    match raw {
        None => Ok(default),
        Some(v) => {
            let parsed: u64 = v
                .parse()
                .map_err(|_| anyhow::anyhow!("{name} must be a positive integer, got {v:?}"))?;
            if parsed == 0 {
                return Err(anyhow::anyhow!(
                    "{name} must be greater than zero (a zero-duration interval panics)"
                ));
            }
            Ok(parsed)
        }
    }
}

/// Parses a positive `u32`. Missing uses `default`; an invalid value fails startup.
fn parse_positive_u32(name: &str, raw: Option<&str>, default: u32) -> anyhow::Result<u32> {
    match raw {
        None => Ok(default),
        Some(v) => {
            let parsed: u32 = v
                .parse()
                .map_err(|_| anyhow::anyhow!("{name} must be a positive integer, got {v:?}"))?;
            if parsed == 0 {
                return Err(anyhow::anyhow!("{name} must be greater than zero"));
            }
            Ok(parsed)
        }
    }
}

/// Parses a positive `i64`. Missing uses `default`; an invalid value fails startup.
fn parse_positive_i64(name: &str, raw: Option<&str>, default: i64) -> anyhow::Result<i64> {
    match raw {
        None => Ok(default),
        Some(v) => {
            let parsed: i64 = v
                .parse()
                .map_err(|_| anyhow::anyhow!("{name} must be a positive integer, got {v:?}"))?;
            if parsed <= 0 {
                return Err(anyhow::anyhow!("{name} must be greater than zero"));
            }
            Ok(parsed)
        }
    }
}

/// Reads env var `name` and parses it with `parse`, which also gets the
/// name for its error messages.
fn env_parse<T>(
    name: &str,
    default: T,
    parse: fn(&str, Option<&str>, T) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    parse(name, env::var(name).ok().as_deref(), default)
}

/// A boolean env var: `true` or `1` is on; anything else, or unset, is off.
fn env_flag(name: &str) -> bool {
    env::var(name).is_ok_and(|v| v == "true" || v == "1")
}

/// Splits `CORS_ALLOWED_ORIGINS` on commas and checks each is a valid header
/// value. A bad origin fails startup instead of being silently dropped.
fn parse_cors_allowed_origins(raw: Option<&str>) -> anyhow::Result<Vec<String>> {
    let raw = raw.unwrap_or_default();
    let mut origins = Vec::new();
    for part in raw.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        if HeaderValue::from_str(trimmed).is_err() {
            return Err(anyhow::anyhow!(
                "CORS_ALLOWED_ORIGINS contains an invalid origin: {trimmed:?}"
            ));
        }
        origins.push(trimmed.to_string());
    }
    Ok(origins)
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url =
            env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
        let jwt_signing_key_str = env::var("JWT_SIGNING_KEY")
            .map_err(|_| anyhow::anyhow!("JWT_SIGNING_KEY is required (min 32 bytes)"))?;
        if jwt_signing_key_str.len() < 32 {
            return Err(anyhow::anyhow!(
                "JWT_SIGNING_KEY must be at least 32 characters"
            ));
        }

        let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());

        let access_token_ttl_secs = env_parse(
            "ACCESS_TOKEN_TTL_SECS",
            900, // 15 minutes
            parse_nonnegative_secs,
        )?;

        let refresh_token_ttl_secs = env_parse(
            "REFRESH_TOKEN_TTL_SECS",
            60 * 60 * 24 * 30, // 30 days
            parse_nonnegative_secs,
        )?;

        let web_session_ttl_secs = env_parse(
            "WEB_SESSION_TTL_SECS",
            60 * 60 * 24 * 14, // 14 days
            parse_nonnegative_secs,
        )?;

        let require_encryption = env_flag("REQUIRE_ENCRYPTION");

        let behind_proxy = env_flag("BEHIND_PROXY");

        let cors_allowed_origins =
            parse_cors_allowed_origins(env::var("CORS_ALLOWED_ORIGINS").ok().as_deref())?;

        let tombstone_retention_secs = env_parse(
            "TOMBSTONE_RETENTION_SECS",
            60 * 60 * 24 * 30, // 30 days
            parse_nonnegative_secs,
        )?;

        let compaction_interval_secs = env_parse(
            "COMPACTION_INTERVAL_SECS",
            60 * 60, // hourly
            parse_positive_interval_secs,
        )?;

        let inactive_device_compaction_grace_period_secs = env_parse(
            "INACTIVE_DEVICE_COMPACTION_GRACE_PERIOD_SECS",
            60 * 60 * 24 * 30, // 30 days
            parse_nonnegative_secs,
        )?;

        let never_synced_device_compaction_grace_period_secs = env_parse(
            "NEVER_SYNCED_DEVICE_COMPACTION_GRACE_PERIOD_SECS",
            60 * 60 * 24, // 24 hours
            parse_nonnegative_secs,
        )?;

        let housekeeping_interval_secs = env_parse(
            "HOUSEKEEPING_INTERVAL_SECS",
            60 * 60 * 24, // daily
            parse_positive_interval_secs,
        )?;

        let device_credential_retention_secs = env_parse(
            "DEVICE_CREDENTIAL_RETENTION_SECS",
            60 * 60 * 24 * 7, // 7 days past expiry
            parse_nonnegative_secs,
        )?;

        let audit_log_retention_secs = env_parse(
            "AUDIT_LOG_RETENTION_SECS",
            60 * 60 * 24 * 90, // 90 days
            parse_nonnegative_secs,
        )?;

        let ephemeral_tombstone_retention_secs = env_parse(
            "EPHEMERAL_TOMBSTONE_RETENTION_SECS",
            60 * 60 * 24 * 30, // 30 days
            parse_nonnegative_secs,
        )?;

        let database_max_connections =
            env_parse("DATABASE_MAX_CONNECTIONS", 50, parse_positive_u32)?;

        let websocket_ping_interval_secs = env_parse(
            "WEBSOCKET_PING_INTERVAL_SECS",
            30,
            parse_positive_interval_secs,
        )?;

        let max_devices_per_account = env_parse("MAX_DEVICES_PER_ACCOUNT", 25, parse_positive_i64)?;

        // Timeouts must also be positive; zero would fail everything at once.
        let request_timeout_secs =
            env_parse("REQUEST_TIMEOUT_SECS", 30, parse_positive_interval_secs)?;

        let websocket_send_timeout_secs = env_parse(
            "WEBSOCKET_SEND_TIMEOUT_SECS",
            10,
            parse_positive_interval_secs,
        )?;

        let upload_semaphore_acquire_timeout_secs = env_parse(
            "UPLOAD_SEMAPHORE_ACQUIRE_TIMEOUT_SECS",
            20,
            parse_positive_interval_secs,
        )?;

        let shutdown_deadline_secs =
            env_parse("SHUTDOWN_DEADLINE_SECS", 30, parse_positive_interval_secs)?;

        Ok(Self {
            database_url,
            bind_addr,
            jwt_signing_key: jwt_signing_key_str.into_bytes(),
            access_token_ttl_secs,
            refresh_token_ttl_secs,
            web_session_ttl_secs,
            require_encryption,
            behind_proxy,
            cors_allowed_origins,
            protocol_version: 1,
            minimum_supported_protocol_version: 1,
            api_version: "v1".to_string(),
            tombstone_retention_secs,
            compaction_interval_secs,
            inactive_device_compaction_grace_period_secs,
            never_synced_device_compaction_grace_period_secs,
            housekeeping_interval_secs,
            device_credential_retention_secs,
            audit_log_retention_secs,
            ephemeral_tombstone_retention_secs,
            database_max_connections,
            websocket_ping_interval_secs,
            max_devices_per_account,
            request_timeout_secs,
            websocket_send_timeout_secs,
            upload_semaphore_acquire_timeout_secs,
            shutdown_deadline_secs,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- interval validation (COMPACTION/HOUSEKEEPING/WEBSOCKET_PING) ---
    // Zero would panic inside a background task and silently kill it.

    #[test]
    fn positive_interval_rejects_zero() {
        let err =
            parse_positive_interval_secs("COMPACTION_INTERVAL_SECS", Some("0"), 3600).unwrap_err();
        assert!(err.to_string().contains("COMPACTION_INTERVAL_SECS"));
    }

    #[test]
    fn positive_interval_rejects_negative() {
        assert!(
            parse_positive_interval_secs("HOUSEKEEPING_INTERVAL_SECS", Some("-5"), 3600).is_err()
        );
    }

    #[test]
    fn positive_interval_rejects_unparseable() {
        let err =
            parse_positive_interval_secs("WEBSOCKET_PING_INTERVAL_SECS", Some("not-a-number"), 30)
                .unwrap_err();
        assert!(err.to_string().contains("WEBSOCKET_PING_INTERVAL_SECS"));
    }

    #[test]
    fn positive_interval_accepts_valid_value() {
        assert_eq!(
            parse_positive_interval_secs("COMPACTION_INTERVAL_SECS", Some("120"), 3600).unwrap(),
            120
        );
    }

    #[test]
    fn positive_interval_falls_back_to_default_when_absent() {
        assert_eq!(
            parse_positive_interval_secs("COMPACTION_INTERVAL_SECS", None, 3600).unwrap(),
            3600
        );
    }

    // --- TTL / retention validation (non-negative, present-but-invalid errors) ---

    #[test]
    fn nonnegative_secs_rejects_negative_ttl() {
        let err = parse_nonnegative_secs("TOMBSTONE_RETENTION_SECS", Some("-1"), 100).unwrap_err();
        assert!(err.to_string().contains("TOMBSTONE_RETENTION_SECS"));
    }

    #[test]
    fn nonnegative_secs_rejects_unparseable() {
        assert!(parse_nonnegative_secs("ACCESS_TOKEN_TTL_SECS", Some("abc"), 900).is_err());
    }

    #[test]
    fn nonnegative_secs_accepts_zero() {
        // Zero is a legitimate "don't retain at all" TTL, unlike an interval.
        assert_eq!(
            parse_nonnegative_secs("TOMBSTONE_RETENTION_SECS", Some("0"), 100).unwrap(),
            0
        );
    }

    #[test]
    fn nonnegative_secs_falls_back_to_default_when_absent() {
        assert_eq!(
            parse_nonnegative_secs("ACCESS_TOKEN_TTL_SECS", None, 900).unwrap(),
            900
        );
    }

    // --- positive u32 / i64 (pool size, device cap) ---

    #[test]
    fn positive_u32_rejects_zero_and_unparseable() {
        assert!(parse_positive_u32("DATABASE_MAX_CONNECTIONS", Some("0"), 50).is_err());
        assert!(parse_positive_u32("DATABASE_MAX_CONNECTIONS", Some("nope"), 50).is_err());
        assert_eq!(
            parse_positive_u32("DATABASE_MAX_CONNECTIONS", Some("10"), 50).unwrap(),
            10
        );
    }

    #[test]
    fn positive_i64_rejects_zero_negative_and_unparseable() {
        assert!(parse_positive_i64("MAX_DEVICES_PER_ACCOUNT", Some("0"), 25).is_err());
        assert!(parse_positive_i64("MAX_DEVICES_PER_ACCOUNT", Some("-3"), 25).is_err());
        assert!(parse_positive_i64("MAX_DEVICES_PER_ACCOUNT", Some("nope"), 25).is_err());
        assert_eq!(
            parse_positive_i64("MAX_DEVICES_PER_ACCOUNT", Some("5"), 25).unwrap(),
            5
        );
    }

    // --- CORS origin validation ---

    #[test]
    fn cors_origins_accepts_valid_list() {
        let origins =
            parse_cors_allowed_origins(Some("https://example.com, https://foo.bar")).unwrap();
        assert_eq!(origins, vec!["https://example.com", "https://foo.bar"]);
    }

    #[test]
    fn cors_origins_empty_when_absent() {
        assert!(parse_cors_allowed_origins(None).unwrap().is_empty());
    }

    #[test]
    fn cors_origins_rejects_invalid_header_value() {
        // A raw newline can't be turned into an HTTP header value.
        let err = parse_cors_allowed_origins(Some("https://good.example, bad\nvalue")).unwrap_err();
        assert!(err.to_string().contains("CORS_ALLOWED_ORIGINS"));
    }
}
