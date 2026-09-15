use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::extractors::AnyAuthenticatedUser;
use crate::auth::model::AuthenticatedDevice;
use crate::error::{AppError, AppResult};
use crate::middleware::rate_limit::{
    enforce, SYNC_DOWNLOAD_LIMIT, SYNC_SNAPSHOT_LIMIT, SYNC_STATS_LIMIT, SYNC_UPLOAD_LIMIT,
};
use crate::state::AppState;

use super::model::{
    DownloadResponse, OperationIn, OperationOut, SnapshotObject, SnapshotResponse,
    SnapshotTombstone, UploadRejection, UploadRequest, UploadResponse,
};
use super::vocabulary;

const MAX_OPERATIONS_PER_BATCH: usize = 500;
const MAX_PAYLOAD_BYTES: usize = 256 * 1024;
const DEFAULT_DOWNLOAD_LIMIT: i64 = 500;
const MAX_DOWNLOAD_LIMIT: i64 = 1000;
const PROTOCOL_VERSION_HEADER: &str = "x-protocol-version";

/// axum's own default body limit (2MB) sits far below what
/// `MAX_OPERATIONS_PER_BATCH * MAX_PAYLOAD_BYTES` already promises to
/// accept (500 * 256KB = 125MB) — a batch of even a handful of
/// near-max-size payloads was silently rejected by the framework before
/// ever reaching the per-op validation in `process_batch`, and because
/// that happens at the extractor level (no per-operation rejection
/// reason), the client's only signal is a bare failed request — which it
/// retries with the exact same byte-identical batch (extension's
/// `uploadPending` requeues the whole batch on any transport-level
/// failure). Sized to what the app-level checks already nominally allow,
/// plus headroom for per-op JSON structural overhead (field names,
/// operationId strings, etc. — at most a few hundred bytes per op).
const MAX_UPLOAD_BODY_BYTES: usize = MAX_OPERATIONS_PER_BATCH * MAX_PAYLOAD_BYTES + 1024 * 1024;

/// Ceiling on how much a single `sync_snapshots.data` row is allowed to
/// gzip-inflate to in [`decompress_snapshot_data`]. Today's largest
/// observed accounts produce a raw (pre-compression) snapshot document in
/// the 30-50MB range (see [`compress_snapshot_data`]'s doc comment) — this
/// leaves several times that much headroom for account growth while still
/// bounding how much memory a single corrupt or maliciously-crafted row
/// (gzip can inflate a tiny input by orders of magnitude) can force this
/// process to allocate while decoding it.
const MAX_DECOMPRESSED_SNAPSHOT_BYTES: u64 = 256 * 1024 * 1024;

/// docs/protocol.md §13: a client whose advertised protocol version is
/// below the server's minimum is blocked from *writing* new operations
/// (but not from reading — see the same section). The header is optional
/// for now since v1 is the only version that has ever existed; once a v2
/// ships, older clients omitting it are the ones this check exists for.
fn reject_if_protocol_too_old(headers: &HeaderMap, state: &AppState) -> AppResult<()> {
    let Some(value) = headers.get(PROTOCOL_VERSION_HEADER) else {
        return Ok(());
    };
    let Ok(version) = value.to_str().unwrap_or("").parse::<u32>() else {
        return Ok(());
    };
    if version < state.config.minimum_supported_protocol_version {
        return Err(AppError::ProtocolTooOld);
    }
    Ok(())
}

pub fn router() -> Router<AppState> {
    // Scoped to just this route via its own sub-router (rather than
    // `Router::layer` on the whole thing) so every other route here keeps
    // axum's normal 2MB default — there's no reason `/changes`, `/snapshot`,
    // or `/settings` should ever accept a body anywhere near upload's size.
    let upload_route = Router::new()
        .route("/operations", post(upload))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BODY_BYTES));

    Router::new()
        .merge(upload_route)
        .route("/changes", get(download))
        .route("/snapshot", get(snapshot))
        .route("/stats", get(stats))
        .nest("/settings", super::settings::router())
}

async fn upload(
    device: AuthenticatedDevice,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<UploadRequest>,
) -> AppResult<Json<UploadResponse>> {
    reject_if_protocol_too_old(&headers, &state)?;

    if req.operations.len() > MAX_OPERATIONS_PER_BATCH {
        return Err(AppError::Validation(format!(
            "too many operations in one batch (max {MAX_OPERATIONS_PER_BATCH})"
        )));
    }

    enforce(
        &state.rate_limiter,
        SYNC_UPLOAD_LIMIT,
        &device.device_id.to_string(),
    )?;

    crate::devices::touch_last_seen_background(&state, device.device_id);

    let outcome = process_batch(&state, &device, &req.operations).await?;

    if !outcome.accepted.is_empty() {
        state.ws_registry.notify_changes(
            device.user_id,
            outcome.server_cursor,
            Some(device.device_id),
        );
    }

    Ok(Json(UploadResponse {
        accepted: outcome.accepted,
        duplicate: outcome.duplicate,
        rejected: outcome.rejected,
        server_cursor: outcome.server_cursor,
    }))
}

struct BatchOutcome {
    accepted: Vec<Uuid>,
    duplicate: Vec<Uuid>,
    rejected: Vec<UploadRejection>,
    server_cursor: i64,
}

