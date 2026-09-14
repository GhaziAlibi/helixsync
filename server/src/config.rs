use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    pub jwt_signing_key: Vec<u8>,
    pub access_token_ttl_secs: i64,
    pub refresh_token_ttl_secs: i64,
    pub web_session_ttl_secs: i64,
    pub require_encryption: bool,
    /// Whether the server is only ever reached through a trusted reverse
    /// proxy (e.g. the `web` nginx service in docker-compose.yml, which
    /// forwards `/api/` and sets `X-Real-IP`/`X-Forwarded-For`). When true,
    /// `middleware::client_ip` trusts those headers for per-client rate
    /// limiting instead of the raw TCP peer address, which in that topology
    /// is always the proxy's own container IP (see client_ip.rs for why
    /// that matters). Must stay `false` for direct/non-proxied deployments
    /// (local dev, tests, or any setup where the server is reachable
    /// without going through a trusted proxy first) — otherwise a client
    /// could spoof these headers to evade or collapse rate limits.
    pub behind_proxy: bool,
    pub cors_allowed_origins: Vec<String>,
    pub protocol_version: u32,
    pub minimum_supported_protocol_version: u32,
    pub api_version: String,
    /// docs/protocol.md §9/§11: a tombstone-creating operation's raw log
    /// row lingers this long past the point compaction would otherwise
    /// remove it, purely as an audit-trail safety margin — the tombstone's
    /// effect (`tombstones.active`) is independently durable and unaffected.
    pub tombstone_retention_secs: i64,
    /// How often the background compaction task (server/src/sync/compaction.rs)
    /// runs, per docs/protocol.md §11.
    pub compaction_interval_secs: u64,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url = env::var("DATABASE_URL")
            .map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
        let jwt_signing_key_str = env::var("JWT_SIGNING_KEY")
            .map_err(|_| anyhow::anyhow!("JWT_SIGNING_KEY is required (min 32 bytes)"))?;
        if jwt_signing_key_str.len() < 32 {
            return Err(anyhow::anyhow!("JWT_SIGNING_KEY must be at least 32 characters"));
        }

        let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());

        let access_token_ttl_secs = env::var("ACCESS_TOKEN_TTL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(900); // 15 minutes

        let refresh_token_ttl_secs = env::var("REFRESH_TOKEN_TTL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60 * 60 * 24 * 30); // 30 days

        let web_session_ttl_secs = env::var("WEB_SESSION_TTL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60 * 60 * 24 * 14); // 14 days

        let require_encryption = env::var("REQUIRE_ENCRYPTION")
            .ok()
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        let behind_proxy = env::var("BEHIND_PROXY")
            .ok()
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        let cors_allowed_origins = env::var("CORS_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let tombstone_retention_secs = env::var("TOMBSTONE_RETENTION_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60 * 60 * 24 * 30); // 30 days

        let compaction_interval_secs = env::var("COMPACTION_INTERVAL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60 * 60); // hourly

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
        })
    }
}
