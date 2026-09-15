# HelixSync Server Performance & Throttling Review

This document contains a comprehensive performance, concurrency, and throttling audit of the HelixSync server (`server/`). It covers bottleneck analysis across HTTP routes, database interactions, background workers, rate limiting, and containerization/reverse-proxy configurations.

---

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [Findings Summary & Severity Matrix](#findings-summary--severity-matrix)
3. [Critical Issues](#critical-issues)
   - [PERF-01: Global Throttling in Production Deployments Due to Missing `BEHIND_PROXY`](#perf-01-global-throttling-in-production-deployments-due-to-missing-behind_proxy)
   - [PERF-02: RateLimiter DoS / Cascading Rejections Under Partition Saturation](#perf-02-ratelimiter-dos--cascading-rejections-under-partition-saturation)
4. [High Severity Issues](#high-severity-issues)
   - [PERF-03: Heavy Gzip Compression/Decompression & JSON Parsing on Tokio Worker Threads](#perf-03-heavy-gzip-compressiondecompression--json-parsing-on-tokio-worker-threads)
   - [PERF-04: Aggressive 3-Second Pool Acquire Timeout & Connection Hoarding](#perf-04-aggressive-3-second-pool-acquire-timeout--connection-hoarding)
   - [PERF-05: Massive Memory Allocation Churn During Batch Upload Validation](#perf-05-massive-memory-allocation-churn-during-batch-upload-validation)
5. [Medium Severity Issues](#medium-severity-issues)
   - [PERF-06: Housekeeping Task Query Inefficiencies & Unthrottled Loops](#perf-06-housekeeping-task-query-inefficiencies--unthrottled-loops)
   - [PERF-07: Uncached Web Sessions & Extractor Overhead on `/sync/stats`](#perf-07-uncached-web-sessions--extractor-overhead-on-syncstats)
   - [PERF-08: Redundant Decompress-Recompress Cycle in Snapshot Endpoint](#perf-08-redundant-decompress-recompress-cycle-in-snapshot-endpoint)
   - [PERF-09: Missing Reverse Proxy Timeouts & Buffer Limits in Nginx](#perf-09-missing-reverse-proxy-timeouts--buffer-limits-in-nginx)
6. [Low Severity / Concurrency Observations](#low-severity--concurrency-observations)
   - [PERF-10: DashMap Shard Write-Lock Contention During Sweeper Passes](#perf-10-dashmap-shard-write-lock-contention-during-sweeper-passes)
   - [PERF-11: Database Row Lock Serialization Across Multi-Device Uploads for Same User](#perf-11-database-row-lock-serialization-across-multi-device-uploads-for-same-user)
7. [Remediation Plan & Recommendations](#remediation-plan--recommendations)

---

## Executive Summary

The HelixSync server demonstrates thoughtful architectural design in many areas: bulk operations via PostgreSQL unnesting, transactional advisory locks, and token-bucket rate limiting. However, our deep-dive analysis revealed several critical throttling hazards, runtime-blocking operations, and connection pool starvation vectors that will significantly degrade performance or cause denial-of-service in production:

1. **Production Deployment Throttle**: `docker-compose.prod.yml` omits `BEHIND_PROXY="true"`, causing all clients across the internet to be identified as Nginx's internal container IP (`172.x.x.x`), collapsing all users into shared rate-limit buckets (10 logins/min and 300 WebSocket handshakes/min globally).
2. **Rate Limiter DoS & Cascading Rejection**: When `untrusted_windows` reaches its 25,000 entry cap (easily triggered via unauthenticated token refreshes), the 1-second emergency sweep cooldown causes 100% of all new legitimate client requests to be rejected with HTTP 429 (`Retry-After: 60`).
3. **Async Runtime Starvation**: Gzip decompression (up to 256MB) and 30–50MB JSON deserialization/serialization are executed synchronously on Tokio worker threads without `spawn_blocking`, stalling request handling across the server.
4. **Database Pool Starvation**: An aggressive 3-second connection checkout timeout coupled with long-lived transactions in `/snapshot` and pinned connections in `prune_compacted_operations` risks cascading request failures under moderate concurrent load.

---

## Findings Summary & Severity Matrix

| ID | Finding Title | Component | Impact | Severity |
|---|---|---|---|---|
| **PERF-01** | Missing `BEHIND_PROXY` in production compose | `docker-compose.prod.yml`, `client_ip.rs` | Global client throttling to single IP limits | **Critical** |
| **PERF-02** | RateLimiter DoS via emergency sweep cooldown | `middleware/rate_limit.rs` | Rejects all new incoming connections/users | **Critical** |
| **PERF-03** | Heavy CPU compression/parsing on Tokio worker threads | `sync/routes.rs`, `sync/compaction.rs` | Stalls Tokio event loop, spikes event latencies | **High** |
| **PERF-04** | 3s acquire timeout & connection hoarding during compaction | `database/mod.rs`, `sync/compaction.rs` | DB pool starvation, rapid 500 error cascades | **High** |
| **PERF-05** | Memory churn from `serde_json::to_vec` payload validation | `sync/routes.rs:302` | Up to 125MB allocation churn per batch | **High** |
| **PERF-06** | Housekeeping missing `ORDER BY`, extra queries, no yield | `housekeeping.rs` | Sequential scans, connection spikes, WAL load | **Medium** |
| **PERF-07** | Uncached web session DB lookups on stats cache hit | `auth/extractors.rs`, `sync/routes.rs` | Redundant DB query on every dashboard poll | **Medium** |
| **PERF-08** | Redundant decompress-then-recompress cycle in `/snapshot` | `sync/routes.rs`, `lib.rs` | Excessive CPU and latency on snapshot reads | **Medium** |
| **PERF-09** | Missing Nginx proxy timeouts for WS and large batches | `web/nginx.conf` | 504 Gateway Timeout, dropped WebSockets | **Medium** |
| **PERF-10** | DashMap shard write-lock contention during sweeps | `middleware/rate_limit.rs` | Micro-stalls across all rate-limited routes | **Low** |
| **PERF-11** | User-level row serialization on `sync_cursors` / `sync_stats` | `sync/routes.rs` | Serialized uploads for multi-device accounts | **Low** |

---

## Critical Issues

### PERF-01: Global Throttling in Production Deployments Due to Missing `BEHIND_PROXY`

- **Affected Files**:
  - [`docker-compose.prod.yml:43-54`](file:///home/ghazia/Works/personal/HelixSync/docker-compose.prod.yml#L43-L54)
  - [`server/src/config.rs:100-103`](file:///home/ghazia/Works/personal/HelixSync/server/src/config.rs#L100-L103)
  - [`server/src/middleware/client_ip.rs:33-61`](file:///home/ghazia/Works/personal/HelixSync/server/src/middleware/client_ip.rs#L33-L61)

#### Root Cause
In [`docker-compose.yml:36`](file:///home/ghazia/Works/personal/HelixSync/docker-compose.yml#L36), `server.environment` sets `BEHIND_PROXY: "true"`. However, in [`docker-compose.prod.yml`](file:///home/ghazia/Works/personal/HelixSync/docker-compose.prod.yml#L43-L54) (the recommended production/Portainer deployment configuration), `BEHIND_PROXY` is missing.

In [`server/src/config.rs:100-103`](file:///home/ghazia/Works/personal/HelixSync/server/src/config.rs#L100-L103), `behind_proxy` defaults to `false`:
```rust
let behind_proxy = env::var("BEHIND_PROXY")
    .ok()
    .map(|v| v == "true" || v == "1")
    .unwrap_or(false);
```
When `behind_proxy` is `false`, [`client_ip()`](file:///home/ghazia/Works/personal/HelixSync/server/src/middleware/client_ip.rs#L34-L36) strictly returns `addr.ip()`, ignoring `X-Real-IP` and `X-Forwarded-For`:
```rust
pub fn client_ip(headers: &HeaderMap, addr: SocketAddr, behind_proxy: bool) -> IpAddr {
    if !behind_proxy {
        return addr.ip();
    }
    // ...
```
Because the `server` container has no exposed ports and is only reached via Nginx (`web`), every incoming connection seen by Axum has the Docker bridge IP of the Nginx container (e.g. `172.18.0.3`).

#### Impact & Throttle
All clients across the internet share the exact same rate-limiting bucket for IP-keyed endpoints:
- **`LOGIN_LIMIT` (10 per 60s)**: Only 10 login attempts per minute are permitted across the entire user base.
- **`REGISTER_LIMIT` (5 per 60s)**: Only 5 user registrations per minute globally.
- **`DEVICE_REGISTER_LIMIT` (10 per 60s)**: Only 10 browser extension pairings per minute globally.
- **`WEBSOCKET_HANDSHAKE_LIMIT` (300 per 60s)**: Only 300 WebSocket upgrade handshakes per minute across all users. If 301 devices reconnect across the deployment in a minute, devices start receiving HTTP 429.
- **`TOKEN_REFRESH_IP_LIMIT` (300 per 60s)**: Max 300 token refreshes per minute across all devices.

#### Recommended Remediation
Add `BEHIND_PROXY: "true"` to [`docker-compose.prod.yml`](file:///home/ghazia/Works/personal/HelixSync/docker-compose.prod.yml#L47):
```yaml
      REQUIRE_ENCRYPTION: ${REQUIRE_ENCRYPTION:-true}
      BEHIND_PROXY: "true"
      CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS}
```

---

### PERF-02: RateLimiter DoS / Cascading Rejections Under Partition Saturation

- **Affected Files**:
  - [`server/src/middleware/rate_limit.rs:60-61`](file:///home/ghazia/Works/personal/HelixSync/server/src/middleware/rate_limit.rs#L60-L61)
  - [`server/src/middleware/rate_limit.rs:78-79`](file:///home/ghazia/Works/personal/HelixSync/server/src/middleware/rate_limit.rs#L78-L79)
  - [`server/src/middleware/rate_limit.rs:164-173`](file:///home/ghazia/Works/personal/HelixSync/server/src/middleware/rate_limit.rs#L164-L173)
  - [`server/src/devices/routes.rs:204-206`](file:///home/ghazia/Works/personal/HelixSync/server/src/devices/routes.rs#L204-L206)

#### Root Cause
[`RateLimiter`](file:///home/ghazia/Works/personal/HelixSync/server/src/middleware/rate_limit.rs#L32) bounds `untrusted_windows` to `MAX_UNTRUSTED_ENTRIES = 25_000`. In [`check_with_retry_after`](file:///home/ghazia/Works/personal/HelixSync/server/src/middleware/rate_limit.rs#L164-L173):
```rust
if !windows.contains_key(&map_key) && windows.len() >= capacity {
    self.maybe_emergency_sweep(partition);
    if windows.len() >= capacity {
        return Err(window);
    }
}
```
In [`maybe_emergency_sweep`](file:///home/ghazia/Works/personal/HelixSync/server/src/middleware/rate_limit.rs#L97-L114), emergency sweeps are throttled to run at most once per second (`EMERGENCY_SWEEP_COOLDOWN = 1s`):
```rust
if now_nanos.saturating_sub(last) < cooldown_nanos {
    return;
}
```
If the map is saturated (25,000 entries), any subsequent request for a *new* key checks `maybe_emergency_sweep`. During the 1-second cooldown, `maybe_emergency_sweep` returns immediately without sweeping. Consequently, `windows.len() >= capacity` remains true, and the function returns `Err(window)`.

Furthermore, in [`server/src/devices/routes.rs:204-206`](file:///home/ghazia/Works/personal/HelixSync/server/src/devices/routes.rs#L204-L206):
```rust
let hash = hash_token(&req.refresh_token);
enforce(&state.rate_limiter, TOKEN_REFRESH_LIMIT, &hash)?;
```
`TOKEN_REFRESH_LIMIT` is in `RateLimitPartition::Untrusted`. Anyone can submit arbitrary strings to `/credentials/refresh`. Generating 25,000 random refresh tokens fills `untrusted_windows` with 25,000 entries within seconds.

#### Impact & Throttle
- Once saturated, **100% of requests with new keys on ALL untrusted endpoints are rejected during the cooldown period**, even if their buckets would otherwise have full quota.
- Legitimate users attempting to log in, register, pair a new device, or perform a WebSocket handshake from a new IP receive HTTP 429 (`Retry-After: 60s`).
- An attacker can exploit this single endpoint to lock out all new incoming traffic on the server.

#### Recommended Remediation
1. Key `TOKEN_REFRESH_LIMIT` primarily by IP or an authenticated identity rather than arbitrary unverified token hashes in the untrusted partition.
2. Instead of rejecting brand-new keys outright when capacity is reached, implement LRU eviction or replace the oldest expired bucket directly, or allow a small burst buffer.

---

## High Severity Issues

### PERF-03: Heavy Gzip Compression/Decompression & JSON Parsing on Tokio Worker Threads

- **Affected Files**:
  - [`server/src/sync/routes.rs:1021-1028`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L1021-L1028)
  - [`server/src/sync/routes.rs:1051-1081`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L1051-L1081)
  - [`server/src/sync/routes.rs:1178`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L1178)
  - [`server/src/sync/compaction.rs:250`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/compaction.rs#L250)

#### Root Cause
While [`server/src/crypto/mod.rs`](file:///home/ghazia/Works/personal/HelixSync/server/src/crypto/mod.rs#L36-L51) correctly offloads Argon2id password hashing to `tokio::task::spawn_blocking`, snapshot compression and decompression are executed synchronously on async worker threads:
- [`decompress_snapshot_data`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L1051): Uses `flate2::read::GzDecoder` to inflate up to 256MB of gzip data into a `Vec<u8>`, followed by `serde_json::from_slice(&json)` across 50,000+ objects.
- [`compress_snapshot_data`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L1021): Uses `serde_json::to_vec` on the entire object list, followed by `flate2::write::GzEncoder` at `Compression::default()`.

#### Impact & Throttle
- For accounts with large histories (30–50MB uncompressed JSON), decompression and JSON parsing take 50ms–300ms of solid CPU time.
- Compaction (`compact_user`) runs with concurrency 3, and client endpoints (`/snapshot`, `/stats`) invoke these routines.
- Running CPU-bound gzip and JSON parsing on Tokio worker threads blocks the Tokio reactor from polling network sockets, processing heartbeats, or servicing other incoming HTTP requests, creating latency spikes across all endpoints.

#### Recommended Remediation
Wrap CPU-intensive compression and decompression inside `tokio::task::spawn_blocking`:
```rust
pub(super) async fn decompress_snapshot_data_async(bytes: Vec<u8>) -> AppResult<Vec<SnapshotObject>> {
    tokio::task::spawn_blocking(move || decompress_snapshot_data(&bytes))
        .await
        .map_err(|e| anyhow::anyhow!("decompression panicked: {e}"))?
}
```

---

### PERF-04: Aggressive 3-Second Pool Acquire Timeout & Connection Hoarding

- **Affected Files**:
  - [`server/src/database/mod.rs:12`](file:///home/ghazia/Works/personal/HelixSync/server/src/database/mod.rs#L12)
  - [`server/src/sync/routes.rs:1310-1324`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L1310-L1324)
  - [`server/src/sync/compaction.rs:482-553`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/compaction.rs#L482-L553)

#### Root Cause
1. In [`server/src/database/mod.rs:12`](file:///home/ghazia/Works/personal/HelixSync/server/src/database/mod.rs#L12):
   ```rust
   const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(3);
   ```
   If connection checkout waits more than 3 seconds, sqlx raises `PoolTimedOut`, returning HTTP 500.
2. In [`server/src/sync/routes.rs:1310-1324`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L1310-L1324) (`snapshot` handler):
   A transaction `tx = state.db.begin().await?` is opened at line 1310. It holds a checked-out connection throughout `compute_objects`:
   - Fetching base snapshot row
   - In-memory gzip decompression
   - In-memory JSON parsing of 50,000 objects
   - Querying `MAX(server_cursor)`
   - Streaming `sync_operations`
   - In-memory grouping and sorting
   - Querying active tombstones
   Because PostgreSQL default isolation is `READ COMMITTED`, holding a single transaction across separate SELECT statements provides no snapshot isolation across queries anyway, but pins a pooled connection during all in-memory processing.
3. In [`server/src/sync/compaction.rs:482-553`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/compaction.rs#L482-L553) (`prune_compacted_operations`):
   ```rust
   let mut conn = state.db.acquire().await?;
   // ...
   loop {
       let mut tx = Acquire::begin(&mut conn).await?;
       // execute chunk DELETE ...
       tx.commit().await?;
       // ...
       tokio::time::sleep(PRUNE_COOPERATIVE_DELAY).await;
   }
   ```
   `conn` remains checked out across the entire pruning loop, including while sleeping `PRUNE_COOPERATIVE_DELAY` (10ms) between chunks. With `COMPACTION_CONCURRENCY = 3`, 3 connections are held continuously during the entire sweep.

#### Impact & Throttle
Under burst traffic (e.g. several devices requesting full snapshot resync or syncing large batches while background compaction is active), the connection pool quickly starves. With `ACQUIRE_TIMEOUT = 3s`, normal client requests fail abruptly with 500 errors instead of absorbing brief queueing.

#### Recommended Remediation
1. Increase `ACQUIRE_TIMEOUT` to 10–15 seconds to tolerate transient background bursts.
2. In `snapshot`, do not hold an open transaction across the entire in-memory folding lifecycle; execute the read queries individually or explicitly use `REPEATABLE READ` only for the query fetches without holding the connection during decompression.
3. In `compaction.rs`, acquire and release connections per chunk rather than holding a pinned connection across `tokio::time::sleep`.

---

### PERF-05: Massive Memory Allocation Churn During Batch Upload Validation

- **Affected Files**:
  - [`server/src/sync/routes.rs:302-306`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L302-L306)

#### Root Cause
In [`server/src/sync/routes.rs:302`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L302):
```rust
let payload_size = serde_json::to_vec(&op.payload).map(|v| v.len()).unwrap_or(0);
if payload_size > MAX_PAYLOAD_BYTES {
    decisions.push(Decision::Rejected("payload_too_large"));
    continue;
}
```
`op.payload` is a `serde_json::Value`. To check if its serialized size exceeds `MAX_PAYLOAD_BYTES` (256KB), `serde_json::to_vec` allocates a full `Vec<u8>` on the heap for every operation in the batch.

#### Impact & Throttle
A single batch can contain up to 500 operations (`MAX_OPERATIONS_PER_BATCH = 500`). For large payloads:
- Up to 500 individual heap allocations per request.
- Up to **125MB of transient memory allocated and discarded per batch**.
- Multiplies GC / heap fragmentation overhead and stalls worker threads under concurrent upload batches.

#### Recommended Remediation
Use a zero-allocation counting writer:
```rust
struct ByteCounter(usize);
impl std::io::Write for ByteCounter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

let mut counter = ByteCounter(0);
let _ = serde_json::to_writer(&mut counter, &op.payload);
if counter.0 > MAX_PAYLOAD_BYTES {
    decisions.push(Decision::Rejected("payload_too_large"));
    continue;
}
```

---

## Medium Severity Issues

### PERF-06: Housekeeping Task Query Inefficiencies & Unthrottled Loops

- **Affected Files**:
  - [`server/src/housekeeping.rs:63-131`](file:///home/ghazia/Works/personal/HelixSync/server/src/housekeeping.rs#L63-L131)

#### Root Cause
1. **Missing `ORDER BY`**:
   The queries in `delete_expired_device_credentials`, `delete_expired_web_sessions`, and `delete_old_audit_logs` use:
   ```sql
   DELETE FROM audit_logs WHERE id IN (
       SELECT id FROM audit_logs WHERE created_at < $1 LIMIT $2
   )
   ```
   Without an `ORDER BY created_at ASC`, PostgreSQL's query optimizer may opt for a primary key index scan on `id` and filter rows in heap memory to fulfill `LIMIT $2`, instead of using `idx_audit_logs_created_at`.
2. **Wasted Extra Query**:
   The loop checks `if result.rows_affected() == 0 { break; }`. If a table has 150 expired rows, iteration 1 deletes 150 rows. Because 150 != 0, it executes iteration 2 with `LIMIT 5000`, which scans the index and returns 0 rows. It should break if `result.rows_affected() < DELETE_CHUNK_SIZE as u64`.
3. **No Cooperative Yielding or Row Cap**:
   Unlike `sync::compaction`, which implements `PRUNE_COOPERATIVE_DELAY` (10ms) and `MAX_PRUNED_PER_PASS` (50,000 rows), housekeeping loops indefinitely without yielding to the Tokio runtime or capping total deletions per pass.

#### Impact & Throttle
If an active deployment accumulates a backlog of audit logs or expired sessions, the daily housekeeping pass executes dozens of back-to-back unindexed or unthrottled DELETE statements, spiking disk I/O, generating excessive WAL, and starving concurrent HTTP requests.

#### Recommended Remediation
1. Add `ORDER BY <timestamp_col> ASC` to the inner `LIMIT` queries.
2. Break early if `result.rows_affected() < DELETE_CHUNK_SIZE as u64`.
3. Introduce a cooperative `tokio::time::sleep(Duration::from_millis(10))` and cap deletions per pass (e.g. `MAX_HOUSEKEEPING_PRUNED_PER_PASS = 50_000`).

---

### PERF-07: Uncached Web Sessions & Extractor Overhead on `/sync/stats`

- **Affected Files**:
  - [`server/src/auth/extractors.rs:39-53`](file:///home/ghazia/Works/personal/HelixSync/server/src/auth/extractors.rs#L39-L53)
  - [`server/src/sync/routes.rs:1386-1394`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L1386-L1394)

#### Root Cause
- [`AuthenticatedDevice`](file:///home/ghazia/Works/personal/HelixSync/server/src/auth/extractors.rs#L121) caches revocation checks in `state.device_revocation_cache` with a 30s TTL.
- [`AuthenticatedUser`](file:///home/ghazia/Works/personal/HelixSync/server/src/auth/extractors.rs#L39-L53), used for web session authentication, has no in-memory cache. Every dashboard request runs:
  ```sql
  SELECT u.id, u.email FROM web_sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.session_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
  ```
- In [`sync::routes::stats`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L1386):
  `user: AnyAuthenticatedUser` is extracted *before* checking `STATS_CACHE`. Even if the 30-second `STATS_CACHE` hits, the request has already checked out a database connection and executed the session join query against PostgreSQL.

#### Impact & Throttle
Unnecessary connection checkout and query overhead for every poll of the dashboard.

#### Recommended Remediation
Add a short in-memory cache (e.g. 15–30s TTL) for validated `session_hash -> (user_id, email)` tuples in `AppState`, mirroring `device_revocation_cache`.

---

### PERF-08: Redundant Decompress-Recompress Cycle in Snapshot Endpoint

- **Affected Files**:
  - [`server/src/lib.rs:59`](file:///home/ghazia/Works/personal/HelixSync/server/src/lib.rs#L59)
  - [`server/src/sync/routes.rs:1176-1187`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L1176-L1187)
  - [`server/src/sync/routes.rs:1341-1345`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L1341-L1345)

#### Root Cause
1. Snapshots are stored in `sync_snapshots.data` as gzip-compressed `BYTEA`.
2. When a device calls `GET /api/v1/sync/snapshot`:
   - `compute_objects` decompresses the stored snapshot into a `HashMap<(String, Uuid), SnapshotObject>`.
   - If no new operations have been written since the snapshot was taken, the objects are unchanged.
   - Axum re-serializes all 50,000 objects into a 30–50MB JSON string.
   - Tower-http's `CompressionLayer::new()` compresses the JSON string back into gzip.
3. If Nginx is in front, Nginx is also configured with `gzip on`.

#### Impact & Throttle
Significant CPU burn and latency on full snapshot downloads, decompressing and re-compressing identical data on the async worker thread.

#### Recommended Remediation
If no new operations exist since the latest snapshot (`max_op_cursor <= base_cursor`) and no tombstones need active filtering, return the pre-compressed byte payload directly with `Content-Encoding: gzip`, bypassing both deserialization and re-compression.

---

### PERF-09: Missing Reverse Proxy Timeouts & Buffer Limits in Nginx

- **Affected Files**:
  - [`web/nginx.conf:23-40`](file:///home/ghazia/Works/personal/HelixSync/web/nginx.conf#L23-L40)

#### Root Cause
In [`web/nginx.conf`](file:///home/ghazia/Works/personal/HelixSync/web/nginx.conf#L30-L40):
```nginx
location /api/ {
    proxy_pass http://server:8080/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
}
```
No `proxy_read_timeout` or `proxy_send_timeout` is configured. Nginx defaults to 60 seconds.

#### Impact & Throttle
1. **WebSocket Termination**: While the server sends pings every 30 seconds, any network pause, sleep/wake, or browser suspension approaching 60 seconds causes Nginx to drop the WebSocket connection with a timeout.
2. **Large Upload 504 Timeouts**: With `client_max_body_size 150m;`, uploading a large batch over slower uplinks or processing it in Postgres can exceed 60 seconds, resulting in `504 Gateway Timeout`.
3. **Disk Spooling**: Nginx response buffering (`proxy_buffering on`) spools 30–50MB snapshot responses to disk temp files (`proxy_temp_path`), adding unnecessary disk I/O.

#### Recommended Remediation
In `web/nginx.conf`:
- Set `proxy_read_timeout 3600s;` and `proxy_send_timeout 3600s;` for WebSocket endpoints or `/api/`.
- Adjust `proxy_buffers` and consider `proxy_buffering off;` or tuning buffer sizes for large snapshot streaming.

---

## Low Severity / Concurrency Observations

### PERF-10: DashMap Shard Write-Lock Contention During Sweeper Passes

- **Affected Files**:
  - [`server/src/middleware/rate_limit.rs:207-220`](file:///home/ghazia/Works/personal/HelixSync/server/src/middleware/rate_limit.rs#L207-L220)
  - [`server/src/middleware/rate_limit.rs:231-243`](file:///home/ghazia/Works/personal/HelixSync/server/src/middleware/rate_limit.rs#L231-L243)

#### Observation
Every 5 minutes, `spawn_sweeper` executes:
```rust
windows.retain(|_, bucket| now.duration_since(bucket.last_refill) < bucket.window);
```
On `DashMap`, `retain()` iterates through all internal shards, locking each shard exclusively with a write lock. Any incoming HTTP request attempting to access or check an entry in that shard blocks until the shard scan completes. With thousands of keys, this can cause brief micro-stalls on incoming requests every 5 minutes.

---

### PERF-11: Database Row Lock Serialization Across Multi-Device Uploads for Same User

- **Affected Files**:
  - [`server/src/sync/routes.rs:350-362`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L350-L362)
  - [`server/src/sync/routes.rs:567-582`](file:///home/ghazia/Works/personal/HelixSync/server/src/sync/routes.rs#L567-L582)

#### Observation
When an upload batch is processed, the server executes:
```sql
INSERT INTO sync_cursors (user_id, device_id, cursor_value)
VALUES ($1, NULL, $2)
ON CONFLICT (user_id, device_id)
DO UPDATE SET cursor_value = sync_cursors.cursor_value + $2, updated_at = now()
RETURNING cursor_value
```
and:
```sql
INSERT INTO sync_stats (user_id, bookmark_count, history_visit_count, tab_count) ...
ON CONFLICT (user_id) DO UPDATE ...
```
PostgreSQL holds row-level exclusive locks on `(user_id, NULL)` in `sync_cursors` and `(user_id)` in `sync_stats` until `tx.commit()`. While different users run concurrently, concurrent uploads from **two different devices of the same user** are strictly serialized at the database transaction level.

---

## Remediation Plan & Recommendations

1. **Immediate Configuration Fix**:
   - Add `BEHIND_PROXY: "true"` to [`docker-compose.prod.yml`](file:///home/ghazia/Works/personal/HelixSync/docker-compose.prod.yml).
   - In `web/nginx.conf`, set `proxy_read_timeout 3600s;` and `proxy_send_timeout 3600s;`.

2. **Rate Limiter Hardening**:
   - Do not key `TOKEN_REFRESH_LIMIT` on raw unauthenticated hashes in `untrusted_windows`.
   - Remove the hard rejection under capacity cooldown; implement LRU eviction for expired entries when `untrusted_windows` reaches capacity.

3. **Tokio Async Safety**:
   - Move `compress_snapshot_data` and `decompress_snapshot_data` into `tokio::task::spawn_blocking`.
   - Replace `serde_json::to_vec` in `process_batch` with a zero-allocation `ByteCounter`.

4. **Database Pool Resilience**:
   - Increase `ACQUIRE_TIMEOUT` in `database/mod.rs` from 3s to 10s–15s.
   - Release connection checkouts in `compaction.rs` between chunk deletes rather than holding the connection across `tokio::time::sleep`.
   - Add `ORDER BY <timestamp> ASC` and `rows_affected < DELETE_CHUNK_SIZE` exit conditions in `housekeeping.rs`.