/// Per-op decision reached during the in-memory validation pass below,
/// before any of the batch's writes are issued.
enum Decision<'a> {
    Duplicate(i64),
    Rejected(&'static str),
    Accept(&'a OperationIn),
}

/// Validates and persists an entire upload batch in one transaction instead
/// of one transaction per operation. The old code (see git history) ran
/// every check — dedup, the advisory lock, the device-sequence check, the
/// ownership check, cursor allocation, the insert, the tombstone write —
/// as its own round trip *per operation*, which is what made a 500-op
/// batch cost on the order of thousands of sequential DB round trips (and,
/// worse, thousands of separate transaction commits/fsyncs). All of that
/// batches cleanly here because every operation in one request always
/// belongs to the same device: the per-device advisory lock, the "last
/// device sequence seen" counter, and the per-user cursor allocator are
/// each acquired/read exactly once for the whole batch rather than once
/// per op.
async fn process_batch(
    state: &AppState,
    device: &AuthenticatedDevice,
    ops: &[OperationIn],
) -> AppResult<BatchOutcome> {
    if ops.is_empty() {
        // No writes to make for an empty batch — just report the current
        // cursor, read straight off the pool. Opening a transaction here
        // (`BEGIN` + this `SELECT` + an implicit `ROLLBACK` on drop) would be
        // three round trips and a checked-out connection for a single read.
        let cursor = current_cursor(&state.db, device.user_id).await?;
        return Ok(BatchOutcome {
            accepted: vec![],
            duplicate: vec![],
            rejected: vec![],
            server_cursor: cursor,
        });
    }

    let mut tx = state.db.begin().await?;

    // Serializes per-device sequence validation + cursor allocation against
    // any other concurrent upload from this same device — held for the
    // whole batch (not re-acquired per op) since it's the same device
    // throughout one request.
    sqlx::query!(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        device.device_id.to_string()
    )
    .execute(&mut *tx)
    .await?;

    // Bulk dedup: one query for every operation_id in the batch instead of
    // one per op.
    let op_ids: Vec<Uuid> = ops.iter().map(|o| o.operation_id).collect();
    let existing: HashMap<Uuid, i64> = sqlx::query!(
        "SELECT operation_id, server_cursor FROM sync_operations WHERE operation_id = ANY($1)",
        &op_ids
    )
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|r| (r.operation_id, r.server_cursor))
    .collect();

    // `devices.last_device_sequence` (migration `0009_devices_last_sequence.sql`)
    // is the source of truth here, not `MAX(device_sequence) FROM
    // sync_operations` — that query used to reset to 0 once
    // `sync::compaction` deleted a device's rows (e.g. an idle device
    // fully folded into a snapshot), letting a later upload reuse
    // `device_sequence` values it had already used and had accepted,
    // instead of being rejected `sequence_conflict`. Reading it here is
    // race-free under the same per-device `pg_advisory_xact_lock` acquired
    // above, which already serializes concurrent uploads from this device
    // — the same guarantee the old query relied on.
    let mut last_seq: i64 = sqlx::query_scalar!(
        "SELECT last_device_sequence FROM devices WHERE id = $1",
        device.device_id
    )
    .fetch_one(&mut *tx)
    .await?;

    // Bulk ownership pre-check: every (object_type, object_id) a
    // non-origination, non-duplicate op in this batch refers to, resolved
    // in one query instead of one `EXISTS` per op. An object *originated
    // earlier in this same batch* won't show up here (its insert hasn't
    // happened yet) — that case is handled separately via
    // `originated_in_batch` below.
    //
    // This checks `sync_objects`, a dedicated existence ledger that is
    // *never* pruned by `sync::compaction` (see migration
    // `0006_sync_objects.sql`) — not `sync_operations` directly.
    // `sync_operations` rows get deleted by compaction once folded into a
    // snapshot, including an object's originating `create` row, so
    // querying it here would make every already-compacted object
    // permanently fail this check on any later edit (the bug this table
    // exists to fix). `sync_objects` has its own primary key
    // `(user_id, object_type, object_id)`, so no `DISTINCT` is needed here.
    let mut lookup_types: Vec<String> = Vec::new();
    let mut lookup_ids: Vec<Uuid> = Vec::new();
    for op in ops {
        if existing.contains_key(&op.operation_id) {
            continue;
        }
        if !vocabulary::is_origination_operation(&op.object_type, &op.operation_type) {
            lookup_types.push(op.object_type.clone());
            lookup_ids.push(op.object_id);
        }
    }
    let owned: HashSet<(String, Uuid)> = if lookup_ids.is_empty() {
        HashSet::new()
    } else {
        sqlx::query!(
            r#"
            SELECT so.object_type, so.object_id
            FROM sync_objects so
            JOIN UNNEST($1::text[], $2::uuid[]) AS lookup(object_type, object_id)
              ON so.object_type = lookup.object_type AND so.object_id = lookup.object_id
            WHERE so.user_id = $3
            "#,
            &lookup_types,
            &lookup_ids,
            device.user_id
        )
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(|r| (r.object_type, r.object_id))
        .collect()
    };

    // Pure in-memory validation pass — no queries in this loop. Mirrors the
    // old per-op checks exactly, but `last_seq` and `originated_in_batch`
    // are updated as we go so later ops in the batch see earlier ops in
    // the *same* batch, the same way they would have as separate
    // sequential requests.
    let mut decisions: Vec<Decision> = Vec::with_capacity(ops.len());
    let mut originated_in_batch: HashSet<(String, Uuid)> = HashSet::new();

    for op in ops {
        if let Some(&cursor) = existing.get(&op.operation_id) {
            decisions.push(Decision::Duplicate(cursor));
            continue;
        }
        if !vocabulary::is_known_object_type(&op.object_type) {
            decisions.push(Decision::Rejected("unknown_object_type"));
            continue;
        }
        if !vocabulary::allowed_operation_types(&op.object_type).contains(&op.operation_type.as_str())
        {
            decisions.push(Decision::Rejected("unknown_operation_type"));
            continue;
        }
        if op.encryption_version < 0 {
            decisions.push(Decision::Rejected("invalid_encryption_version"));
            continue;
        }
        if op.encryption_version == 0 && state.config.require_encryption {
            decisions.push(Decision::Rejected("encryption_required"));
            continue;
        }
        let payload_size = serde_json::to_vec(&op.payload).map(|v| v.len()).unwrap_or(0);
        if payload_size > MAX_PAYLOAD_BYTES {
            decisions.push(Decision::Rejected("payload_too_large"));
            continue;
        }
        if op.device_sequence < 1 {
            decisions.push(Decision::Rejected("invalid_device_sequence"));
            continue;
        }
        if op.device_sequence <= last_seq {
            decisions.push(Decision::Rejected("sequence_conflict"));
            continue;
        }

        let is_origination = vocabulary::is_origination_operation(&op.object_type, &op.operation_type);
        if !is_origination {
            let key = (op.object_type.clone(), op.object_id);
            if !owned.contains(&key) && !originated_in_batch.contains(&key) {
                decisions.push(Decision::Rejected("object_not_found"));
                continue;
            }
        }

        last_seq = op.device_sequence;
        if is_origination {
            originated_in_batch.insert((op.object_type.clone(), op.object_id));
        }
        decisions.push(Decision::Accept(op));
    }

    let accepted_ops: Vec<&OperationIn> = decisions
        .iter()
        .filter_map(|d| match d {
            Decision::Accept(op) => Some(*op),
            _ => None,
        })
        .collect();

    let mut server_cursor = 0i64;

    if !accepted_ops.is_empty() {
        // Atomically reserve a contiguous cursor range sized to exactly the
        // accepted count — one round trip regardless of batch size. Still
        // race-safe against a concurrent upload from a *different* device
        // of the same user: the UPDATE's row lock on the `sync_cursors` row
        // serializes them exactly as the old one-increment-per-op version
        // did, just in one larger increment instead of many increments of 1.
        let count = accepted_ops.len() as i64;
        let end_cursor: i64 = sqlx::query_scalar!(
            r#"
            INSERT INTO sync_cursors (user_id, device_id, cursor_value)
            VALUES ($1, NULL, $2)
            ON CONFLICT (user_id, device_id)
            DO UPDATE SET cursor_value = sync_cursors.cursor_value + $2, updated_at = now()
            RETURNING cursor_value
            "#,
            device.user_id,
            count
        )
        .fetch_one(&mut *tx)
        .await?;
        let start_cursor = end_cursor - count + 1;
        server_cursor = end_cursor;

        let mut operation_ids = Vec::with_capacity(accepted_ops.len());
        let mut device_sequences = Vec::with_capacity(accepted_ops.len());
        let mut lamport_timestamps = Vec::with_capacity(accepted_ops.len());
        let mut cursors = Vec::with_capacity(accepted_ops.len());
        let mut object_types = Vec::with_capacity(accepted_ops.len());
        let mut object_ids = Vec::with_capacity(accepted_ops.len());
        let mut operation_types = Vec::with_capacity(accepted_ops.len());
        let mut encryption_versions = Vec::with_capacity(accepted_ops.len());
        let mut payloads = Vec::with_capacity(accepted_ops.len());

        // Deduped by object: a batch could (rarely) contain more than one
        // terminal/restore op for the same object (e.g. a delete resent
        // after a dropped response, or two logically-redundant deletes).
        // `sync_operations` rows preserve every one of them regardless, but
        // one INSERT statement's ON CONFLICT DO UPDATE cannot target the
        // same tombstone row twice, so only the highest-cursor (i.e. last
        // processed, same as the old sequential loop's end state) entry
        // per object survives into the bulk tombstone write.
        let mut tombstones: HashMap<(String, Uuid), i64> = HashMap::new();
        let mut restores: HashSet<(String, Uuid)> = HashSet::new();
        // Every accepted origination op in this batch gets a row in
        // `sync_objects` (the never-compacted existence ledger — see
        // migration `0006_sync_objects.sql`), deduped since a batch could
        // contain more than one origination op for the same object (e.g. a
        // resent `create` after a dropped response) and the insert below is
        // `ON CONFLICT DO NOTHING` per key anyway.
        let mut originations: HashSet<(String, Uuid)> = HashSet::new();

        for (i, op) in accepted_ops.iter().enumerate() {
            let cursor = start_cursor + i as i64;
            operation_ids.push(op.operation_id);
            device_sequences.push(op.device_sequence);
            lamport_timestamps.push(op.lamport_timestamp);
            cursors.push(cursor);
            object_types.push(op.object_type.clone());
            object_ids.push(op.object_id);
            operation_types.push(op.operation_type.clone());
            encryption_versions.push(op.encryption_version);
            payloads.push(op.payload.clone());

            if vocabulary::is_terminal_operation(&op.object_type, &op.operation_type) {
                tombstones.insert((op.object_type.clone(), op.object_id), cursor);
            } else if vocabulary::is_restore_operation(&op.object_type, &op.operation_type) {
                restores.insert((op.object_type.clone(), op.object_id));
            }
            if vocabulary::is_origination_operation(&op.object_type, &op.operation_type) {
                originations.insert((op.object_type.clone(), op.object_id));
            }
        }

        // `sync_stats` incremental upkeep (see migrations/0007_sync_stats.sql
        // for the three-part design this is one leg of — the other two are
        // `sync::compaction::compact_user`'s authoritative reconciliation and
        // the lazy backfill in the `/stats` handler). Computed here, from
        // `originations`/`tombstones`/`restores` above, while they're still
        // borrowable — they get moved (`into_iter().unzip()`) into the
        // existence-ledger/tombstone/restore writes below, so counting must
        // happen before that.
        //
        // Net per-bucket deltas, NOT raw operation counts: a single batch
        // can create-then-delete the same object, and the delta must net to
        // the right final answer without reacting to that intermediate
        // state. `originations` counts objects newly brought into existence
        // in this batch; `tombstones` counts objects terminally removed in
        // this batch; `restores` counts objects brought back from tombstone
        // in this batch (each deduped to one entry per object, see their
        // declarations above). An object created and deleted within the same
        // batch appears in both `originations` and `tombstones`, contributing
        // +1 and -1 -> nets to 0 (correct: it never became observably live).
        // An object that already existed (created in an earlier batch) and
        // is merely updated in this batch appears in none of the three sets
        // -> contributes 0 (correct: no bucket transition happened).
        //
        // `historyVisit` has no tombstone/restore at all — every accepted
        // historyVisit op is itself an origination
        // (`vocabulary::is_origination_operation` returns true whenever
        // `object_type == "historyVisit"`, and neither
        // `is_terminal_operation` nor `is_restore_operation` ever matches
        // it) — so its delta is originations-only. Tabs have a terminal op
        // ("close", via `is_terminal_operation`) but no restore operation
        // type at all (`is_restore_operation` only ever matches
        // bookmark/bookmarkFolder per docs/protocol.md §8.2), so the tab
        // restore term below is always 0 in practice — kept in the formula
        // anyway for symmetry with bookmarks and in case that ever changes.
        let bookmark_types: &[&str] = &["bookmark", "bookmarkFolder"];
        let tab_types: &[&str] = &["tab"];
        let history_types: &[&str] = &["historyVisit"];
        let count_set = |types: &[&str], set: &HashSet<(String, Uuid)>| -> i32 {
            set.iter().filter(|(t, _)| types.contains(&t.as_str())).count() as i32
        };
        let count_map = |types: &[&str], map: &HashMap<(String, Uuid), i64>| -> i32 {
            map.keys().filter(|(t, _)| types.contains(&t.as_str())).count() as i32
        };
        let bookmark_delta = count_set(bookmark_types, &originations)
            - count_map(bookmark_types, &tombstones)
            + count_set(bookmark_types, &restores);
        let history_visit_delta = count_set(history_types, &originations);
        let tab_delta = count_set(tab_types, &originations) - count_map(tab_types, &tombstones)
            + count_set(tab_types, &restores);

        sqlx::query!(
            r#"
            INSERT INTO sync_operations
                (operation_id, user_id, device_id, device_sequence, lamport_timestamp,
                 server_cursor, object_type, object_id, operation_type, encryption_version, payload)
            SELECT u.operation_id, $1, $2, u.device_sequence, u.lamport_timestamp,
                   u.server_cursor, u.object_type, u.object_id, u.operation_type,
                   u.encryption_version, u.payload
            FROM UNNEST(
                $3::uuid[], $4::bigint[], $5::bigint[], $6::bigint[],
                $7::text[], $8::uuid[], $9::text[], $10::int[], $11::jsonb[]
            ) AS u(operation_id, device_sequence, lamport_timestamp, server_cursor,
                   object_type, object_id, operation_type, encryption_version, payload)
            "#,
            device.user_id,
            device.device_id,
            &operation_ids,
            &device_sequences,
            &lamport_timestamps,
            &cursors,
            &object_types,
            &object_ids,
            &operation_types,
            &encryption_versions,
            &payloads
        )
        .execute(&mut *tx)
        .await?;

        // Populate the existence ledger in the same transaction as the
        // operation insert above, so acceptance and ownership-recording are
        // atomic — a crash between the two would otherwise leave an
        // accepted `create` whose later edits can never pass the ownership
        // pre-check. `ON CONFLICT DO NOTHING` since the same object can be
        // (re-)originated across multiple batches (e.g. a resent `create`)
        // without that being an error.
        if !originations.is_empty() {
            let (types, ids): (Vec<String>, Vec<Uuid>) = originations.into_iter().unzip();
            sqlx::query!(
                r#"
                INSERT INTO sync_objects (user_id, object_type, object_id)
                SELECT $1, u.object_type, u.object_id
                FROM UNNEST($2::text[], $3::uuid[]) AS u(object_type, object_id)
                ON CONFLICT DO NOTHING
                "#,
                device.user_id,
                &types,
                &ids
            )
            .execute(&mut *tx)
            .await?;
        }

        if !tombstones.is_empty() {
            let (types, (ids, tomb_cursors)): (Vec<String>, (Vec<Uuid>, Vec<i64>)) = tombstones
                .into_iter()
                .map(|((t, id), c)| (t, (id, c)))
                .unzip();
            sqlx::query!(
                r#"
                INSERT INTO tombstones (user_id, object_type, object_id, deleted_at_cursor, active)
                SELECT $1, u.object_type, u.object_id, u.cursor, true
                FROM UNNEST($2::text[], $3::uuid[], $4::bigint[]) AS u(object_type, object_id, cursor)
                ON CONFLICT (user_id, object_type, object_id)
                DO UPDATE SET deleted_at_cursor = EXCLUDED.deleted_at_cursor, active = true
                "#,
                device.user_id,
                &types,
                &ids,
                &tomb_cursors
            )
            .execute(&mut *tx)
            .await?;
        }

        if !restores.is_empty() {
            let (types, ids): (Vec<String>, Vec<Uuid>) = restores.into_iter().unzip();
            sqlx::query!(
                r#"
                UPDATE tombstones SET active = false
                WHERE user_id = $1
                AND (object_type, object_id) IN (SELECT * FROM UNNEST($2::text[], $3::uuid[]))
                "#,
                device.user_id,
                &types,
                &ids
            )
            .execute(&mut *tx)
            .await?;
        }

        // Apply the net deltas computed above. Skipped entirely when all
        // three are zero (no relevant object types in this batch, or a
        // batch whose only effect on these buckets was churn that netted to
        // nothing) to avoid a no-op write on every upload. `ON CONFLICT ...
        // DO UPDATE SET ... = sync_stats.x + EXCLUDED.x` is what makes this
        // additive rather than a bare overwrite: a nonexistent row is
        // equivalent to one starting at zero either way, since the INSERT
        // arm seeds a fresh row with the delta itself as its initial value.
        if bookmark_delta != 0 || history_visit_delta != 0 || tab_delta != 0 {
            sqlx::query!(
                r#"
                INSERT INTO sync_stats (user_id, bookmark_count, history_visit_count, tab_count)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (user_id) DO UPDATE SET
                    bookmark_count = sync_stats.bookmark_count + EXCLUDED.bookmark_count,
                    history_visit_count = sync_stats.history_visit_count + EXCLUDED.history_visit_count,
                    tab_count = sync_stats.tab_count + EXCLUDED.tab_count,
                    updated_at = now()
                "#,
                device.user_id,
                bookmark_delta,
                history_visit_delta,
                tab_delta
            )
            .execute(&mut *tx)
            .await?;
        }

        // Persist the advanced `last_seq` back onto `devices` (see
        // migration `0009_devices_last_sequence.sql`) so the next batch's
        // read at the top of this function sees it, without ever having to
        // fall back to scanning `sync_operations` again. A plain assignment
        // (not `GREATEST`) is correct, not just simpler: the per-device
        // `pg_advisory_xact_lock` taken above is transaction-scoped and
        // held until `tx.commit()` below, so no concurrent upload from this
        // same device can be interleaved between the read of
        // `last_device_sequence` at the top of this function and this write
        // — `last_seq` was always computed forward from the exact value
        // this UPDATE is about to overwrite, never from a value some other
        // in-flight transaction could have since changed. Only reached when
        // `accepted_ops` is non-empty, i.e. `last_seq` strictly advanced at
        // least once in the validation loop above.
        sqlx::query!(
            "UPDATE devices SET last_device_sequence = $1 WHERE id = $2",
            last_seq,
            device.device_id
        )
        .execute(&mut *tx)
        .await?;
    }

    let max_duplicate_cursor = decisions
        .iter()
        .filter_map(|d| match d {
            Decision::Duplicate(c) => Some(*c),
            _ => None,
        })
        .max()
        .unwrap_or(0);
    server_cursor = server_cursor.max(max_duplicate_cursor);
    if server_cursor == 0 {
        server_cursor = current_cursor(&mut *tx, device.user_id).await?;
    }

    tx.commit().await?;

    let mut accepted = Vec::new();
    let mut duplicate = Vec::new();
    let mut rejected = Vec::new();
    for (op, decision) in ops.iter().zip(decisions.iter()) {
        match decision {
            Decision::Accept(_) => accepted.push(op.operation_id),
            Decision::Duplicate(_) => duplicate.push(op.operation_id),
            Decision::Rejected(reason) => rejected.push(UploadRejection {
                operation_id: op.operation_id,
                reason: reason.to_string(),
            }),
        }
    }

    Ok(BatchOutcome {
        accepted,
        duplicate,
        rejected,
        server_cursor,
    })
}

