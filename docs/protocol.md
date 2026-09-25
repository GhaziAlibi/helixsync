# HelixSync Synchronization Protocol

Version: `protocolVersion: 1`, `minimumSupportedProtocolVersion: 1`, `apiVersion: v1`

This document is the single source of truth for synchronization behavior. The
server and every client (extension, and any future client) MUST implement the
rules in this document identically. Neither implementation may invent
conflict or ordering behavior independently. If server code and this document
disagree, this document wins and the code is a bug.

---

## 1. Identity

### 1.1 Object identity

Chromium-assigned IDs (`bookmark.id`, `tabs.Tab.id`, `windows.Window.id`,
`tabGroups.TabGroup.id`) are local to a single browser profile and process
lifetime. They:

- are never sent to the server as object identity
- are never used as `objectId`
- may change across browser restarts (tabs/windows) or profile operations

Every synchronized object is assigned a HelixSync `objectId`: a UUIDv7
(time-ordered UUID) generated locally by the device that first creates the
object. UUIDv7 is used (not v4) so that IDs are naturally sortable for
debugging and storage locality, but no code may rely on UUID ordering for
conflict resolution — only the fields in §3 may be used for that.

The extension persists a durable mapping:

```text
object_mappings: chromiumLocalId <-> objectId (per objectType)
```

This mapping is local-only and never uploaded. It is rebuilt/repaired from
the Chromium API state plus applied operations on startup if inconsistent
(see §9).

### 1.2 Device identity

A device is identified by a server-issued `deviceId` (UUID), created during
device registration (§7). The device's cryptographic key material (§ see
`docs/encryption.md`) is bound to this `deviceId`.

### 1.3 Object types

```text
bookmark
bookmarkFolder
historyVisit
tab
window
tabGroup
extensionMeta
extensionStorageEntry
```

---

## 2. Operation Log Model

HelixSync synchronizes via an append-only operation log, never by uploading
or replacing a browser profile.

```text
browser event -> HelixSync operation -> local queue -> server operation log -> other devices -> apply operation
```

Operations are immutable once accepted by the server (§5). Corrections are
represented as new operations (e.g. `update` then `delete` then `restore` are
three distinct operations, never edits to history).

---

## 3. Operation Schema

```json
{
  "operationId": "0198f20a-2d7b-7b43-b9cc-2d7f6a2e5e10",
  "deviceId": "0198f1d1-5e12-7a11-9d0a-2f2d1f6a7c20",
  "deviceSequence": 1842,
  "lamportTimestamp": 5031,
  "objectType": "bookmark",
  "objectId": "0198f1f2-7b9c-7d2d-ae45-2a7b2b4c8d10",
  "operationType": "update",
  "encryptionVersion": 1,
  "payload": {},
  "createdAt": "2026-09-13T00:00:00Z"
}
```

| Field                | Type          | Notes                                                              |
|----------------------|---------------|---------------------------------------------------------------------|
| `operationId`        | UUID          | Globally unique. Client-generated. Idempotency key (§6).            |
| `deviceId`            | UUID          | Set by server from the authenticated device credential, not trusted from the client body. |
| `deviceSequence`      | u64           | Per-device monotonic, never reused (§4.1).                          |
| `lamportTimestamp`    | u64           | Device logical clock at creation time (§4.2).                       |
| `objectType`          | enum string   | See §1.3.                                                            |
| `objectId`            | UUID          | Stable HelixSync object identity (§1.1).                             |
| `operationType`       | enum string   | Per-object-type, see §8.                                             |
| `encryptionVersion`   | u32           | `0` = plaintext (testing only), `>=1` = encrypted envelope. See `docs/encryption.md`. |
| `payload`             | object        | Opaque to the server when `encryptionVersion >= 1`.                  |
| `createdAt`           | RFC3339 UTC   | Wall-clock, diagnostics only. Never used for ordering or conflict resolution. |

Server-added, read-only-to-client field:

| Field           | Type | Notes                                             |
|-----------------|------|----------------------------------------------------|
| `serverCursor`  | i64  | Assigned at durable acceptance. See §5.             |

