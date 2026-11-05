# Bookmark Restore Points — Plan

Source: `future_plan.md` §1. Fresh plan: it does not build on
`bookmark_restore_points_plan.md` or on the untracked restore-points files
(see §2).

> Timestamped, full-tree snapshots of the user's bookmarks, built,
> compressed and encrypted in the extension, stored by the server as opaque
> blobs, pruned by server housekeeping. The user can roll back to any point.

---

## 0. Decisions

| # | Decision | Source |
|---|----------|--------|
| D1 | Two restore modes: **merge** (default: re-add and revert, never delete) and **exact** (also removes bookmarks not in the point). | user |
| D2 | v1 is the whole feature: manual + automatic points, full and partial (one folder) restore, extension UI, dashboard page. | user |
| D3 | Restore runs in the extension only. The dashboard manages metadata (list, pin, delete, settings). | code: `web/src/crypto/index.ts` has no SDEK/decrypt; `docs/encryption.md` §8 |
| D4 | Retention: unpinned points older than 90 days are pruned, the newest point is always kept, count and byte caps evict oldest unpinned automatic points first. | **default, not chosen by user** |
| D5 | Points have their own byte budget and do **not** count against `MAX_ACCOUNT_STORAGE_BYTES`, so a full point budget can never block sync. | **default, not chosen by user** |
| D6 | Scheduled points: daily, one per account (server dedupe window). | **default, not chosen by user** |

---

## 1. Facts from the code this plan relies on

| Fact | Where |
|------|-------|
| `restore` is allowed for `bookmark`/`bookmarkFolder`; it clears an active tombstone. | `server/src/sync/vocabulary.rs` (`is_restore_operation`), `server/src/sync/routes.rs` (`restores` set) |
| `restore` is not an origination op: the object must exist in `sync_objects` or it is rejected `object_not_found`. `sync_objects` is never pruned. | `vocabulary.rs` `is_origination_operation`, `routes.rs` ownership check |
| Bookmark tombstones are never deleted (housekeeping prunes only tab/window ones). | `server/src/housekeeping.rs` `delete_old_ephemeral_tombstones`, `0001_init.sql` index comment |
| `bookmark_count` deltas come from real tombstone state, so a `restore` of a non-tombstoned object counts 0. | `routes.rs` `pre_active` |
| The extension applies a remote `restore` exactly like `create` (materialize if `liveness` wins). | `extension/src/bookmarks/index.ts` `remoteFieldResolutions`, `applyRemote` |
| Removing a folder emits **one** `delete` (the folder) and forgets **only** the folder's mapping; descendants keep stale mappings, and stay live server-side. Same on remote apply (`applyDelete` → `removeTree` → `forgetMapping` of one id). | `bookmarks/index.ts` `stageRemoved`, `flushBookmarkEvents`, `applyDelete` |
| `materialize` returns early when a mapping exists, without checking the Chromium node still exists. With the fact above, a `restore` of a child of a deleted folder is **not** recreated on any device today. | `bookmarks/index.ts` `materialize` (`if (chromiumIds.has(objectId))`) |
| Built-in roots (and Android stand-ins) map to fixed objectIds. | `bookmarks/roots.ts` `ROOT_OBJECT_IDS`, stand-ins |
| `object_not_found` rejections are requeued up to 20 times, then dropped. | `extension/src/sync/engine.ts` `classifyRejections`, `MAX_UPLOAD_ATTEMPTS` |
| Sync slot is single-flight; `downloadEverything` shows how to wait for and hold it. | `engine.ts` `syncInFlight`, `syncSlotWaiters` |
| Snapshot resync clears all field state first. | `engine.ts` `applySnapshot` → `clearFieldState` |
| Initial import: `downloadEverything` (linking on) then `backfillBookmarks`. | `extension/src/background/index.ts` `runInitialImport` |
| AAD = JSON `[objectType, objectId, operationType]`; envelope v2 `{v, keyVersion, alg, nonce, ciphertext}`. | `extension/src/crypto/index.ts` |
| `deflate-raw` via `CompressionStream`, feature-detected; absent `codec` = uncompressed. | `extension/src/history/bulk.ts` |
| `AppError::Conflict(code)` returns 409 with that code. | `server/src/error.rs` |
| Auth extractors: `AuthenticatedDevice`, `AnyAuthenticatedUser` (read), `AnyAuthorizedMutator` (device or session+CSRF). | `server/src/auth/extractors.rs` |
| `/version` already carries an optional field (`registrationEnabled`, missing = true). | `server/src/lib.rs` `version`, `docs/protocol.md` §13 |
| Migrations: only `0001_init.sql` is tracked; app is live → new numbered migration. | `server/migrations/` |
| IndexedDB schema is at upgrade step 8. | `extension/src/storage/db.ts` |
| Popup views: `ConnectedView = "status" \| "settings"`, `renderHeaderButton`, `showConfirmDialog`. | `extension/src/popup/main.ts` |
| Long jobs keep the worker alive with `startKeepAlive`. | `extension/src/util/keep-alive.ts` |