/// Generic over the sqlx executor so callers can pass either a pooled
/// connection directly (no transaction needed for a plain read) or a
/// transaction already in progress (to read a value consistent with other
/// work happening in that same transaction).
async fn current_cursor<'e, E>(executor: E, user_id: Uuid) -> AppResult<i64>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let cursor: Option<i64> = sqlx::query_scalar!(
        "SELECT cursor_value FROM sync_cursors WHERE user_id = $1 AND device_id IS NULL",
        user_id
    )
    .fetch_optional(executor)
    .await?;
    Ok(cursor.unwrap_or(0))
}

#[derive(Debug, Deserialize)]
pub struct DownloadQuery {
    cursor: Option<i64>,
    limit: Option<i64>,
}

async fn download(
    device: AuthenticatedDevice,
    State(state): State<AppState>,
    Query(q): Query<DownloadQuery>,
) -> AppResult<Json<DownloadResponse>> {
    enforce(
        &state.rate_limiter,
        SYNC_DOWNLOAD_LIMIT,
        &device.device_id.to_string(),
    )?;

    crate::devices::touch_last_seen_background(&state, device.device_id);

    let cursor = q.cursor.unwrap_or(0).max(0);
    let limit = q.limit.unwrap_or(DEFAULT_DOWNLOAD_LIMIT).clamp(1, MAX_DOWNLOAD_LIMIT);

    // Combines what used to be 3 separate round trips (MIN(server_cursor),
    // MAX(snapshot_cursor), and the cursor upsert) into 1, via a
    // data-modifying CTE. Recording the device's self-reported cursor is
    // always an accurate, monotonically safe fact about its own claimed
    // progress regardless of whether *this* request also happens to reject
    // it as `cursor_too_old` below, and a device told to resync via
    // snapshot anchors its next read at the fresh snapshot cursor anyway,
    // never depending on this value again. Monotonic safety was never about
    // *needing* to write on every call though — only about never writing
    // something smaller — so the `WHERE sync_cursors.cursor_value <
    // EXCLUDED.cursor_value` guard skips the write entirely when the
    // device's cursor hasn't advanced since its last poll (the common idle
    // case for periodic pollers), avoiding a dead-tuple UPDATE and a
    // pointless `updated_at` bump on every poll forever.
    //
    // That guard has a consequence for how the surrounding query must be
    // shaped: per Postgres semantics, when the `WHERE` condition is false
    // for a conflicting row, `DO UPDATE` behaves like `DO NOTHING` for that
    // row and `RETURNING` produces zero rows for it — i.e. the `upsert` CTE
    // itself yields zero rows on exactly the common "cursor unchanged"
    // case this guard targets. `FROM bounds, upsert` would be an implicit
    // inner/cross join, so a zero-row `upsert` would make the whole
    // `SELECT` return zero rows and `.fetch_one` would fail with
    // `RowNotFound` on every idle poll. `FROM bounds LEFT JOIN upsert ON
    // true` avoids this: `bounds` is a plain aggregate CTE that always
    // produces exactly one row, so the left join always yields exactly one
    // output row regardless of whether `upsert`'s conflict-resolution
    // fired. We only ever select `bounds.min_cursor, bounds.max_snapshot`
    // (never anything from `upsert`), so the left join's NULL-on-no-match
    // behavior for `upsert`'s side is irrelevant to the result. Do not
    // "simplify" this back to `FROM bounds, upsert` — that reintroduces the
    // `RowNotFound` bug on the idle-poll path.
    let bounds = sqlx::query!(
        r#"
        WITH bounds AS (
            SELECT
                (SELECT MIN(server_cursor) FROM sync_operations WHERE user_id = $1) AS min_cursor,
                (SELECT MAX(snapshot_cursor) FROM sync_snapshots WHERE user_id = $1) AS max_snapshot
        ),
        upsert AS (
            INSERT INTO sync_cursors (user_id, device_id, cursor_value)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id, device_id)
            DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = now()
            WHERE sync_cursors.cursor_value < EXCLUDED.cursor_value
            RETURNING 1 AS ok
        )
        SELECT bounds.min_cursor, bounds.max_snapshot
        FROM bounds
        LEFT JOIN upsert ON true
        "#,
        device.user_id,
        device.device_id,
        cursor
    )
    .fetch_one(&state.db)
    .await?;

    // docs/protocol.md §11: once `sync::compaction` has deleted operations
    // below a persisted snapshot's cursor, a device can only resume
    // incrementally from that cursor or later — anything older needs
    // snapshot resync (§10.3) first, since the raw rows it would need no
    // longer exist. `min_cursor - 1` alone (the pre-compaction check) isn't
    // sufficient once compaction exists: a lingering tombstone row held
    // past the boundary for its retention window (see `compaction.rs`)
    // would otherwise make `min_cursor` look older than it should, so the
    // floor is the *higher* of the two constraints. Unlike before,
    // `cursor == 0` is no longer unconditionally exempt — a brand-new
    // device that has never synced must also be forced through snapshot
    // resync if compaction has already run ahead of it, or it would
    // silently end up with an incomplete history and no error at all.
    let raw_floor = bounds.min_cursor.map(|m| m - 1).unwrap_or(0);
    let snapshot_floor = bounds.max_snapshot.unwrap_or(0);
    let floor_cursor = raw_floor.max(snapshot_floor);

    if cursor < floor_cursor {
        return Err(AppError::Conflict("cursor_too_old".into()));
    }

    let fetch_limit = limit + 1;
    let mut rows = sqlx::query_as!(
        OperationOut,
        r#"
        SELECT operation_id, device_id, device_sequence, lamport_timestamp, object_type,
               object_id, operation_type, encryption_version, payload, server_cursor, created_at
        FROM sync_operations
        WHERE user_id = $1 AND server_cursor > $2
        ORDER BY server_cursor ASC
        LIMIT $3
        "#,
        device.user_id,
        cursor,
        fetch_limit
    )
    .fetch_all(&state.db)
    .await?;

    let has_more = rows.len() as i64 > limit;
    if has_more {
        rows.truncate(limit as usize);
    }
    let next_cursor = rows.last().map(|r| r.server_cursor).unwrap_or(cursor);

    Ok(Json(DownloadResponse {
        operations: rows,
        next_cursor,
        has_more,
    }))
}