`deviceSequence` and `lamportTimestamp` are independent fields with different
purposes and MUST NOT be collapsed into one value:

- `deviceSequence` orders a single device's own operations and detects gaps/replays.
- `lamportTimestamp` orders causality across devices for conflict resolution (§8).

---

## 4. Sequence and Cursor Semantics

### 4.1 Device sequence

Each device owns an independent counter starting at 1, incrementing by
exactly 1 per operation it creates, persisted before the operation is
considered creatable. A sequence number is never reused, including after a
failed upload — the operation keeps its reserved `deviceSequence` and is
retried with the same value.

The server enforces `UNIQUE(device_id, device_sequence)`. Gaps are legal
(an operation that never gets created after reserving a sequence, e.g. a
crash between reservation and persistence, simply leaves a permanent gap);
duplicates of the same `(device_id, device_sequence)` with a different
`operationId` are rejected (§5).

### 4.2 Lamport timestamp

Each device maintains a Lamport clock:

```text
on local event:      clock = clock + 1; use clock
on receiving remote:  clock = max(clock, remoteLamportTimestamp) + 1
```

The clock is persisted locally and restored on startup.

### 4.3 Server cursor

The server assigns a strictly increasing, per-user, gap-free cursor
(`server_cursor`, `UNIQUE(user_id, server_cursor)`) at the moment an
operation is durably stored. The cursor is a storage/delivery ordering
mechanism only.

**The server cursor is never used as proof of causality.** Two operations
with adjacent cursors may be causally unrelated. Causality is only expressed
through `lamportTimestamp` + `deviceId` + `operationId` (§8.1).

### 4.4 Client cursor semantics

`cursor` in the download API (§10) means "the client has successfully
applied every operation up to and including this server cursor." The client
persists the new cursor only after successfully applying the batch (see
`docs/protocol.md` §9 and the extension state machine). On failure, the
client retries from the last successfully-persisted cursor — never advances
optimistically.

---

## 5. Idempotency and Immutability

- `operationId` is the idempotency key. Uploading the same `operationId`
  twice (retry after a dropped response, duplicate network delivery, etc.)
  MUST produce exactly one stored operation and exactly one logical effect.
- The server's upload handler is a transactional upsert-by-`operationId`
  read: if `operationId` already exists, return the original acceptance
  result (`serverCursor`, `status: "duplicate"`) without re-validating
  sequence/business rules or performing any state mutation.
- `sync_operations` is append-only. No `UPDATE` on payload/type/object fields
  is permitted after insert. Corrections are new operations (§2).
- This `operationId`-against-`sync_operations` check alone is only as
  durable as `sync_operations` itself, which compaction prunes once an
  operation is folded into a snapshot. For most object types that's fine —
  a pruned operation's *object* still has a permanent `sync_objects` ledger
  row (§8), so a later non-origination op on it still passes the ownership
  check even though the original operation's own idempotency row is gone,
  and a resent *origination* simply re-derives the same well-known ID and
  is rejected/accepted the same way any duplicate create is. `historyVisit`
  `bulkImport` needed its own explicit exception to this (§8.3.1): a bulk
  chunk's `objectId` is additionally checked against `sync_objects`
  directly (which `bulkImport`, uniquely among origination-only op types,
  is given a permanent ledger row in specifically so this lookup has
  something to find), so a retry after compaction — even one that reserves
  a fresh `deviceSequence` — still reads as `duplicate` rather than
  double-counting `sync_stats.history_visit_count`.

---

## 6. Object-Type Operation Vocabulary

### bookmark / bookmarkFolder

```text
create, update, move, delete, restore
```

### historyVisit

```text
visit
bulkImport
```

(History is event-oriented, not mutable — see §8.3. `bulkImport` is the
single-operation history import: one op carrying N visits, see §8.3.)

### tab

```text
create, update, close, activate, move
```

### window

```text
create, update, close
```

### tabGroup

```text
create, update, delete
```

### extensionMeta

```text
observe (records installed/enabled/disabled/version as seen locally)
```