---

## 2. Prerequisite (user decision, before any code)

These untracked paths are the same paths this plan creates. They must be
removed or moved aside first, or the new work will mix with them:

- `server/migrations/0002_restore_points.sql`, `server/src/restore_points/`,
  `server/tests/restore_points_flow.rs`, untracked `server/.sqlx/query-*.json`
- `extension/src/restore-points/`, `extension/src/bookmarks/restore*.ts`,
  `extension/src/bookmarks/mass-delete.test.ts`,
  `extension/src/sync/restore-reissue.test.ts`, `extension/src/util/deflate.ts`
- `web/src/pages/RestorePoints.tsx`
- `bookmark_restore_points_plan.md`

---

## 3. Point format and encryption

### 3.1 Plaintext

```json
{
  "v": 1,
  "createdAt": "2026-11-04T10:00:00Z",
  "deviceId": "…",
  "kind": "manual",
  "nodes": [
    { "o": "<objectId>", "k": "f", "t": "Work", "p": "<parent objectId>", "x": "a0" },
    { "o": "<objectId>", "k": "b", "t": "Docs", "u": "https://…", "p": "<parent objectId>", "x": "a1" }
  ]
}
```

- `k`: `b` bookmark, `f` folder. `x`: fractional position from the node's
  `move` field state (`positionOf`); if missing, derived from Chromium index
  order with `keyBetween`.
- Roots never listed; `p` may be a root objectId.
- Parent-before-child order (top-down walk), siblings in Chromium index order.
- Skipped: nodes with `unmodifiable` set (policy-managed), and the subtree of
  anything unmapped.
- Unmapped node found (capture not flushed, backfill not finished): the
  attempt fails with `bookmarks_not_ready` (manual: shown to the user;
  automatic: retried on the next trigger). Never a partial tree, except the
  `pre_import` case (§5.4), which by design keeps mapped nodes only.

### 3.2 Encoding

`JSON → UTF-8 → deflate-raw (if supported) → encryptBytesWithSdek` under the
current SDEK and key version.

- AAD: `["bookmarkRestorePoint", "<pointId>", "snapshot"]`. Not an object
  type, so a point can never be replayed as an op or vice versa. Envelope
  format unchanged (stays v2).