#[derive(sqlx::FromRow)]
struct SnapshotSourceRow {
    object_type: String,
    object_id: Uuid,
    operation_type: String,
    encryption_version: i32,
    payload: serde_json::Value,
    // Not projected into `combine_object`'s output — only carried through to
    // rebuild `OrderingKey` (docs/protocol.md §8.1) per-group in Rust after
    // fetch, since the query itself is no longer sorted that way (see
    // `compute_objects`).
    lamport_timestamp: i64,
    device_id: Uuid,
    operation_id: Uuid,
    // Carried into the resulting `SnapshotObject` (SRV-1) so a historyVisit
    // folded into a future base snapshot can still be re-evaluated against
    // `history_cutoff` on a later `compute_objects` call — see
    // `SnapshotObject::created_at`'s doc comment.
    created_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct SnapshotTombstoneRow {
    object_type: String,
    object_id: Uuid,
}

pub(super) const FIELD_MERGE_OBJECT_TYPES: &[&str] = &["bookmark", "bookmarkFolder"];

/// Combines a `bookmark`/`bookmarkFolder`'s prior merged state (`base`,
/// from a persisted `sync_snapshots` row — `None` if the object wasn't in
/// it) with a batch of newer operations (`new_ops_ascending`, already
/// sorted by [`super::conflict::OrderingKey`]) into its updated merged
/// state. This extends [`super::conflict::merge_bookmark_fields`] across a
/// snapshot boundary: `base` is itself the output of a prior merge, so
/// treating it as a synthetic first "operation" and merging the newer ops
/// on top produces the same result merging the *entire* unbounded history
/// would (docs/protocol.md §8.2) — which is what makes it safe for
/// `sync::compaction` to delete the underlying rows afterward.
///
/// Falls back to whole-object LWW (the newest operation's payload,
/// discarding `base` entirely) whenever any contributing payload is
/// encrypted, or the object type doesn't need field-level merge — same
/// rule as the original single-pass reduction this replaces.
fn combine_object(
    object_type: String,
    object_id: Uuid,
    base: Option<SnapshotObject>,
    new_ops_ascending: Vec<SnapshotSourceRow>,
) -> Option<SnapshotObject> {
    if new_ops_ascending.is_empty() {
        return base;
    }

    let new_all_plaintext = new_ops_ascending.iter().all(|op| op.encryption_version == 0);
    let base_plaintext = base.as_ref().map_or(true, |b| b.encryption_version == 0);

    if new_all_plaintext && base_plaintext && FIELD_MERGE_OBJECT_TYPES.contains(&object_type.as_str()) {
        let mut payloads: Vec<serde_json::Value> = Vec::with_capacity(new_ops_ascending.len() + 1);
        if let Some(b) = &base {
            payloads.push(b.payload.clone());
        }
        payloads.extend(new_ops_ascending.iter().map(|op| op.payload.clone()));
        if let Some(merged) = super::conflict::merge_bookmark_fields(&payloads) {
            // Field-merge object types (bookmark/bookmarkFolder) are never
            // subject to `history_cutoff` pruning, but `SnapshotObject`
            // still needs a `created_at` — the latest contributing
            // operation's upload time is the most meaningful value to carry
            // forward here.
            let created_at = new_ops_ascending
                .iter()
                .map(|op| op.created_at)
                .chain(base.as_ref().map(|b| b.created_at))
                .max()
                .expect("new_ops_ascending checked non-empty above");
            return Some(SnapshotObject {
                object_type,
                object_id,
                // Synthesized full current-state payload, equivalent in
                // shape to a `create` operation's payload — there is no
                // single originating operation for a merged record.
                operation_type: "create".to_string(),
                encryption_version: 0,
                payload: merged,
                created_at,
            });
        }
    }

    // Whole-object LWW fallback: `new_ops_ascending` is sorted ascending,
    // so the last element carries the highest §8.1 ordering key overall —
    // `base` is superseded wholly, same as it would be by any newer
    // whole-object-winning operation.
    let winner = new_ops_ascending
        .into_iter()
        .last()
        .expect("checked non-empty above");
    Some(SnapshotObject {
        object_type,
        object_id,
        operation_type: winner.operation_type,
        encryption_version: winner.encryption_version,
        payload: winner.payload,
        created_at: winner.created_at,
    })
}

/// Sorts one object's accumulated new-operation rows into `OrderingKey`
/// order and folds them into `objects` via [`combine_object`] — the unit of
/// work [`fold_new_rows_into_objects`] performs once per distinct
/// `(object_type, object_id)` group as it streams through `new_rows`
/// (SRV-3), so that a group's rows can be dropped from memory the instant
/// the next group starts rather than staying resident until every group
/// has been read.
fn flush_object_group(
    object_type: String,
    object_id: Uuid,
    mut ops: Vec<SnapshotSourceRow>,
    objects: &mut HashMap<(String, Uuid), SnapshotObject>,
) {
    // Rows arrive in `(object_type, object_id)` order (the query's `ORDER
    // BY` — see `compute_objects`), not `OrderingKey` order —
    // `combine_object` requires the latter (see its doc comment), so
    // restore it here, per object, before handing the group off.
    ops.sort_by_key(|row| super::conflict::OrderingKey {
        lamport_timestamp: row.lamport_timestamp,
        device_id: row.device_id,
        operation_id: row.operation_id,
    });
    let base_entry = objects.remove(&(object_type.clone(), object_id));
    if let Some(combined) = combine_object(object_type.clone(), object_id, base_entry, ops) {
        objects.insert((object_type, object_id), combined);
    }
}

/// Streams `rows` — already ordered by `(object_type, object_id)`, see the
/// `ORDER BY` on both `new_rows` queries in [`compute_objects`] — and folds
/// each group into `objects` via [`flush_object_group`] as soon as the next
/// group's first row arrives (SRV-3).
///
/// This is what makes `.fetch()` (a `Stream`) actually cheaper than
/// `.fetch_all()` (a `Vec`) here: naively streaming rows one at a time
/// without also reordering the query would still require buffering a
/// `HashMap<(String, Uuid), Vec<SnapshotSourceRow>>` of *every* group
/// before any of them could be merged, since `combine_object` needs a
/// group's rows together — no smaller in peak memory than the `Vec` it
/// replaced. Grouping the query itself means only the *current* group's
/// rows are ever buffered at once: peak memory is bounded by one object's
/// operation count since the last snapshot/compaction, not the account's
/// entire new-row count.
async fn fold_new_rows_into_objects(
    mut rows: impl futures::Stream<Item = Result<SnapshotSourceRow, sqlx::Error>> + Unpin,
    objects: &mut HashMap<(String, Uuid), SnapshotObject>,
) -> AppResult<()> {
    let mut current_key: Option<(String, Uuid)> = None;
    let mut group: Vec<SnapshotSourceRow> = Vec::new();

    while let Some(row) = rows.try_next().await? {
        let key = (row.object_type.clone(), row.object_id);
        if current_key.as_ref() != Some(&key) {
            if let Some((object_type, object_id)) = current_key.take() {
                flush_object_group(object_type, object_id, std::mem::take(&mut group), objects);
            }
            current_key = Some(key);
        }
        group.push(row);
    }
    if let Some((object_type, object_id)) = current_key {
        flush_object_group(object_type, object_id, group, objects);
    }
    Ok(())
}

/// Resolves the account's `history_retention` setting (docs stored/
/// validated in `sync::settings`, previously never enforced anywhere) into
/// a concrete cutoff instant for filtering out old `historyVisit`
/// operations, or `None` for "unlimited" / an unrecognized value / no
/// settings row at all — fail open toward keeping data rather than
/// deleting it under a guessed-at policy.
///
/// historyVisit payloads are end-to-end encrypted (docs/encryption.md), so
/// the server can never read a visit's own timestamp — retention is
/// necessarily measured from `sync_operations.created_at` (when the
/// operation was uploaded), not from when the visit actually happened. For
/// a device replaying a large history backfill, this means the retention
/// clock effectively starts at upload time rather than each visit's real
/// historical date.
///
/// This cutoff is applied twice in [`compute_objects`]: once via SQL against
/// raw `sync_operations` rows (the `new_rows` query), and once more in
/// memory (SRV-1) against `objects` after the base snapshot and `new_rows`
/// are merged — the latter is what lets a `historyVisit` already folded
/// into a previously persisted `sync_snapshots` row (an immutable object
/// type, so it can never reappear in `new_rows` to be re-filtered) still
/// converge to the configured retention window on every future call,
/// instead of remaining embedded in every snapshot forever.
pub(super) async fn history_retention_cutoff(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
) -> AppResult<Option<DateTime<Utc>>> {
    let retention: Option<String> = sqlx::query_scalar!(
        "SELECT history_retention FROM user_settings WHERE user_id = $1",
        user_id
    )
    .fetch_optional(&mut **tx)
    .await?;

    let days: i64 = match retention.as_deref() {
        Some("7d") => 7,
        Some("30d") => 30,
        Some("90d") => 90,
        Some("1y") => 365,
        _ => return Ok(None),
    };
    Ok(Some(Utc::now() - chrono::Duration::days(days)))
}

/// Serializes an object list the same way it's always been serialized
/// (`serde_json::to_vec`) and then gzip-compresses the result before it's
/// persisted into a `sync_snapshots` row (SRV-PERF-8) — for a large
/// account this is what keeps both the on-disk/TOAST size and the bytes
/// actually shipped over the wire on a `/snapshot` read a fraction of the
/// raw JSON size, instead of Postgres de-TOASTing (and this process
/// holding in memory) the full 30-50MB document on every compaction pass.
/// `Compression::default()` is a reasonable, well-documented middle
/// ground between compression ratio and CPU cost; there's no
/// account-observed reason yet to hand-tune it further.
pub(super) fn compress_snapshot_data(objects: &[SnapshotObject]) -> AppResult<Vec<u8>> {
    use std::io::Write;

    let json = serde_json::to_vec(objects).map_err(anyhow::Error::from)?;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&json).map_err(anyhow::Error::from)?;
    Ok(encoder.finish().map_err(anyhow::Error::from)?)
}