### extensionStorageEntry

```text
set, delete
```

Unknown/future operation types MUST be rejected by strict schema validators
but MUST NOT crash processing of a batch — see §13 (Protocol Compatibility).
An unsupported-but-recognized-as-future operation type is stored (so it is
not lost for newer clients) but is not applied locally by a client that does
not understand it, and that object enters a `compatibility_pending` local
state rather than being silently dropped (never silently discard).

---

## 7. Authentication and Device Registration Flow

```text
1. Account already exists (created via the web dashboard's
   email+password registration).
2. Extension performs device registration directly with the account
   credentials in a single call: POST /api/v1/devices/register
   { email, password, name, browser?, browserVersion?, platform?,
     extensionVersion? }
3. Server verifies the password, creates a `devices` row, issues device
   credentials, and returns:
   { deviceId, accessToken (short-lived JWT), refreshToken (opaque,
     rotating), encryptionSalt }
4. Extension derives the encryption root key locally from
   (password, encryptionSalt) via Argon2id — see docs/encryption.md §2 —
   and stores it alongside the credentials in IndexedDB (never uploaded,
   never in payload logs).
```

There is no separate device key-upload step and no per-device authorization
by another device: `encryptionSalt` is the same for every device on the
account, so any device that successfully authenticates derives the same
encryption key independently (docs/encryption.md §2-3).

All subsequent sync/API/WebSocket calls from the extension use
`Authorization: Bearer <deviceAccessToken>`, never the web session cookie.

---

## 8. Conflict Resolution

### 8.1 Universal ordering

Every operation has a logical version key used only to pick a deterministic
winner when two operations conflict on the same field of the same object:

```text
(lamportTimestamp, deviceId, operationId)
```

Compared lexicographically in that order. Higher wins. `deviceId` and
`operationId` are pure tie-breakers with no semantic meaning; they exist only
to force a total order when Lamport timestamps tie. Wall-clock `createdAt` is
never consulted.

### 8.2 Bookmarks / bookmark folders

Fields: `title`, `url`, `parent` (objectId of parent folder), `position`
(fractional-index string, see below).

- Different fields changed concurrently on the same object: merge — take
  each field's own most-recent (by §8.1) value independently.
- Same field changed concurrently: the §8.1 winner's value applies.
- Concurrent `move` (parent/position change): treated as a single compound
  field for §8.1 purposes (both `parent` and `position` change together);
  the winning move's `(parent, position)` pair applies atomically so a
  bookmark never ends up with a parent from one operation and a position
  from another.
- `delete` vs `update`: if the delete's `lamportTimestamp` is strictly
  greater than the update's, delete wins unconditionally (causally-aware
  delete). If concurrent (delete does not causally follow the update by
  Lamport time), apply §8.1 ordering between the delete and the update as
  a whole — if delete wins, the object becomes a tombstone; if update wins,
  the update applies and the delete is retained as a pending tombstone
  candidate that a client may re-issue as an explicit `restore` if a human
  decides so (never silently dropped, per invariant §8.6).
- `delete` vs `move`: delete always wins.
- `restore` is a new, explicit operation type that recreates a live object
  from a retained tombstone, with a fresh `payload` snapshot. It does not
  erase the tombstone's history; it is layered on top the same way any
  other operation is.
- Position uses fractional indexing (string keys, e.g. `"a0"`, `"a1"`,
  midpoint-generated as `"a0V"`) so concurrent inserts at the same location
  never require renumbering siblings.

### 8.3 History

History visits are immutable events, not mutable objects.

- `objectId` for a `historyVisit` is derived deterministically as
  `UUIDv5(namespace=HISTORY, url + visitedAt + deviceId)` so that identical
  visit events created independently (e.g. re-derived after a local rebuild)
  produce the same `objectId` and are naturally deduplicated by the
  idempotency rule in §5 and by `UNIQUE(object_id)` tombstone/materialized
  views.
- Concurrent visits from different devices are never "conflicting" — both
  are retained; history is a set/log, not a single mutable record.
