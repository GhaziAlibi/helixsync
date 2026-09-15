# HelixSync Performance & Throttling Audit Report

This report documents performance bottlenecks, rate-limiting and throttling defects, and concurrency issues identified in the HelixSync browser extension and sync server as of commit `4f952e7`.

---

## Executive Summary

| ID | Component | Category | Severity | Description |
|---|---|---|---|---|
| **SRV-01** | Server Rate Limiting | Throttling / Security | **High** | Partition mismatch in `refresh_credentials`: `TOKEN_REFRESH_LIMIT` (`Untrusted`) used instead of `TOKEN_REFRESH_AUTHENTICATED_LIMIT` (`Authenticated`) for verified device ID |
| **SRV-02** | Server Database / Sync | Performance | **Medium** | Unnecessary transaction (`BEGIN` / `COMMIT`) and connection checkout on `/api/v1/sync/stats` fast path |
| **SRV-03** | Server Compaction | Reliability / Performance | **Medium** | PostgreSQL temporary table `compaction_survivor_ids` lacks `IF NOT EXISTS` / `TRUNCATE`, risking pool connection reuse failure |
| **EXT-01** | Extension API Client | Throttling / Error Handling | **High** | `refreshAccessToken` throws `ReauthRequiredError` on HTTP 429, bypassing rate-limit cooldown and retry timer in `sync/engine.ts` |
| **EXT-02** | Extension Storage | Performance / Storage | **Medium** | `getPendingTabRestores()` performs full-scan of tab tombstones via `by-type` index instead of filtering `by-type-deleted` |
| **EXT-03** | Extension Bookmarks | Performance / IPC | **Medium** | Sibling IPC and IndexedDB transaction amplification in `flushBookmarkEvents` during bookmark creation/move bursts |
| **EXT-04** | Extension Storage | Performance / Event Loop | **Low** | Unbounded cursor scan in `gcFieldStates()` without event-loop yielding over large `field_state` tables |
| **EXT-05** | Extension Tabs | Performance / Network Churn | **Low** | Progressive title mutations during page loads trigger multiple redundant sync operations and WebSocket pushes |

---

## Server Findings