/// Inverse of [`compress_snapshot_data`]. Must handle two on-disk formats
/// (SRV-PERF-8): migration `0008_compress_sync_snapshots.sql` converted
/// every *existing* `sync_snapshots.data` row from JSONB to BYTEA by
/// taking its plain UTF8 JSON text bytes — it could not gzip them, since a
/// raw SQL migration has no way to invoke the application's compressor.
/// Every row `sync::compaction` writes *after* this deploys, on the other
/// hand, is gzip-compressed via `compress_snapshot_data` above. So a row
/// read here could legitimately be either format, and there is no schema
/// flag distinguishing them.
///
/// The two are told apart by simply trying gzip first: a gzip stream
/// always starts with the 2-byte magic header `0x1f 0x8b`, while a plain
/// JSON-text row always starts with `{` or `[` (`0x7b`/`0x5b`) — nothing
/// else `serde_json::to_vec` ever emits as the first byte of an object
/// list. Those byte ranges never overlap, so a plain-JSON row reliably
/// fails gzip decoding immediately (bad header) rather than silently
/// decoding as garbage, and falling back to UTF8 JSON parsing on that
/// failure is always correct. A future cleanup could force a recompaction
/// pass for every account (which naturally rewrites every row through
/// `compress_snapshot_data`) and then delete this fallback entirely, but
/// that's out of scope here.
pub(super) fn decompress_snapshot_data(bytes: &[u8]) -> AppResult<Vec<SnapshotObject>> {
    use std::io::Read;

    // Capped at one more byte than the limit (rather than exactly the
    // limit) so the two cases below are distinguishable: reading fewer
    // than `MAX_DECOMPRESSED_SNAPSHOT_BYTES + 1` bytes means the stream
    // genuinely ended within budget, while reading exactly that many means
    // there was more data past the cap that `Take` simply stopped handing
    // over — `Take` truncates silently and never surfaces an error of its
    // own, so this is the only way to tell "fit exactly" apart from
    // "would have kept going".
    let mut decoder =
        flate2::read::GzDecoder::new(bytes).take(MAX_DECOMPRESSED_SNAPSHOT_BYTES + 1);
    let mut json = Vec::new();
    let parsed: Vec<SnapshotObject> = match decoder.read_to_end(&mut json) {
        Ok(_) if json.len() as u64 > MAX_DECOMPRESSED_SNAPSHOT_BYTES => {
            return Err(anyhow::anyhow!(
                "snapshot data decompresses to more than {MAX_DECOMPRESSED_SNAPSHOT_BYTES} bytes"
            )
            .into());
        }
        Ok(_) => serde_json::from_slice(&json).map_err(anyhow::Error::from)?,
        Err(_) => {
            // Not a gzip stream (or a truncated/corrupt one) — fall back to
            // treating the bytes as plain UTF8 JSON, the pre-migration
            // format. See the doc comment above for why this is safe.
            serde_json::from_slice(bytes).map_err(anyhow::Error::from)?
        }
    };
    Ok(parsed)
}