- `pointId`: client UUIDv7, bound by AAD (server cannot swap blobs).
- `codec` sent in plaintext next to the envelope (`"deflate-raw"` or absent).
- Decode: unsupported `v` → `UnsupportedEnvelopeVersionError` ("update the
  extension"); auth failure → point marked unreadable, never applied;
  then validate (`v`, node shapes, ids are UUIDs, every `p` is a root or an
  earlier node, no duplicates, no cycles, `u` only on `b`).

### 3.3 What the server sees

Point id, account, device, kind, server time, envelope size, bookmark count,
pinned, codec. Bookmark count is already known (`sync_stats.bookmark_count`).
Size and timing leak tree size/compressibility — documented in
`docs/encryption.md` §6.3. Tree hashes stay on the device only (a server-side
hash would reveal "unchanged since").

---

## 4. Server

### 4.1 Migration `0002_restore_points.sql`

```sql
CREATE TABLE bookmark_restore_points (
    id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN
        ('manual', 'scheduled', 'pre_restore', 'pre_import', 'pre_resync', 'mass_delete')),
    bookmark_count INT NOT NULL CHECK (bookmark_count >= 0),
    encryption_version INT NOT NULL CHECK (encryption_version >= 0),
    codec TEXT CHECK (codec IN ('deflate-raw')),
    envelope BYTEA NOT NULL,          -- raw envelope JSON text, never parsed
    size_bytes INT NOT NULL CHECK (size_bytes >= 0),
    pinned BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_restored_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, id)
);
CREATE INDEX idx_restore_points_user_created ON bookmark_restore_points (user_id, created_at DESC);
CREATE INDEX idx_restore_points_created ON bookmark_restore_points (created_at) WHERE NOT pinned;

ALTER TABLE sync_stats ADD COLUMN restore_point_bytes BIGINT NOT NULL DEFAULT 0
    CHECK (restore_point_bytes >= 0);
ALTER TABLE user_settings ADD COLUMN restore_points_automatic BOOLEAN NOT NULL DEFAULT true;
```

Additive only (constant defaults, no rewrite). Regenerate `.sqlx` offline data.

### 4.2 Module `server/src/restore_points/{mod.rs, model.rs, routes.rs}`

Nested at `/api/v1/restore-points` in the compressible router (`lib.rs`).

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/` | `AuthenticatedDevice` | Upload `{id, kind, bookmarkCount, encryptionVersion, codec?, envelope}` → metadata. |
| `GET` | `/` | `AnyAuthenticatedUser` | Metadata list, newest first, with device name (`null` if device deleted). |
| `GET` | `/{id}` | `AuthenticatedDevice` | Metadata + envelope. Web sessions cannot download. |
| `PATCH` | `/{id}` | `AnyAuthorizedMutator` | `{pinned}`. |
| `DELETE` | `/{id}` | `AnyAuthorizedMutator` | Delete one. |
| `POST` | `/{id}/applied` | `AuthenticatedDevice` | `{mode, partial}` after a restore: sets `last_restored_at`, audit event. |

Rules:

- Writes require `X-Protocol-Version` (reuse `reject_if_protocol_too_old`,
  made `pub(crate)`).
- `envelope` read as `RawValue` (like op payloads), stored as bytes;
  `size_bytes` = its length. Envelope over `RESTORE_POINT_MAX_BYTES` →
  `AppError::Validation` ("restore point too large"); a body over the route's
  `DefaultBodyLimit` is refused with 413 before parsing.
- `encryptionVersion == 0` rejected when server-wide or per-user encryption
  is required (same rule as `check_op_shape`).
- `bookmarkCount` ≤ 1,000,000; `kind` from the list above.
- Idempotent on `(user_id, id)`: same id re-uploaded → existing metadata, 200.
- `scheduled`: if the account has a `scheduled` point newer than
  `RESTORE_POINT_SCHEDULED_MIN_INTERVAL_SECS` → `409 restore_point_recent`.
  Other kinds never deduped.
- Automatic kinds (all but `manual`) → `409 restore_points_disabled` when
  `user_settings.restore_points_automatic` is false.
- One transaction per upload: lock user stats (`lock_user_stats`), insert,
  evict to fit caps (§4.4), upsert `sync_stats.restore_point_bytes`.
- Other users' ids → `404`, never `403`.
- Own `DefaultBodyLimit` (max bytes + 64 KiB) and `ConcurrencyLimitLayer(4)`
  on the upload route, as `/sync/operations` does.
- Rate limits in `middleware/rate_limit.rs`: `RESTORE_POINT_UPLOAD_LIMIT`
  (per device), `RESTORE_POINT_DOWNLOAD_LIMIT` (per device),
  `RESTORE_POINT_READ_LIMIT` (list, per key), `RESTORE_POINT_WRITE_LIMIT`
  (pin/delete/applied).
- Audit (`audit.rs`): `restore_point_deleted`, `restore_point_pinned`,
  `restore_point_unpinned`, `restore_point_applied`.

### 4.3 Other server changes

- `/version`: add `"restorePoints": true` (optional field; missing = false).
- `/sync/stats`: add `restorePointCount`, `restorePointBytes`,
  `restorePointLimitBytes`.
- `/sync/settings`: `restorePointsAutomatic` in GET and PATCH.
- Compaction: verify its `sync_stats` writes never touch `restore_point_bytes`.
- Account delete: cascade. Device delete/revoke: points kept (`device_id` NULL
  on delete).

### 4.4 Limits, retention, housekeeping (D4, D5)

Config (`config.rs`, `.env.example`, `server/.env.example`, `docs/deployment.md`):

| Variable | Default |
|----------|---------|
| `RESTORE_POINT_MAX_BYTES` | 33554432 (32 MiB per point) |
| `RESTORE_POINT_MAX_ACCOUNT_BYTES` | 1073741824 (1 GiB per account) |
| `RESTORE_POINT_MAX_PER_ACCOUNT` | 50 (pinned included) |
| `RESTORE_POINT_MAX_PINNED` | 10 |
| `RESTORE_POINT_RETENTION_DAYS` | 90 |
| `RESTORE_POINT_SCHEDULED_MIN_INTERVAL_SECS` | 72000 (20 h) |

- **On insert**: while over count or byte cap, delete the oldest unpinned
  point, automatic kinds first, then manual. If only pinned points are
  left → `409 restore_point_limit` (insert rolled back).
- **Pin**: over `RESTORE_POINT_MAX_PINNED` → `409 restore_point_pin_limit`.
- **Housekeeping** `prune_restore_points` in `housekeeping::run_once`,
  chunked like the other prunes: deletes unpinned points older than
  `RESTORE_POINT_RETENTION_DAYS`, never the account's newest point; per
  chunk, decrements `restore_point_bytes` by exactly the deleted
  `size_bytes` (same transaction).

---

## 5. Extension

### 5.1 Bookmark engine fixes (needed by restore, ship first)

1. **Descendant mappings on folder removal.** Capture (`stageRemoved`) and
   remote apply (`applyDelete`) forget the mappings of every descendant, not
   just the folder. Remote: read `chrome.bookmarks.getSubTree` before
   `removeTree`. Capture: use `removeInfo.node.children` — **verify in a real
   Chromium e2e that `node` carries children**; if not, find descendants by a
   mapping sweep (step 3).
2. **`materialize` trusts no stale mapping.** When a mapping exists, check the
   Chromium node with `chrome.bookmarks.get`; if it is gone, forget the
   mapping and create the node. Applies to remote `create` and `restore`.
3. **One-time stale-mapping sweep** (flag in `chrome.storage.local`): drop
   bookmark mappings whose Chromium id is not in `getTree()`. Also run before
   every restore. Existing devices already hold stale mappings.

### 5.2 Modules

| File | Role |
|------|------|
| `src/restore-points/format.ts` | Types, encode/decode (§3), validation. |
| `src/restore-points/snapshot.ts` | Builds nodes from `getTree()` + mappings + `move` field state; options: full / mapped-only / plus-removed-subtrees. |
| `src/restore-points/outbox.ts` | IndexedDB store `restore_point_outbox` (upgrade step 9): encrypted points waiting for upload; drained after each point is made and on the sync alarm; `409 restore_point_recent` / `restore_points_disabled` → discarded. |
| `src/restore-points/planner.ts` | Diff point vs live state → ordered ops (§5.5). Pure, unit-tested. |
| `src/restore-points/restore.ts` | Restore job: lock, pre-restore point, plan, apply in chunks, resume, report. |
| `src/restore-points/triggers.ts` | Alarm and hooks (§5.4), local tree-hash skip, throttles. |
| `src/util/compression.ts` | `deflateRaw`/`inflateRaw` moved out of `history/bulk.ts`, shared. |
| `src/api/client.ts` | `listRestorePoints`, `uploadRestorePoint`, `downloadRestorePoint`, `setRestorePointPinned`, `deleteRestorePoint`, `reportRestoreApplied`; server feature flag from `/version`. |

Feature off (no menu, no triggers) when: server lacks `restorePoints`,
bookmark sync disabled, or initial import not completed.

### 5.3 Engine and bookmark hooks

- `engine.ts`: `runExclusive(fn)` — waits for and holds the sync slot (as
  `downloadEverything` does), reruns a requested cycle after.
- `engine.ts`: `registerPreSnapshotHook(fn)`, awaited in `applySnapshot`
  before `clearFieldState`.
- `engine.ts`: `restore` op rejected `object_not_found` → re-issued at once as
  `create` with the **same objectId** and payload (decrypt with the device
  SDEK, re-encrypt with the `create` AAD, new op id/sequence/Lamport), field
  state recorded with the new key; original removed from the queue. The
  server never knew the object, so there is no tombstone to clear.
- `bookmarks/index.ts` exports: `readLiveBookmarks()` (for snapshot/planner),
  `applyRestoreOperations(created)` — runs our own new ops through the
  existing batch applier (`applyRemoteBatch` path) under `guard`, so field
  state, deferred parents, move batching and URL-scheme checks are the same
  code other devices run; `setMassDeleteHandler(fn)`.

### 5.4 Triggers

| Kind | When | Source |
|------|------|--------|
| `manual` | Popup button. | live tree |
| `scheduled` | `chrome.alarms` `helixsync-restore-point`, every 24 h. Skipped if the tree hash equals the last point this device made; `409 restore_point_recent` = another device already made today's. | live tree |
| `pre_restore` | Before every restore (§5.6). Must upload, or the restore aborts. | live tree |
| `pre_import` | `runInitialImport`, after `downloadEverything`, before `backfillBookmarks`, only if the account already has bookmarks and this browser has unmapped ones. Exact restore of it undoes the import. | mapped nodes only |
| `pre_resync` | Pre-snapshot hook, before `clearFieldState`. | live tree |
| `mass_delete` (local) | A capture flush whose removals (folders counted with descendants) reach `MASS_DELETE_THRESHOLD` (50). Built after the flush: live tree plus the removed subtrees (from `removeInfo.node` + their still-present mappings and `move` field state). | live + removed |
| `mass_delete` (remote) | A remote bookmark batch whose deletes (counted with `getSubTree`) reach the threshold, built **before** the batch is applied. | live tree |

Automatic kinds respect `restorePointsAutomatic`; `mass_delete` at most once
per 10 minutes per device. All except `pre_restore` go through the outbox,
so they never block sync or capture.

### 5.5 Planner

Input: decoded point, live state (Chromium tree + mappings + field state),
mode (`merge` | `exact`), scope (`all` | folder objectId).

"Live" means present in the Chromium tree right now (not the field state, not
a mapping). Roots and stand-ins are always live and never touched.

| Case | Op |
|------|----|
| In point, not live | `restore` with `{title, url, parent, position}` |
| Live, `title`/`url` differ | `update` (changed fields only) |
| Live, `parent`/`position` differ | `move` |
| Live, not in point, in scope | exact: `delete` (topmost only — descendants go with it); merge: none |
| `u` with a disallowed scheme (`isSyncableUrl`) | skipped, counted |

Order: restores parent-before-child → updates → moves → deletes. Moves run
before deletes, so a node kept by the point is moved out of a folder that
exact mode deletes.

Partial scope: the chosen folder's subtree only; if the folder (or its
ancestors) is not live, the missing ancestor chain from the point is
restored too; exact mode deletes only inside that folder.

Output: ops + counts `{restored, updated, moved, deleted, skipped}` + a
sample of titles for the preview.

### 5.6 Restore job

1. Download → decode → validate (fail closed, nothing touched).
2. `runExclusive`: flush capture queues, run one upload+download cycle,
   stale-mapping sweep.
3. Build and upload a `pre_restore` point; abort on failure.
4. Plan; persist job `{pointId, mode, scope, preRestorePointId, startedAt}` in
   IndexedDB store `restore_jobs` (upgrade step 9).
5. Chunks of 500: `createLocalOperationsBatch` → `applyRestoreOperations` →
   persist progress; `startKeepAlive`, yield between chunks.
6. `scheduleLocalSync()`, `POST /{id}/applied`, clear job, report counts.

Resume: on worker start a leftover job re-runs steps 1, 2, 4, 5 without a new
`pre_restore` point. Planning is idempotent (already-converged nodes give no
op), so an interruption at any point is safe; ops created but not applied
before a crash are re-emitted with the same values.

Other devices get ordinary `restore`/`update`/`move`/`delete` ops and resolve
them with §8.2. Restore ops carry fresh Lamport values: they win over what
this device has seen, not over later edits elsewhere.

### 5.7 Popup UI

- Header button next to Settings → new view `restorePoints`.
- List: date, kind, device name, bookmark count, size, pinned badge;
  outbox items shown as "Uploading…". Button "Create restore point".
- Row: Restore…, Pin/Unpin, Delete (confirm).
- Restore…: scope (Whole tree / pick a folder from the point's folder tree,
  lazily expanded), mode (Merge default / Exact), Preview (counts + sample),
  confirm via `showConfirmDialog` (extra warning for Exact). Then a progress
  view that survives closing the popup (polls `GET_RESTORE_PROGRESS`).
- Settings view: "Automatic restore points" toggle.
- DOM APIs only, no `innerHTML` with point data (titles are user data).
- Errors: not supported by server (hidden), bookmark sync off, still
  syncing, unreadable point, update needed, limit/pin limit, offline.
- Background messages: `LIST_RESTORE_POINTS`, `CREATE_RESTORE_POINT`,
  `GET_RESTORE_POINT_TREE`, `PREVIEW_RESTORE`, `START_RESTORE`,
  `GET_RESTORE_PROGRESS`, `SET_RESTORE_POINT_PINNED`, `DELETE_RESTORE_POINT`.

---

## 6. Web dashboard

- `web/src/pages/RestorePoints.tsx`, route `/restore-points`, nav item
  "Restore points" (`Layout.tsx`).
- List (date, kind, device, bookmarks, size, pinned, last restored),
  pin/unpin, delete with confirm, automatic toggle (settings), storage used vs
  `restorePointLimitBytes`.
- Text: restoring is done from the extension (the dashboard cannot decrypt).
- `web/src/api/client.ts`: list, pin, delete; settings and stats fields.

---

## 7. Docs

- `docs/protocol.md`: new §16 (API, error codes, limits, how a restore maps
  to ops, `object_not_found` → `create` re-issue, stale-mapping rule for
  folder deletes); §13 `restorePoints` in `/version`.
- `docs/encryption.md`: §6.3 restore-point AAD, compression and length leak.
- `docs/architecture.md`: data model table, server/extension modules.
- `docs/security.md`: §5 rate limits, §6 limits, §7 audit events, metadata
  the server sees.
- `docs/deployment.md`: env vars; backups include points.
- `PRIVACY.md`, `README.md` (feature list), `CHANGELOG.md`.

---

## 8. Tests

**Server** (`server/tests/restore_points_flow.rs`, `housekeeping_flow.rs`):
upload/list/get/pin/delete/applied round trip; idempotent re-upload;
cross-account → 404; revoked device rejected; web session: list/pin/delete
with CSRF ok, download refused, no CSRF refused; over max bytes; plaintext
when encryption required; missing protocol header; `scheduled` dedupe 409,
manual not deduped; automatic disabled 409; count and byte eviction order;
pinned-only → 409; pin cap; housekeeping age prune keeps newest and pinned;
byte counter exact after every path; account delete cascades; device delete
keeps points; `/version`, `/stats`, `/settings` fields.

**Extension** (vitest):
- format: round trip with/without codec, AAD mismatch fails, unsupported `v`,
  validation rejects bad parents/cycles/duplicates.
- snapshot: order, roots excluded, unmodifiable skipped, positions, unmapped →
  `bookmarks_not_ready`, mapped-only mode, plus-removed-subtrees mode.
- engine fixes: descendant mappings forgotten (capture and remote);
  `materialize` with stale mapping creates the node; sweep.
- planner: deleted folder with children → ordered restores; rename → update;
  move; merge emits no delete; exact deletes topmost only, after moves;
  partial scope incl. missing ancestors; roots/stand-ins untouched;
  disallowed URL skipped.
- restore job: `pre_restore` before any op, abort if it fails; applied under
  guard (no re-capture); resume after interruption converges; large tree
  (100k nodes) chunked.
- re-issue: `restore` + `object_not_found` → `create`, same objectId.
- triggers: hash skip, 409 handling, mass-delete thresholds local/remote,
  pre-resync hook, pre-import only when needed, automatic toggle, throttle.
- outbox: survives restart, retries, discards on 409.

**E2E** (`extension/e2e/sync.e2e.mjs`): A deletes a folder with children, B
syncs it away; A restores (merge); B gets the folder and children back with
the same objectIds. Also: confirm whether `removeInfo.node` has children
(§5.1).

---

## 9. Phases

| Phase | Content | Done when |
|-------|---------|-----------|
| 0 | §2 resolved. | Paths free. |
| 1 | §5.1 engine fixes. | Unit + e2e: deleted-folder children come back via `restore` on another device. |
| 2 | Server §4. | `cargo test` green, `.sqlx` regenerated, clippy clean. |
| 3 | Extension format, snapshot, outbox, API, manual create, list/pin/delete UI. | Manual point uploads and lists. |
| 4 | Planner, restore job, re-issue, restore UI. | Full and partial restore, both modes, resume. |
| 5 | Automatic triggers + settings toggle. | All kinds produced as specified. |
| 6 | Dashboard page. | List/pin/delete/toggle/usage work. |
| 7 | Docs §7. | All listed docs updated. |

---

## 10. Risks

- **Large trees** (100k+): multi-MB point and large op batches — chunked,
  yielded, kept alive; upload through the normal batched queue.
- **Exact mode is destructive** to bookmarks added after the point —
  mitigated by the mandatory `pre_restore` point and the preview.
- **Concurrent edits elsewhere** during a restore win if they are later
  (§8 ordering); documented, not prevented.
- **Old extensions on other devices** still have the stale-mapping bug (§5.1)
  and will not recreate children of a restored folder until updated —
  CHANGELOG note.
- **Future key rotation** (`docs/encryption.md` §4, not implemented): points
  under an old key version need re-encryption — must be part of that plan.
- **`removeInfo.node` children** unverified — fallback defined (§5.1).