- A visit event is never overwritten by another visit event.
- Retention/compaction (aggregating old visit events, §11) is a storage
  optimization and explicitly not a conflict; it must never remove events
  inside the user's configured retention window.

#### 8.3.1 Chunked history import (`bulkImport`)

First login sends old history as one or more `bulkImport` ops — one per
chunk, uploaded as it's ready rather than one unbounded op for the whole
import, which risked OOMing the MV3 service worker on a real multi-million-
visit profile. Live per-visit capture (`onVisited`) stays unchanged; steady
state is cheap.

- Enumeration is scoped to a **fixed window `[cutoffMs, endMs)`**, both
  ends chosen once per import and persisted (not recomputed on retry):
  `endMs` exists specifically so a visit made *during* the import (already
  covered by live capture, which registers before the import runs) is never
  also swept up by the bulk enumeration and uploaded twice.
- `operationId = UUIDv5(namespace=HISTORY_BULK, deviceId + "bulkImport" +
  cutoffMs + chunkIndex)`; `objectId` is derived deterministically from the
  same seed. A fresh random ID would ship a duplicate chunk on relogin or a
  mid-import retry that dedup never catches; deterministic derivation makes
  a retry re-mint the same ID per chunk → server duplicate, zero new bytes.
  `chunkIndex` distinguishes the (potentially many) chunks one import splits
  into. Cutoff sensitivity is intentional: a genuinely different scope is a
  genuinely different import.
- Resume after a service-worker kill is **skip-by-count**, not
  page-granularity: enumeration over a fixed window with a correct paging
  cursor is deterministic (the same visit stream, in the same order, on
  every run), so a resumed run re-enumerates from the very start of the
  window and simply skips the visits already covered by chunks a prior run
  durably uploaded, rather than needing to remember *where* in the page
  sequence it left off. The device record tracks only two numbers for
  this — chunks durably accepted-or-duplicated, and how many visits (in
  stream order) those chunks cover — updated only after a chunk's upload has
  actually returned, never before.
- Permanent dedup: `historyVisit` is origination-only (no non-origination
  op ever depends on its `sync_objects` row the way bookmark/tab's
  update/delete do), so the server ordinarily never writes one for it — but
  `bulkImport` is the one exception, specifically so retrying an
  already-accepted chunk after `sync::compaction` has pruned its
  `sync_operations` row still reads as `duplicate` instead of landing as a
  new accepted row (see §5's idempotency note).
- Stored op payload: `{ v: 1, bulkVersion, codec?, visitCount:
  <plaintext int>, segments: [<envelope>, …] }` — N standard
  `docs/encryption.md` §6 envelopes inside one op, same SDEK, same
  `xchacha20poly1305`, no new cryptography. Two `bulkVersion`s coexist on
  the wire (`docs/encryption.md` §6.1); v1 data is never rewritten to v2:
  - `bulkVersion: 1` — per-segment plaintext `{ v: 1, visits: [{url, title,
    visitedAt}, …] }`.
  - `bulkVersion: 2` — per-segment plaintext grouped by URL, `{ v: 2,
    groups: [{u, t, v: [epochMs, …]}, …] }`, optionally deflate-raw
    compressed before encryption (`codec: "deflate-raw"`, feature-detected
    client-side; absent means uncompressed) — see `docs/encryption.md` §6.1
    and §6.2 for the format and the compression security trade-off.
  ~10k visits per segment either way. The server stores the payload
  opaquely and can never split, count, or retention-filter inside it; it
  only reads the plaintext `visitCount`.
- Segmentation helps the uploader only (bounds producer memory by
  encrypting/streaming one segment at a time instead of holding per-visit
  hashes/ciphertexts for the whole import). Segments aren't globally
  sorted, so a peer must decrypt every segment to find the newest K visits
  — segmentation does not give peers a cheap skip.
- No object type in this protocol ever replays a remote visit into a
  device's real browser history — `chrome.history.addUrl` stamps "visited
  now" with no title (a hard platform limit: there is no way to set a
  historical timestamp or title), and doing so anyway caused observed
  runaway duplicate growth (an async `onVisited` echo of the replayed visit,
  arriving after any synchronous suppression window closed, recaptured as a
  brand-new local operation and ping-ponged between devices forever). Both
  single-visit and bulk peers instead record `remote_objects` only (popup's
  "Synced history from other devices" reads from there).