### SRV-01: RateLimiter Partition Mismatch on Credential Refresh Device Check
- **Files**:
  - [`server/src/devices/routes.rs`](server/src/devices/routes.rs#L224)
  - [`server/src/middleware/rate_limit.rs`](server/src/middleware/rate_limit.rs#L278-L283)
- **Category**: Throttling / Isolation Defect
- **Severity**: High

#### Root Cause
In commit `4f952e7`, `RateLimiter` was partitioned into `untrusted_windows` and `authenticated_windows` (capped at 25,000 entries each) to prevent unauthenticated IP/token floods from evicting or blocking authenticated device requests. A dedicated rate limit config was declared in `rate_limit.rs`:
```rust
pub const TOKEN_REFRESH_AUTHENTICATED_LIMIT: RateLimitConfig = RateLimitConfig {
    bucket: "token_refresh",
    limit: 30,
    window: Duration::from_secs(60),
    partition: RateLimitPartition::Authenticated,
};
```
However, in `server/src/devices/routes.rs`, line 224:
```rust
enforce(&state.rate_limiter, TOKEN_REFRESH_LIMIT, &cred.device_id.to_string())?;
```
The handler passes `TOKEN_REFRESH_LIMIT` (which has `partition: RateLimitPartition::Untrusted`) instead of `TOKEN_REFRESH_AUTHENTICATED_LIMIT`.

#### Impact
1. The authenticated device ID is recorded into `untrusted_windows` rather than `authenticated_windows`.
2. Both the presented refresh token hash (line 203) and the verified device ID (line 224) share the `"token_refresh"` bucket inside `untrusted_windows`.
3. If an attacker floods `/api/v1/devices/credentials/refresh` with random tokens to saturate `MAX_UNTRUSTED_ENTRIES` (25,000 entries), any legitimate device attempting to refresh its credentials will have its device ID rejected at line 224 because `untrusted_windows` is at capacity.
4. `TOKEN_REFRESH_AUTHENTICATED_LIMIT` remains dead code, defeating the partition boundary intended by `SRV-01`.

#### Remediation
In `server/src/devices/routes.rs`:
1. Import `TOKEN_REFRESH_AUTHENTICATED_LIMIT`.
2. Change line 224 to:
```rust
enforce(&state.rate_limiter, TOKEN_REFRESH_AUTHENTICATED_LIMIT, &cred.device_id.to_string())?;
```

---

### SRV-02: Unnecessary Transaction & Connection Pool Overhead on `/api/v1/sync/stats` Fast Path
- **File**: [`server/src/sync/routes.rs`](server/src/sync/routes.rs#L1397-L1414)
- **Category**: Database Performance / Connection Contention
- **Severity**: Medium

#### Root Cause
On a cache miss in `STATS_CACHE`, `stats` immediately opens a transaction:
```rust
let mut tx = state.db.begin().await?;

let row = sqlx::query!(
    "SELECT bookmark_count, history_visit_count, tab_count FROM sync_stats WHERE user_id = $1",
    user.user_id
)
.fetch_optional(&mut *tx)
.await?;

let stats = match row {
    Some(r) => {
        tx.commit().await?;
        SyncStats { ... }
    }
    None => { ... }
};
```
For established accounts, `sync_stats` already exists (maintained incrementally on upload and reconciled during compaction). Opening a transaction requires 3 round trips to PostgreSQL (`BEGIN`, `SELECT`, and `COMMIT`) and checks out an exclusive connection from the pool.

#### Impact
Under concurrent dashboard usage or frequent polling, checking out pooled connections for multi-roundtrip read-only transactions increases pool contention. With `ACQUIRE_TIMEOUT = 3s`, this exacerbates connection acquisition pressure during background compaction or bulk uploads.

#### Remediation
Query `sync_stats` directly against `&state.db` (single statement / single round-trip without transaction setup). Only start `state.db.begin().await?` if `row.is_none()` (the rare lazy-backfill path):
```rust
let row = sqlx::query!(
    "SELECT bookmark_count, history_visit_count, tab_count FROM sync_stats WHERE user_id = $1",
    user.user_id
)
.fetch_optional(&state.db)
.await?;

let stats = match row {
    Some(r) => SyncStats {
        bookmarks: r.bookmark_count as i64,
        history_visits: r.history_visit_count as i64,
        tabs: r.tab_count as i64,
    },
    None => {
        let mut tx = state.db.begin().await?;
        ...
    }
};
```

---

### SRV-03: Temporary Table Collision & Leaked State in `compaction.rs`
- **File**: [`server/src/sync/compaction.rs`](server/src/sync/compaction.rs#L463-L525)
- **Category**: Reliability / Connection Pool Contention
- **Severity**: Medium

#### Root Cause
`prune_compacted_operations` acquires a pooled connection:
```rust
let mut conn = state.db.acquire().await?;

sqlx::query("CREATE TEMPORARY TABLE compaction_survivor_ids (id BIGINT PRIMARY KEY) ON COMMIT PRESERVE ROWS")
    .execute(&mut *conn)
    .await?;
```
At the end of the function, it attempts cleanup:
```rust
let _ = sqlx::query("DROP TABLE IF EXISTS compaction_survivor_ids")
    .execute(&mut *conn)
    .await;
```
If a database error, cancellation, or worker panic occurs before line 520, the connection is returned to the `PgPool` with the session-scoped temporary table still existing. On a subsequent compaction pass that acquires the same pooled connection, `CREATE TEMPORARY TABLE compaction_survivor_ids` fails with `relation "compaction_survivor_ids" already exists` because `IF NOT EXISTS` is omitted. Furthermore, if `compaction_survivor_ids` already contains rows from a prior failed pass, omitting `TRUNCATE` results in stale IDs surviving into the anti-join.

#### Impact
Future compaction passes for users scheduled on recycled connections will fail with database errors, stalling operation log compaction for affected accounts.

#### Remediation
Use `CREATE TEMPORARY TABLE IF NOT EXISTS compaction_survivor_ids (id BIGINT PRIMARY KEY) ON COMMIT PRESERVE ROWS; TRUNCATE compaction_survivor_ids;` to ensure idempotency across connection checkout lifecycles.

---

## Extension Findings

### EXT-01: `refreshAccessToken` Throws `ReauthRequiredError` on HTTP 429, Bypassing Rate-Limit Cooldown
- **Files**:
  - [`extension/src/api/client.ts`](extension/src/api/client.ts#L78-L87)
  - [`extension/src/sync/engine.ts`](extension/src/sync/engine.ts#L890-L896)
- **Category**: Rate Limiting / Error Handling Defect
- **Severity**: High

#### Root Cause
In `extension/src/api/client.ts`:
```ts
const res = await fetch(`${serverUrl}/api/v1/devices/credentials/refresh`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ refreshToken: device.refreshToken }),
});

if (!res.ok) {
  throw new ReauthRequiredError(`refresh failed with status ${res.status}`);
}
```
When the server returns HTTP 429 Too Many Requests (e.g. hitting `TOKEN_REFRESH_IP_LIMIT` or `TOKEN_REFRESH_LIMIT`), `refreshAccessToken` treats any non-ok response as `ReauthRequiredError`.

In `extension/src/sync/engine.ts`:
```ts
} catch (err) {
  console.error("HelixSync: sync cycle failed", err);
  if (err instanceof ApiError && err.status === 429) {
    const cooldownSeconds = err.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS;
    void setSyncBlockedUntil(Date.now() + cooldownSeconds * 1000);
    scheduleCooldownRetry();
  }
  emitStatus("error", err instanceof Error ? err.message : String(err));
  ...
}
```
Because `ReauthRequiredError` is not an instance of `ApiError`:
1. `err instanceof ApiError && err.status === 429` evaluates to `false`.
2. `setSyncBlockedUntil` and `scheduleCooldownRetry()` are never invoked.
3. The server-directed `Retry-After` header is lost.
4. A transient rate limit on token refresh is erroneously treated as an unrecoverable credential expiration (`ReauthRequiredError`), potentially prompting the user to re-authenticate when the device simply needed to back off.

#### Remediation
In `refreshAccessToken`:
Check `if (res.status === 429)` and throw `await buildApiError(res, "token refresh rate limited")`. Only throw `ReauthRequiredError` for authentication rejections (HTTP 401, 403, 404):
```ts
if (res.status === 429) {
  throw await buildApiError(res, "rate limited during token refresh");
}
if (!res.ok) {
  throw new ReauthRequiredError(`refresh failed with status ${res.status}`);
}
```

---

### EXT-02: `getPendingTabRestores()` Full-Scan of Tab Tombstones in IndexedDB
- **File**: [`extension/src/storage/db.ts`](extension/src/storage/db.ts#L893-L901)
- **Category**: IndexedDB Performance / Memory Overhead
- **Severity**: Medium

#### Root Cause
`getPendingTabRestores()` is executed every time the popup opens when the tab restore policy is `"ask"`:
```ts
export async function getPendingTabRestores(): Promise<PendingTabRestore[]> {
  const db = await getDb();
  const [records, tabMappings] = await Promise.all([
    getRemoteObjectsByType("tab"),
    db.getAllFromIndex("object_mappings", "by-type", "tab"),
  ]);
  const materializedObjectIds = new Set(tabMappings.map((m) => m.objectId));
  return selectPendingTabRestores(records, materializedObjectIds);
}
```
`getRemoteObjectsByType("tab")` performs:
```ts
(await getDb()).getAllFromIndex("remote_objects", "by-type", "tab");
```
While `countPendingTabRestores()` was optimized in commit `4f952e7` (EXT-03) to use the compound index `by-type-deleted` with `IDBKeyRange.only(["tab", false])`, `getPendingTabRestores()` still queries the `"by-type"` index.

#### Impact
Closed tabs in `remote_objects` retain tombstone rows (`deleted: true`, up to `REMOTE_OBJECT_CAPS.tab = 500`). `getPendingTabRestores()` pulls every closed tab tombstone into memory and deserializes its JSON payload, only to discard them in `selectPendingTabRestores`. This adds unnecessary latency and GC pressure on every popup open.

#### Remediation
In `extension/src/storage/db.ts`, update `getPendingTabRestores` to read directly from `"by-type-deleted"`:
```ts
export async function getPendingTabRestores(): Promise<PendingTabRestore[]> {
  const db = await getDb();
  const [records, tabMappings] = await Promise.all([
    db.getAllFromIndex("remote_objects", "by-type-deleted", IDBKeyRange.only(["tab", false])),
    db.getAllFromIndex("object_mappings", "by-type", "tab"),
  ]);
  const materializedObjectIds = new Set(tabMappings.map((m) => m.objectId));
  return selectPendingTabRestores(records, materializedObjectIds);
}
```

---

### EXT-03: Sibling IPC and IndexedDB Amplification During Bookmark Burst Flushes
- **File**: [`extension/src/bookmarks/index.ts`](extension/src/bookmarks/index.ts#L95-L102, #L168-L170, #L265-L267, #L289-L317)
- **Category**: Chromium IPC & Storage Performance
- **Severity**: Medium

#### Root Cause
When bulk bookmark operations occur (e.g. dragging a folder with 50-100 children or importing bookmarks), Chrome fires individual `onCreated` / `onMoved` events. These are enqueued into `createMicroBatchQueue` and flushed after 150ms in `flushBookmarkEvents`.

Inside `flushBookmarkEvents`, the loop sequentially executes `stageCreated` and `stageMoved`:
```ts
const position = await computePosition(moveInfo.parentId, moveInfo.index);
```
`computePosition` executes:
```ts
async function computePosition(parentChromiumId: string, index: number): Promise<string> {
  const siblings = await chrome.bookmarks.getChildren(parentChromiumId);
  const beforeId = siblings[index - 1]?.id;
  const afterId = siblings[index + 1]?.id;
  const lo = beforeId ? ((await positionOf(await objectIdFor(beforeId))) ?? null) : null;
  const hi = afterId ? ((await positionOf(await objectIdFor(afterId))) ?? null) : null;
  return keyBetween(lo, hi);
}
```
For 100 items moving into or created within the same folder:
1. `chrome.bookmarks.getChildren(parentChromiumId)` is invoked 100 times, querying the browser process across IPC on every iteration for the same parent.
2. `positionOf` opens an individual IndexedDB transaction to read `"move"` from `field_state`.
3. `objectIdFor` opens an individual IndexedDB transaction to lookup or create mappings.

#### Impact
What was intended as an amortized batch pays $O(N)$ Chromium IPC roundtrips and hundreds of separate IndexedDB transactions inside `flushBookmarkEvents`, stalling the service worker thread during bulk bookmark modifications.

#### Remediation
Cache `chrome.bookmarks.getChildren(parentId)` and prefetch sibling mapping and field-state positions within the scope of a single `flushBookmarkEvents` invocation.

---

### EXT-04: Unbounded Cursor Walk in `gcFieldStates` Without Event-Loop Yielding
- **File**: [`extension/src/storage/db.ts`](extension/src/storage/db.ts#L1054-L1075)
- **Category**: Event Loop Starvation
- **Severity**: Low

#### Root Cause
`gcFieldStates()` runs daily to purge stale LWW field records for deleted objects.
During its scan phase:
```ts
let scanCursor = await db.transaction("field_state").store.openCursor();
let scanChunk: FieldStateRecord[] = [];
while (scanCursor) {
  scanChunk.push(scanCursor.value);
  if (scanChunk.length >= MAINTENANCE_DELETE_CHUNK) {
    for (const id of selectFieldStateGcCandidates(scanChunk, cutoffMs)) objectIds.add(id);
    scanChunk = [];
  }
  scanCursor = await scanCursor.continue();
}
```
`field_state` has no index on `field` or `recordedAt`, only `by-object-id`. For an active user with 10,000 bookmarks, `field_state` contains 40,000+ records. The loop traverses every row via `openCursor()` in a single transaction without calling `yieldToEventLoop()`.

#### Impact
The service worker main thread remains engaged in cursor iteration across tens of thousands of IndexedDB records. While it is chunked into 500-item arrays for candidate evaluation, the underlying cursor progression never yields macrotasks, potentially delaying popup messages or chrome event dispatches.

#### Remediation
Introduce `await yieldToEventLoop()` between cursor chunks in `gcFieldStates()`, consistent with `CRYPTO_YIELD_CHUNK` and `DEFERRED_RETRY_YIELD_CHUNK`.

---

### EXT-05: Tab Update Churn During Page Load Flutters Upload Queue
- **File**: [`extension/src/tabs/index.ts`](extension/src/tabs/index.ts#L433-L444, #L207-L220, #L390-L392)
- **Category**: Network / Crypto Churn
- **Severity**: Low

#### Root Cause
`chrome.tabs.onUpdated` captures `title` updates. During normal web page loading, modern web apps update document titles progressively (e.g. initial URL load $\to$ generic app name $\to$ resolved page title $\to$ badge count update).
Because `createMicroBatchQueue` flushes every 150ms and `scheduleLocalSync` debounces at 250ms, multiple intermediate titles generate distinct `update` operations within 1-2 seconds. Each operation is encrypted with pure-TS XChaCha20-Poly1305, committed to IndexedDB, uploaded to the server, and pushed to peer devices via WebSocket notifications.

#### Impact
Unnecessary CPU, database, and network bandwidth churn for transient, intermediate tab states that are overwritten seconds later.

#### Remediation
In `chrome.tabs.onUpdated`, if `tab.status === "loading"` and only `title` changed (not `url`), postpone emitting the tab update event until `tab.status === "complete"`, or apply a per-tab debounce on title changes.