#[cfg(test)]
mod decompress_snapshot_data_tests {
    use super::*;

    fn sample_objects(count: usize) -> Vec<SnapshotObject> {
        (0..count)
            .map(|i| SnapshotObject {
                object_type: "note".to_string(),
                object_id: Uuid::new_v4(),
                operation_type: "upsert".to_string(),
                encryption_version: 1,
                payload: serde_json::json!({ "index": i, "body": "hello world" }),
                created_at: Utc::now(),
            })
            .collect()
    }

    #[test]
    fn round_trips_a_normal_sized_payload() {
        let objects = sample_objects(50);
        let compressed = compress_snapshot_data(&objects).expect("compression should succeed");
        let decompressed =
            decompress_snapshot_data(&compressed).expect("decompression should succeed");
        assert_eq!(decompressed.len(), objects.len());
        assert_eq!(decompressed[0].object_type, "note");
    }

    #[test]
    fn rejects_a_payload_that_decompresses_past_the_cap() {
        // A gzip stream of highly repetitive bytes compresses to a tiny
        // fraction of its inflated size, so a small buffer here is enough
        // to blow well past `MAX_DECOMPRESSED_SNAPSHOT_BYTES` once
        // decoded — exactly the "zip bomb" shape the cap defends against.
        use std::io::Read as _;
        let oversized_len = MAX_DECOMPRESSED_SNAPSHOT_BYTES + 1024;
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::copy(&mut std::io::repeat(b'a').take(oversized_len), &mut encoder)
            .expect("streaming into the encoder should succeed");
        let compressed = encoder.finish().expect("gzip finish should succeed");

        let result = decompress_snapshot_data(&compressed);
        assert!(
            result.is_err(),
            "decompressing past the cap should be rejected, not silently truncated"
        );
    }
}