- Peers expand newest-K only (`REMOTE_OBJECT_CAPS` keeps 2000
  `historyVisit` rows per device): expanding 1M rows then pruning is pure
  write amplification. Peer row IDs are deterministic `(bulkObjectId,
  index)` so re-apply is idempotent.
- Idempotency is per-`operationId`, ordering per `deviceSequence` (§4.1,
  §5): one bulk op consumes one sequence number and retries atomically.
- Client-side visit-time scoping at collect remains the enforcement (the
  server sees one `created_at = now` for the whole op). The ~100MB row
  rides snapshots within the existing 256MB inflate ceiling — one-time per
  new device. A bulk op counts as 1 op against `/changes` page limits but
  carries ~100MB in one response — one-time per peer.

#### 8.3.2 Hourly visit-count buckets (`visitHours`)

`created_at`-based retention (§8.3.1's "the server sees one `created_at =
now`") means a one-time bulk import counts in full for the whole retention
window measured from *upload* time, then drops out all at once — never
matching the browser's own rolling window measured from *visit* time. Since
payloads are end-to-end encrypted, the server has no way to see real visit
times unless the client sends them separately — so it does, in plaintext,
as counts only (never URLs or titles):

- Upload operations may carry an optional `visitHours` field: a JSON object
  mapping an hour-aligned UTC RFC3339 timestamp string to a positive integer
  count, e.g. `{"2026-09-23T09:00:00.000Z": 12}`. Only `historyVisit` ops
  may carry it; every key must be aligned to the hour (minute/second/
  nanosecond zero) and no more than a day in the future; every value must be
  `>= 1`; at most 100,000 entries per op.
- A `visit` op's `visitHours` must have exactly one entry with value 1 (a
  live visit is always exactly one visit in exactly one hour). A
  `bulkImport` chunk's entries must sum to exactly its `visitCount`.
  Violating either is rejected (`visit_hours_mismatch` /
  `invalid_visit_hours` / `unexpected_visit_hours`), never silently
  truncated or ignored.
- The server aggregates accepted ops' buckets into a dedicated
  `history_visit_hours` table (`user_id, hour, visits`), independent of
  `sync_operations`/compaction's retention-by-upload-time pruning — a bucket
  survives its originating operation being compacted away. `/stats` sums
  buckets at or after the account's retention cutoff, so the displayed count
  follows real visit time, not upload time. Bucket precision is one hour: a
  visit right at the edge of the retention window may count for up to an
  hour longer or shorter than the exact cutoff — an accepted trade-off, not
  a bug.
- Ops uploaded by clients built before this field existed carry no
  `visitHours` at all; the server falls back to bucketing the whole op
  (`visitCount` or 1) at its upload hour, same as the pre-existing
  `created_at`-based behavior for that one row.
- A URL whose *only* visits are hidden redirect hops is not enumerable
  through `chrome.history`'s extension API at all (a Chromium platform
  limit, not a bug in this protocol) and so can never contribute to either
  the bulk import or these buckets.

### 8.4 Tabs and windows

Tabs and windows are **device-scoped session objects**: each open tab/window
"belongs" to the device that created it, and its `objectId` travels with it
so other devices can *display* it (read-only, "tabs from other devices")
without ever treating a remote tab as authoritative over local session
state.

- A tab created independently on two devices produces two distinct
  `objectId`s — never merged into one.
- Field-level concurrent updates to the same synchronized tab (e.g. `title`,
  `url`, `pinned`, `index`, `active`) use §8.1 per field, same as bookmarks.
- `close` creates a tombstone for that tab's `objectId`.
- `close` vs `update` concurrently: close always wins.
- A remote tab/window operation is never applied by locally calling
  `chrome.tabs.*` mutators against the receiving device's real browser
  session unless the user has explicitly enabled "Restore remote tabs" —
  otherwise it is purely materialized in local sync state for display in
  the "tabs from other devices" UI. This is
  the mechanism that guarantees a remote tab can never destroy an unrelated
  local tab/window.
- Windows follow the same device-scoped model; window identity is stable
  only within the sync model (i.e. across restarts of the *same* device's
  browser, via the local `object_mappings` table), not as a claim about
  OS-level window identity.
- Empty windows (all tabs closed/tombstoned) may be garbage-collected
  locally and a `close` operation emitted for the window itself.

### 8.5 Tab groups

Follow the mutable-object rules of §8.2 (fields: `title`, `color`,
`collapsed`), with membership reconciled via each tab's `groupId` field
(itself subject to §8.1 per-tab). Concurrent `delete` of a group wins over
concurrent `update`. If the browser does not expose `chrome.tabGroups`, the
feature is disabled entirely via feature detection (§14) — no partial
emulation.

### 8.6 Extension metadata / storage

- Extension installation/uninstallation is never triggered remotely.
- `enabled`/`disabled` state changed concurrently: §8.1 winner applies.
- `version` is informational only; a client never downgrades a locally
  installed extension based on synced version metadata.
- An extension recorded as present on one device but absent on another is
  simply recorded as `unavailable` on the device that lacks it — never
  auto-installed.
- Extension storage keys merge independently (each key is its own
  conflict domain); same-key concurrent writes use §8.1; deletion is a
  tombstone per key.
- Storage sync for a given extension is opt-in (allowlist), defaulting to
  excluded for known-sensitive categories (password managers,
  authentication/security tools, payment extensions).

### 8.7 Conflict invariant

No synchronization operation may silently destroy unrelated user data. If
automatic reconciliation cannot safely determine the intended result, both
candidate states are retained (as tombstone + live object, or as a recorded
`conflicts` entry) and surfaced to the user rather than one being discarded
silently.

---

## 9. Tombstones

Deletion of any synchronized object produces a tombstone rather than an
immediate disappearance from the log:

```json
{ "objectId": "bookmark-uuid", "objectType": "bookmark", "deleted": true }
```

Lifecycle:

```text
object exists -> delete operation -> tombstone created
  -> all required active devices acknowledge past the tombstone's cursor
  -> retention period elapses
  -> tombstone eligible for compaction
```

A device that reconnects after being offline longer than the retained
operation/tombstone history is no longer eligible for incremental
synchronization and must perform full snapshot reconciliation (§11).
Revoked devices are excluded from the "required active devices" set and
never block compaction indefinitely.

---

## 10. Sync HTTP API

### 10.1 Download (cursor-based)

```http
GET /api/v1/sync/changes?cursor=1841&limit=500
Authorization: Bearer <deviceAccessToken>
```

```json
{
  "operations": [ /* Operation[] with serverCursor set */ ],
  "nextCursor": 1847,
  "hasMore": false
}
```

- Returns operations strictly after `cursor`, for the authenticated user,
  ordered by `server_cursor` ascending, up to `limit` (server-enforced max).
- `nextCursor` is the highest `server_cursor` included in this response (or
  the input `cursor` unchanged if the response is empty).
- If `cursor` is older than the retained history's floor, the server
  responds `409 Conflict` with `{ "error": "cursor_too_old", "snapshotUrl": "/api/v1/sync/snapshot" }`
  instead of `200`, signaling the client must fall back to snapshot resync
  (§11).
- If `cursor` is higher than the account's real allocator ceiling (the
  highest `server_cursor` ever issued for this user — this can happen after
  the account's history is restored from an older backup while a device
  still holds a newer pre-restore cursor), the server responds `409
  Conflict` with `{ "error": "cursor_invalid", "snapshotUrl":
  "/api/v1/sync/snapshot" }` instead of silently returning an empty page,
  signaling the client must fall back to snapshot resync (§11).

### 10.2 Upload

```http
POST /api/v1/sync/operations
Authorization: Bearer <deviceAccessToken>
Content-Type: application/json

{ "operations": [ { "operationId": "...", "deviceSequence": 1842, "lamportTimestamp": 5031,
  "objectType": "bookmark", "objectId": "...", "operationType": "update",
  "encryptionVersion": 1, "payload": {} } ] }
```

```json
{
  "accepted": ["operation-uuid-1"],
  "duplicate": ["operation-uuid-2"],
  "rejected": [ { "operationId": "operation-uuid-3", "reason": "sequence_out_of_order" } ],
  "serverCursor": 1850
}
```

Per-operation outcomes are always reported (never all-or-nothing for the
batch, except that authentication/schema-level failures reject the whole
request with 4xx before per-operation processing). Validation performed by
the server, in order, per operation:

1. Authentication (device credential valid, not revoked/expired).
2. Device ownership (`deviceId` from the operation body, if present, must
   equal the authenticated device's ID or is ignored entirely and
   overwritten from the credential — client-provided `deviceId` is never
   trusted).
3. Idempotency check by `operationId` (§5). Immediately after this step,
   and before step 4, a `historyVisit`/`bulkImport` op is additionally
   checked against `sync_objects` by `objectId` (§5, §8.3.1) — this is what
   catches a retry of an already-accepted chunk even after both its
   `sync_operations` row is pruned and it reserves a brand new
   `deviceSequence`, which step 4 alone could not.
4. `deviceSequence` validity: must be `> ` last accepted sequence for this
   device (gaps allowed; backward/duplicate is reported `duplicate`, or
   rejected `sequence_out_of_order`, per below).
   **Operations within a single batch must already be sorted ascending by
   `deviceSequence`** — the server validates the batch in array order and
   never reorders it. An op whose `deviceSequence` was already durably
   accepted in a *prior* batch (a true replay — including a retry of an op
   whose original `sync_operations` row has since been deleted by
   compaction, where step 3's `operationId` lookup can no longer see it) is
   reported `duplicate`, the same as an idempotent replay caught in step 3:
   from the client's perspective both mean "already accepted, safe to treat
   as success," and the server cannot always tell them apart once the
   original row is gone. An op is rejected `sequence_out_of_order` when its
   `deviceSequence` is merely lower than or equal to an *earlier op in this
   same batch* (the batch itself wasn't sorted) — that's a genuine client
   ordering bug, not a replay of anything durably accepted. Every op after
   the first inversion in an unsorted batch is lost to one of these two
   outcomes, so clients must sort `operations` by `deviceSequence` before
   uploading.
5. Schema validation (object type/operation type/payload shape/size limits).
   Per-op payload cap is 256KB, with one exception:
   `historyVisit`/`bulkImport` allows up to 96MB
   (`MAX_BULK_HISTORY_PAYLOAD_BYTES`, sized against a heavy-tailed
   "unlimited" profile — measure one real lifetime profile before freezing
   the number). `bulkImport` requires `1 <= visitCount <= 1,000,000`
   (`MAX_VISIT_COUNT_PER_OP`; rejected as `bulk_import_missing_count` below
   1, `visit_count_too_large` above the ceiling); any non-bulk op carrying
   `visitCount` is rejected. One accepted bulk op advances the cursor by
   one, like any other op.
6. Protocol version compatibility (§13).
7. Object authorization: the referenced `objectId` must belong to the
   authenticated user (via prior operations or a fresh `create`).
   `historyVisit` (including `bulkImport`) is always an origination, so
   this passes for any fresh bulk `objectId`.

Only after all checks pass is the operation durably inserted with a fresh
`server_cursor` inside the same transaction that returns success.

### 10.3 Snapshot

```http
GET /api/v1/sync/snapshot
Authorization: Bearer <deviceAccessToken>
```

```json
{
  "snapshotCursor": 9000,
  "encryptionVersion": 1,
  "objects": [ /* current-state records, opaque payload per object */ ]
}
```

Snapshot creation is atomic (a consistent point-in-time view keyed to one
`server_cursor`, `snapshotCursor`). After downloading and applying a
snapshot, the client resumes incremental sync via §10.1 from
`cursor=snapshotCursor`.

---

## 11. Snapshot and Compaction Policy

A device is eligible for incremental sync (§10.1) while its last
acknowledged cursor is still covered by retained operations. Otherwise it
must snapshot-resync (§10.3):

```text
incremental sync unavailable -> request snapshot -> download encrypted
snapshot -> decrypt -> reconcile local state -> apply newer operations
-> new cursor
```

Operations may be compacted only when:

1. All required active (non-revoked) devices have acknowledged a cursor at
   or beyond the operation, AND
2. A snapshot exists that incorporates the operation's effect.

Tombstones additionally require the configured safety retention period to
have elapsed. Revoked devices never block compaction.

---

## 12. WebSocket Protocol

WebSocket is a low-latency **notification-only** channel; it never carries
sync payloads itself.

```json
{ "type": "changes_available", "cursor": 1847 }
```

On receipt, the client calls the normal download API (§10.1). If the
WebSocket is unavailable or disconnects, the client falls back to periodic
polling of §10.1 — synchronization correctness never depends on WebSocket
delivery. Authentication uses the device access token (query-string tokens
for long-lived secrets are disallowed; the token is sent as the first
WebSocket message after connect, or via a short-lived one-time ticket
fetched over HTTPS immediately before connecting).

---

## 13. Protocol Compatibility

Every client and server response advertises:

```text
apiVersion: "v1"
protocolVersion: 1
minimumSupportedProtocolVersion: 1
extensionVersion: "<semver>"
```

Rules:

- Minor protocol additions (new optional fields, new non-breaking operation
  types) are backward compatible; unknown optional fields are ignored by
  older clients.
- Unknown `operationType` values are stored (not discarded) but not applied
  by a client that doesn't understand them; the affected object enters a
  local `compatibility_pending` state, never a silent no-op. Old clients
  don't know `bulkImport` (§8.3.1): per this rule they store-but-don't-apply
  it, silently missing new history until updated. Documented, not gated
  (revisit only if peer-version data says otherwise).
- A client whose `protocolVersion` is below the server's
  `minimumSupportedProtocolVersion` is rejected on write endpoints with
  `426 Upgrade Required` and a machine-readable error; it may still read
  (download) so the user isn't locked out of seeing state while upgrading,
  but is blocked from producing new operations the server can't safely
  reason about.
- The server never sends a newer client operations it can't understand
  (not applicable today since the server is payload-opaque for encrypted
  operations, but structurally: the server itself never generates sync
  operations, only relays and stamps cursors).
- Database migrations must not make previously-retained operations
  unreadable by any still-supported client's protocol version.

---

## 14. Feature Detection

Clients must use runtime feature detection, never hard assumptions about
Chromium API availability:

```ts
if (chrome.tabGroups) {
  // enable tab group synchronization
}
```

An unsupported API disables only the dependent feature; it never fails
synchronization as a whole.

---

## 15. Local State Machine (Extension)

```text
LOCAL_QUEUED -> UPLOAD_IN_FLIGHT -> ACCEPTED_BY_SERVER -> SERVER_DURABLE
  -> (local) ACKNOWLEDGED
  -> (remote) APPLIED_REMOTELY -> ACKNOWLEDGED -> CURSOR_ADVANCED
```

- A browser event is applied to local browser state immediately and
  independently of network status; sync never blocks normal browsing.
- Failed upload returns the operation to `LOCAL_QUEUED`, retried with the
  same `operationId`/`deviceSequence`.
- The operation is only removed from the local pending queue after durable
  server acceptance (§10.2 response contains it in `accepted` or
  `duplicate`).
- Remote application: validate -> decrypt -> apply -> persist resulting
  state -> persist new cursor, atomically, in that order. Cursor advances
  only after successful local application.
- Crash recovery: queued operations remain queued; in-flight operations are
  retried with the same ID; applied operations are deduplicated by
  `operationId`/`objectId` state; cursor advances only after durable local
  application — no transition depends on an in-memory-only flag.