/// Computes the merged current state of every object as of `ceiling` (or
/// "now" when `None`), reusing the latest persisted `sync_snapshots` row
/// at or below the ceiling as a base and layering newer operations on top
/// via [`combine_object`] — rather than re-reducing each object's *entire*
/// history from raw operations every time. This is what lets
/// `sync::compaction` safely delete old operation rows: any later call
/// with a ceiling at or above the compacted boundary gets the same answer
/// from the persisted base alone, with no dependency on the deleted rows.
///
/// `history_cutoff` (see [`history_retention_cutoff`]) additionally
/// excludes `historyVisit` operations uploaded before that instant from
/// the `new_rows` this fold layers on top of the base — pass `None` to
/// disable that filtering entirely.
///
/// Returns `(resolved_cursor, objects_by_key)`. Tombstone filtering is the
/// caller's responsibility — both callers (the `/snapshot` route and
/// `sync::compaction`) pair this with a fresh read of the `tombstones`
/// table, which compaction never deletes from, so it's never stale.
pub(super) async fn compute_objects(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    ceiling: Option<i64>,
    history_cutoff: Option<DateTime<Utc>>,
) -> AppResult<(i64, HashMap<(String, Uuid), SnapshotObject>)> {
    let base_row: Option<(i64, Vec<u8>)> = match ceiling {
        Some(c) => sqlx::query!(
            "SELECT snapshot_cursor, data FROM sync_snapshots \
             WHERE user_id = $1 AND snapshot_cursor <= $2 ORDER BY snapshot_cursor DESC LIMIT 1",
            user_id,
            c
        )
        .fetch_optional(&mut **tx)
        .await?
        .map(|r| (r.snapshot_cursor, r.data)),
        None => sqlx::query!(
            "SELECT snapshot_cursor, data FROM sync_snapshots \
             WHERE user_id = $1 ORDER BY snapshot_cursor DESC LIMIT 1",
            user_id
        )
        .fetch_optional(&mut **tx)
        .await?
        .map(|r| (r.snapshot_cursor, r.data)),
    };

    let (base_cursor, mut objects): (i64, HashMap<(String, Uuid), SnapshotObject>) = match base_row {
        Some((cursor, data)) => {
            let parsed: Vec<SnapshotObject> = decompress_snapshot_data(&data)?;
            let map = parsed
                .into_iter()
                .map(|o| ((o.object_type.clone(), o.object_id), o))
                .collect();
            (cursor, map)
        }
        None => (0, HashMap::new()),
    };

    let max_op_cursor: i64 = match ceiling {
        Some(c) => sqlx::query_scalar!(
            r#"SELECT COALESCE(MAX(server_cursor), 0) as "c!" FROM sync_operations WHERE user_id = $1 AND server_cursor <= $2"#,
            user_id,
            c
        )
        .fetch_one(&mut **tx)
        .await?,
        None => sqlx::query_scalar!(
            r#"SELECT COALESCE(MAX(server_cursor), 0) as "c!" FROM sync_operations WHERE user_id = $1"#,
            user_id
        )
        .fetch_one(&mut **tx)
        .await?,
    };
    let resolved_cursor = base_cursor.max(max_op_cursor);

    // The `object_type <> 'historyVisit' OR ...` clause only ever filters
    // historyVisit rows (docs/protocol.md §6: every other object type goes
    // through the field-merge/whole-object-LWW path above regardless of
    // age) and is a no-op when `history_cutoff` is None ("unlimited"
    // retention or no settings row — see `history_retention_cutoff`).
    //
    // SRV-3: for an active account (or right after a large initial client
    // backfill), this can be tens of thousands of rows — including full
    // JSONB `payload` blobs — so the rows are streamed via `.fetch()`
    // rather than materialized into a `Vec` with `.fetch_all()`.
    // `combine_object` still needs *all* of a given object's new operations
    // together (see [`fold_new_rows_into_objects`]), so `ORDER BY
    // object_type, object_id` (not `server_cursor`) is what makes streaming
    // actually reduce peak memory rather than just avoiding one Vec
    // allocation: it groups every row for the same object contiguously, so
    // `fold_new_rows_into_objects` only ever needs to buffer the *current*
    // group before merging it into `objects` and moving on — bounded by one
    // object's operation count since the last snapshot/compaction, not the
    // whole account's new-row count. The existing `idx_sync_operations_object
    // (user_id, object_type, object_id)` index satisfies this ordering as a
    // plain index scan (server_cursor range/`history_cutoff` are applied as
    // a filter during the scan), so this needs no new index and no
    // in-database sort. Per-object `OrderingKey` order (which
    // `combine_object` actually requires) is unrelated to this SQL
    // ordering and is restored separately, per group, in
    // `flush_object_group`. `resolved_cursor` above is computed from a
    // `MAX(server_cursor)` aggregate, independent of this query's row
    // order, so reordering it doesn't affect that.
    match ceiling {
        Some(c) => {
            let rows = sqlx::query_as!(
                SnapshotSourceRow,
                r#"
                SELECT object_type, object_id, operation_type, encryption_version, payload,
                       lamport_timestamp, device_id, operation_id, created_at
                FROM sync_operations
                WHERE user_id = $1 AND server_cursor > $2 AND server_cursor <= $3
                  AND (object_type <> 'historyVisit' OR $4::timestamptz IS NULL OR created_at >= $4::timestamptz)
                ORDER BY object_type ASC, object_id ASC
                "#,
                user_id,
                base_cursor,
                c,
                history_cutoff
            )
            .fetch(&mut **tx);
            fold_new_rows_into_objects(rows, &mut objects).await?;
        }
        None => {
            let rows = sqlx::query_as!(
                SnapshotSourceRow,
                r#"
                SELECT object_type, object_id, operation_type, encryption_version, payload,
                       lamport_timestamp, device_id, operation_id, created_at
                FROM sync_operations
                WHERE user_id = $1 AND server_cursor > $2
                  AND (object_type <> 'historyVisit' OR $3::timestamptz IS NULL OR created_at >= $3::timestamptz)
                ORDER BY object_type ASC, object_id ASC
                "#,
                user_id,
                base_cursor,
                history_cutoff
            )
            .fetch(&mut **tx);
            fold_new_rows_into_objects(rows, &mut objects).await?;
        }
    }

    // SRV-1: the `new_rows` query's `history_cutoff` filter above only ever
    // excludes historyVisit operations still sitting in `sync_operations` —
    // it can't do anything about a historyVisit that was already folded
    // into `base_row` by an earlier snapshot/compaction pass. historyVisit
    // is immutable (never produces a second operation once created), so
    // such an object can never reappear in `new_rows` to be re-filtered;
    // without this pass it would stay embedded in `objects` — and therefore
    // in every snapshot derived from it — forever, no matter how far past
    // `history_cutoff` it falls. `SnapshotObject::created_at` (added for
    // this) is what makes re-evaluating it here possible.
    //
    // Deliberately run *after* the `new_rows` merge above, not before: a
    // historyVisit still within the retention window needs the chance to
    // combine with any newer op first, rather than being evaluated (and
    // potentially removed pre-merge) against a stale `created_at`.
    if let Some(cutoff) = history_cutoff {
        objects.retain(|_, obj| obj.object_type != "historyVisit" || obj.created_at >= cutoff);
    }

    Ok((resolved_cursor, objects))
}

/// Computes an on-demand, point-in-time-consistent snapshot per
/// docs/protocol.md §10.3, via [`compute_objects`].
async fn snapshot(
    device: AuthenticatedDevice,
    State(state): State<AppState>,
) -> AppResult<Json<SnapshotResponse>> {
    enforce(
        &state.rate_limiter,
        SYNC_SNAPSHOT_LIMIT,
        &device.device_id.to_string(),
    )?;

    crate::devices::touch_last_seen_background(&state, device.device_id);

    let mut tx = state.db.begin().await?;

    let history_cutoff = history_retention_cutoff(&mut tx, device.user_id).await?;
    let (snapshot_cursor, objects_map) =
        compute_objects(&mut tx, device.user_id, None, history_cutoff).await?;

    let tombstone_rows = sqlx::query_as!(
        SnapshotTombstoneRow,
        "SELECT object_type, object_id FROM tombstones WHERE user_id = $1 AND active = true",
        device.user_id
    )
    .fetch_all(&mut *tx)
    .await?;

    tx.commit().await?;

    let tombstone_ids: HashSet<(String, Uuid)> = tombstone_rows
        .iter()
        .map(|t| (t.object_type.clone(), t.object_id))
        .collect();

    let objects = filter_tombstoned(objects_map, &tombstone_ids);

    let tombstones = tombstone_rows
        .into_iter()
        .map(|t| SnapshotTombstone {
            object_type: t.object_type,
            object_id: t.object_id,
        })
        .collect();

    Ok(Json(SnapshotResponse {
        snapshot_cursor,
        objects,
        tombstones,
    }))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncStats {
    bookmarks: i64,
    history_visits: i64,
    tabs: i64,
}

// A short TTL cache collapses repeated dashboard polls within the window
// into one actual query, the same tradeoff the extension's own settings
// cache (extension/src/api/client.ts) already makes for a similarly
// "rarely changes, never needs sub-minute freshness" endpoint. Keyed by
// user_id and never swept: bounded by the number of distinct users who have
// ever called this, not by how much sync data they have, so it carries
// none of the unbounded-growth risk a per-request or per-operation cache
// would.
static STATS_CACHE: LazyLock<DashMap<Uuid, (Instant, SyncStats)>> = LazyLock::new(DashMap::new);
const STATS_CACHE_TTL: Duration = Duration::from_secs(30);

/// Item counts for the web dashboard's "what's synced" summary. Backed by
/// the `sync_stats` table (migrations/0007_sync_stats.sql) rather than
/// deriving counts from the snapshot blob on every cache miss:
/// `compute_objects` deserializes an account's *entire* live object set
/// (potentially 50,000+ bookmarks/tabs/historyVisits, each carrying a full
/// encrypted payload) purely to produce three integers — that used to be
/// paid on every 30-second `STATS_CACHE` miss, the same full-blob parse
/// `sync::compaction` pays hourly, but on a dashboard endpoint the web UI
/// can poll/refresh repeatedly.
///
/// `sync_stats` is kept fresh by `sync::routes::process_batch` (incremental
/// per-batch deltas) and reconciled authoritatively by
/// `sync::compaction::compact_user` on every snapshot it persists — see the
/// migration's doc comment for the full three-part design. If neither has
/// ever run for this user (a brand new account, or one that predates this
/// table and hasn't synced or been compacted since upgrading), no row
/// exists yet: fall back to the exact old `compute_objects`-based
/// computation exactly once, and persist the result so every subsequent
/// request for this user takes the fast path from then on.
async fn stats(
    user: AnyAuthenticatedUser,
    State(state): State<AppState>,
) -> AppResult<Json<SyncStats>> {
    if let Some(cached) = STATS_CACHE.get(&user.user_id) {
        if cached.0.elapsed() < STATS_CACHE_TTL {
            return Ok(Json(cached.1.clone()));
        }
    }

    enforce(&state.rate_limiter, SYNC_STATS_LIMIT, &user.user_id.to_string())?;

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
            // Lazy backfill path — see doc comment above. Unchanged from
            // the original always-on computation, plus the trailing
            // `INSERT ... ON CONFLICT DO NOTHING` that makes this a
            // one-time-ever cost per account instead of a recurring one
            // every 30-second cache miss.
            let history_cutoff = history_retention_cutoff(&mut tx, user.user_id).await?;
            let (_, objects_map) =
                compute_objects(&mut tx, user.user_id, None, history_cutoff).await?;

            let tombstone_ids: HashSet<(String, Uuid)> = sqlx::query!(
                "SELECT object_type, object_id FROM tombstones WHERE user_id = $1 AND active = true",
                user.user_id
            )
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(|t| (t.object_type, t.object_id))
            .collect();

            let mut stats = SyncStats {
                bookmarks: 0,
                history_visits: 0,
                tabs: 0,
            };
            for (object_type, object_id) in objects_map.keys() {
                if tombstone_ids.contains(&(object_type.clone(), *object_id)) {
                    continue;
                }
                match object_type.as_str() {
                    "bookmark" | "bookmarkFolder" => stats.bookmarks += 1,
                    "historyVisit" => stats.history_visits += 1,
                    "tab" => stats.tabs += 1,
                    _ => {}
                }
            }

            sqlx::query!(
                r#"
                INSERT INTO sync_stats (user_id, bookmark_count, history_visit_count, tab_count)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (user_id) DO NOTHING
                "#,
                user.user_id,
                stats.bookmarks as i32,
                stats.history_visits as i32,
                stats.tabs as i32
            )
            .execute(&mut *tx)
            .await?;

            tx.commit().await?;
            stats
        }
    };

    STATS_CACHE.insert(user.user_id, (Instant::now(), stats.clone()));

    Ok(Json(stats))
}

/// Given a fully-computed object map (from [`compute_objects`]) and the
/// user's currently-active tombstone ids, returns the live (non-tombstoned)
/// objects only — this is exactly the shape persisted into a new
/// `sync_snapshots` row by `sync::compaction`, and is also reused by the
/// `/snapshot` route above.
pub(super) fn filter_tombstoned(
    objects_map: HashMap<(String, Uuid), SnapshotObject>,
    tombstone_ids: &HashSet<(String, Uuid)>,
) -> Vec<SnapshotObject> {
    objects_map
        .into_iter()
        .filter(|(key, _)| !tombstone_ids.contains(key))
        .map(|(_, o)| o)
        .collect()
}
