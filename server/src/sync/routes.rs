use std::collections::{HashMap, HashSet};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Timelike, Utc};
use serde::Deserialize;
use tower::limit::ConcurrencyLimitLayer;
use uuid::Uuid;

use crate::auth::model::AuthenticatedDevice;
use crate::error::{AppError, AppResult};
use crate::middleware::rate_limit::{
    enforce, SYNC_DOWNLOAD_LIMIT, SYNC_SNAPSHOT_LIMIT, SYNC_UPLOAD_LIMIT,
};
use crate::state::AppState;

use super::model::{
    DownloadResponse, OperationIn, OperationOut, SnapshotResponse, SnapshotTombstone,
    UploadRejection, UploadRequest, UploadResponse,
};
use super::snapshot::{compute_objects, filter_tombstoned, history_retention_cutoff};
use super::stats::lock_user_stats;
use super::vocabulary;

const MAX_OPERATIONS_PER_BATCH: usize = 500;
const MAX_PAYLOAD_BYTES: usize = 256 * 1024;
/// Payload cap for a historyVisit/bulkImport op (docs/protocol.md §8.3). One
/// op carries many encrypted visit segments that the server can't inspect.
const MAX_BULK_HISTORY_PAYLOAD_BYTES: usize = 96 * 1024 * 1024;
/// Max `visitCount` on one `bulkImport` op. A sanity bound so one op can't
/// inflate the history count by an absurd amount.
const MAX_VISIT_COUNT_PER_OP: i64 = 1_000_000;
/// Ceiling on `visitHours`' entry count per op (docs/protocol.md §8.3.2) —
/// a `bulkImport` chunk spans at most `BULK_SEGMENT_VISITS`-scale visits
/// (extension/src/history/bulk.ts) collected within one import window, so
/// even a chunk spanning years of hourly buckets stays far under this; it
/// exists only as a sanity bound against a malformed or hostile payload.
const MAX_VISIT_HOURS_ENTRIES: usize = 100_000;
const DEFAULT_DOWNLOAD_LIMIT: i64 = 500;
const MAX_DOWNLOAD_LIMIT: i64 = 1000;
/// Max payload bytes per `/changes` page, on top of the row limit. A page
/// always has at least one row, so paging never gets stuck.
const MAX_DOWNLOAD_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
/// Max `/snapshot` builds running at once across the process. Each loads a
/// whole account into memory, and the per-device rate limit doesn't cap the total.
pub const SNAPSHOT_CONCURRENCY_LIMIT: usize = 8;
pub const PROTOCOL_VERSION_HEADER: &str = "x-protocol-version";

/// Body limit for `/operations`. Axum's 2MB default is far below what a full
/// batch may be (500 ops x 256KB), so large batches failed with no clear
/// reason. Sized to that max plus JSON overhead.
const MAX_UPLOAD_BODY_BYTES: usize = MAX_OPERATIONS_PER_BATCH * MAX_PAYLOAD_BYTES + 1024 * 1024;

/// Max `/operations` requests read at once, across all users. Caps memory
/// at `MAX_CONCURRENT_UPLOADS * MAX_UPLOAD_BODY_BYTES`; extra requests wait.
const MAX_CONCURRENT_UPLOADS: usize = 16;

/// Clients below the minimum protocol version can't write, but can still
/// read (docs/protocol.md §13). The header is optional for now.
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
    // Only this route gets the large body limit; the rest keep 2MB.
    let upload_route = Router::new()
        .route("/operations", post(upload))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BODY_BYTES))
        // Added last so it runs first, before any body bytes are read.
        .layer(ConcurrencyLimitLayer::new(MAX_CONCURRENT_UPLOADS));

    Router::new()
        .merge(upload_route)
        .route("/changes", get(download))
        .route("/snapshot", get(snapshot))
        .route("/stats", get(super::stats::stats))
        .nest("/settings", super::settings::router())
}

async fn upload(
    device: AuthenticatedDevice,
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Json<UploadResponse>> {
    reject_if_protocol_too_old(&headers, &state)?;

    // Rate limit before parsing JSON, which is the costly part. `Bytes` only
    // buffers the raw body.
    enforce(
        &state.rate_limiter,
        SYNC_UPLOAD_LIMIT,
        &device.device_id.to_string(),
    )?;

    let mut req: UploadRequest = serde_json::from_slice(&body)
        .map_err(|e| AppError::Validation(format!("invalid request body: {e}")))?;

    if req.operations.len() > MAX_OPERATIONS_PER_BATCH {
        return Err(AppError::Validation(format!(
            "too many operations in one batch (max {MAX_OPERATIONS_PER_BATCH})"
        )));
    }

    crate::devices::touch_last_seen_background(&state, device.device_id);

    let outcome = process_batch(&state, &device, &mut req.operations).await?;

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

/// Outcome for each op after validation. `Accept` stores an index instead of
/// a reference so the write loop can mutate the op.
enum Decision {
    Duplicate,
    Rejected(&'static str),
    Accept(usize),
}

/// A `Write` sink that only counts bytes, to measure JSON size without allocating.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
struct ByteCounter(usize);

impl std::io::Write for ByteCounter {
    #[inline]
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }

    #[inline]
    fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        self.0 += buf.len();
        Ok(())
    }

    #[inline]
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Checks one op's shape: vocabulary, encryption, payload size, and the
/// `visitCount`/`visitHours` fields (docs/protocol.md §6, §8.3, §8.3.2).
/// Uses no DB or batch state, so `process_batch` runs it after the
/// duplicate checks and before the sequence and ownership checks. Returns
/// the rejection reason.
fn check_op_shape(op: &OperationIn, require_encryption: bool) -> Result<(), &'static str> {
    if !vocabulary::is_known_object_type(&op.object_type) {
        return Err("unknown_object_type");
    }
    if !vocabulary::allowed_operation_types(&op.object_type).contains(&op.operation_type.as_str()) {
        return Err("unknown_operation_type");
    }
    if op.encryption_version < 0 {
        return Err("invalid_encryption_version");
    }
    if op.encryption_version == 0 && require_encryption {
        return Err("encryption_required");
    }
    let mut counter = ByteCounter(0);
    let payload_size = serde_json::to_writer(&mut counter, &op.payload)
        .map(|()| counter.0)
        .unwrap_or(0);
    let is_bulk_history = op.is_bulk_history_import();
    let payload_cap = if is_bulk_history {
        MAX_BULK_HISTORY_PAYLOAD_BYTES
    } else {
        MAX_PAYLOAD_BYTES
    };
    if payload_size > payload_cap {
        return Err("payload_too_large");
    }
    // bulkImport needs visitCount >= 1; other ops may not set it
    // (docs/protocol.md §8.3). The segments themselves are opaque.
    if is_bulk_history {
        match op.visit_count {
            Some(n) if (1..=MAX_VISIT_COUNT_PER_OP).contains(&n) => {}
            Some(n) if n >= 1 => return Err("visit_count_too_large"),
            _ => return Err("bulk_import_missing_count"),
        }
    } else if op.visit_count.is_some() {
        return Err("unexpected_visit_count");
    }
    // Hourly visit-count buckets (docs/protocol.md §8.3.2): `visitHours`
    // is legal only on `historyVisit` ops, and its shape depends on
    // whether this op is a `bulkImport` chunk (entries must sum to
    // `visitCount`, already validated `Some(1..=MAX_VISIT_COUNT_PER_OP)`
    // above) or a single `visit` (exactly one entry, value 1 — a live
    // visit is always exactly one visit in exactly one hour). Checked
    // alongside the `visitCount` checks above, in the same reject-early
    // style, so a malformed histogram never reaches `process_batch`'s
    // write path.
    if op.object_type != "historyVisit" {
        if op.visit_hours.is_some() {
            return Err("unexpected_visit_hours");
        }
    } else if let Some(hours) = &op.visit_hours {
        if hours.len() > MAX_VISIT_HOURS_ENTRIES {
            return Err("invalid_visit_hours");
        }
        let future_ceiling = Utc::now() + chrono::Duration::days(1);
        let all_valid = hours.iter().all(|(hour, count)| {
            hour.minute() == 0
                && hour.second() == 0
                && hour.nanosecond() == 0
                && *hour <= future_ceiling
                && *count >= 1
        });
        if !all_valid {
            return Err("invalid_visit_hours");
        }
        let sum: i64 = hours.values().sum();
        let mismatch = match op.operation_type.as_str() {
            "bulkImport" => Some(sum) != op.visit_count,
            "visit" => hours.len() != 1 || sum != 1,
            _ => false,
        };
        if mismatch {
            return Err("visit_hours_mismatch");
        }
    }
    Ok(())
}

/// Validates and saves a whole upload batch in one transaction. All ops come
/// from one device, so the lock, sequence check, and cursor allocation run
/// once per batch instead of once per op.
async fn process_batch(
    state: &AppState,
    device: &AuthenticatedDevice,
    ops: &mut [OperationIn],
) -> AppResult<BatchOutcome> {
    if ops.is_empty() {
        // Empty batch: just return the current cursor, no transaction needed.
        let cursor = current_cursor(&state.db, device.user_id).await?;
        return Ok(BatchOutcome {
            accepted: vec![],
            duplicate: vec![],
            rejected: vec![],
            server_cursor: cursor,
        });
    }

    // One upload at a time per device, waited for before taking a DB
    // connection. Otherwise waiting uploads could hold every pool connection.
    let upload_semaphore = state
        .upload_locks
        .entry(device.device_id)
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1)))
        .clone();
    // Don't wait forever; waiting requests hold their body in memory.
    let acquire_timeout = Duration::from_secs(state.config.upload_semaphore_acquire_timeout_secs);
    let _upload_permit =
        match tokio::time::timeout(acquire_timeout, upload_semaphore.acquire_owned()).await {
            Ok(permit) => permit.expect("upload semaphore is never closed"),
            Err(_) => {
                tracing::warn!(
                    device_id = %device.device_id,
                    timeout = ?acquire_timeout,
                    "upload semaphore acquire timed out, rejecting batch"
                );
                return Err(AppError::Busy);
            }
        };

    let mut tx = state.db.begin().await?;

    // Backup for a future multi-process setup. The semaphore above already
    // serializes uploads in one process.
    sqlx::query!(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        device.device_id.to_string()
    )
    .execute(&mut *tx)
    .await?;

    // One dedup query for the whole batch.
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

    // Use `devices.last_device_sequence`, not `MAX(device_sequence)` from
    // `sync_operations`: compaction deletes those rows, which would let old
    // sequence numbers be reused. Safe under the advisory lock above.
    let mut last_seq: i64 = sqlx::query_scalar!(
        "SELECT last_device_sequence FROM devices WHERE id = $1",
        device.device_id
    )
    .fetch_one(&mut *tx)
    .await?;
    // The sequence before this batch. Used to tell a replay of an earlier
    // batch (duplicate) from ops that are out of order within this batch
    // (docs/protocol.md §10.2).
    let persisted_last_seq = last_seq;

    // Per-user setting to require encryption, even if the server doesn't.
    // Missing row means not required.
    let user_require_encryption: bool = sqlx::query_scalar!(
        "SELECT require_encryption FROM user_settings WHERE user_id = $1",
        device.user_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .unwrap_or(false);

    // One query to check that every object referenced by a non-create op
    // exists. Objects created earlier in this batch are tracked in
    // `originated_in_batch` instead.
    //
    // Uses `sync_objects`, which compaction never prunes. `sync_operations`
    // loses its `create` rows to compaction, so it can't be used here.
    let mut lookup_types: Vec<String> = Vec::new();
    let mut lookup_ids: Vec<Uuid> = Vec::new();
    for op in ops.iter() {
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

    // Permanent dedup for bulk history imports (docs/protocol.md §8.3): a
    // `historyVisit`/`bulkImport` op whose `object_id` was ever accepted
    // must read as `Duplicate` forever, even after `sync::compaction` has
    // deleted its `sync_operations` row (so it no longer matches `existing`
    // above) and even if the client reserves a *fresh* `device_sequence` for
    // the retry (so the sequence-replay check below doesn't catch it
    // either). `sync_objects` is the right table to check against: unlike
    // `sync_operations`, it is never pruned by compaction (migration
    // `0006_sync_objects.sql`), and §3 of the fix backfills/maintains a
    // `historyVisit` row per accepted bulk object there specifically so this
    // lookup has something to find. Only bulk ops are looked up — a
    // single-visit `historyVisit`/`visit` op is intentionally cheap to
    // replay (see the ledger-insert filter below) and has no ledger row to
    // match against.
    let mut bulk_lookup_ids: Vec<Uuid> = Vec::new();
    for op in ops.iter() {
        if existing.contains_key(&op.operation_id) {
            continue;
        }
        if op.is_bulk_history_import() {
            bulk_lookup_ids.push(op.object_id);
        }
    }
    let known_bulk: HashSet<Uuid> = if bulk_lookup_ids.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar!(
            r#"
            SELECT object_id FROM sync_objects
            WHERE user_id = $1 AND object_type = 'historyVisit' AND object_id = ANY($2)
            "#,
            device.user_id,
            &bulk_lookup_ids
        )
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect()
    };

    // Validation pass, in memory only. `last_seq` and `originated_in_batch`
    // update as we go, so later ops see earlier ones in the same batch.
    let require_encryption = state.config.require_encryption || user_require_encryption;
    let mut decisions: Vec<Decision> = Vec::with_capacity(ops.len());
    let mut originated_in_batch: HashSet<(String, Uuid)> = HashSet::new();

    for (op_index, op) in ops.iter().enumerate() {
        if existing.contains_key(&op.operation_id) {
            decisions.push(Decision::Duplicate);
            continue;
        }
        // Bulk history permanent dedup (see `known_bulk` above): checked
        // before every other validation, including the device-sequence
        // checks below, so a retry that reserved a fresh `device_sequence`
        // still reads as `Duplicate` instead of `Accept`. Also matches
        // against `originated_in_batch`, which by the time this op is
        // reached already holds every bulk object *this same batch* has
        // accepted (a batch resending the same chunk twice, however
        // unlikely, must not double-accept it either).
        if op.is_bulk_history_import()
            && (known_bulk.contains(&op.object_id)
                || originated_in_batch.contains(&(op.object_type.clone(), op.object_id)))
        {
            decisions.push(Decision::Duplicate);
            continue;
        }
        if let Err(reason) = check_op_shape(op, require_encryption) {
            decisions.push(Decision::Rejected(reason));
            continue;
        }
        if op.device_sequence < 1 {
            decisions.push(Decision::Rejected("invalid_device_sequence"));
            continue;
        }
        if op.device_sequence <= last_seq {
            // At or below the pre-batch sequence: this op was already
            // accepted, so report `Duplicate`. Sequences are never reused
            // (docs/protocol.md §4.1), so this holds even if compaction has
            // deleted the original row.
            //
            // Otherwise it's only out of order within this batch, which is
            // a client bug: reject with `sequence_out_of_order`.
            if op.device_sequence <= persisted_last_seq {
                decisions.push(Decision::Duplicate);
            } else {
                decisions.push(Decision::Rejected("sequence_out_of_order"));
            }
            continue;
        }

        let is_origination =
            vocabulary::is_origination_operation(&op.object_type, &op.operation_type);
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
        decisions.push(Decision::Accept(op_index));
    }

    let accepted_indices: Vec<usize> = decisions
        .iter()
        .filter_map(|d| match d {
            Decision::Accept(i) => Some(*i),
            _ => None,
        })
        .collect();

    let mut server_cursor = 0i64;

    if !accepted_indices.is_empty() {
        // Reserve a block of cursors for all accepted ops in one update.
        // The row lock serializes this with uploads from the user's other devices.
        let count = accepted_indices.len() as i64;
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

        let mut operation_ids = Vec::with_capacity(accepted_indices.len());
        let mut device_sequences = Vec::with_capacity(accepted_indices.len());
        let mut lamport_timestamps = Vec::with_capacity(accepted_indices.len());
        let mut cursors = Vec::with_capacity(accepted_indices.len());
        let mut object_types = Vec::with_capacity(accepted_indices.len());
        let mut object_ids = Vec::with_capacity(accepted_indices.len());
        let mut operation_types = Vec::with_capacity(accepted_indices.len());
        let mut encryption_versions = Vec::with_capacity(accepted_indices.len());
        let mut payloads = Vec::with_capacity(accepted_indices.len());
        let mut visit_counts: Vec<Option<i32>> = Vec::with_capacity(accepted_indices.len());

        // One entry per object: a single upsert can't touch the same
        // tombstone row twice, so keep the last (highest-cursor) op.
        let mut tombstones: HashMap<(String, Uuid), (i64, i64, Uuid)> = HashMap::new();
        let mut restores: HashSet<(String, Uuid)> = HashSet::new();
        // Objects created in this batch, deduped. The value is the visit
        // count (bulkImport's visitCount, else 1) so history stats count
        // visits, not rows (docs/protocol.md §8.3).
        let mut originations: HashMap<(String, Uuid), i64> = HashMap::new();
        // Bulk history objects accepted in this batch, so the ledger-insert
        // filter below can keep their `historyVisit` row (permanent dedup,
        // see `known_bulk` above) while still dropping every other
        // `historyVisit` row, same as before.
        let mut bulk_object_ids: HashSet<Uuid> = HashSet::new();
        // Hourly visit buckets (docs/protocol.md §8.3.2): aggregated across
        // every accepted historyVisit op in this batch, in Rust, so the write
        // below is one UPSERT per distinct hour rather than one per op.
        // `legacy_visit_total` covers ops with no `visitHours` at all (older
        // clients) — bucketed separately, at this transaction's own `now()`,
        // once the loop below finishes (see the query right after it).
        let mut hour_buckets: HashMap<DateTime<Utc>, i64> = HashMap::new();
        let mut legacy_visit_total: i64 = 0;

        for (i, &op_index) in accepted_indices.iter().enumerate() {
            let cursor = start_cursor + i as i64;
            let op = &mut ops[op_index];
            operation_ids.push(op.operation_id);
            device_sequences.push(op.device_sequence);
            lamport_timestamps.push(op.lamport_timestamp);
            cursors.push(cursor);
            object_types.push(op.object_type.clone());
            object_ids.push(op.object_id);
            operation_types.push(op.operation_type.clone());
            encryption_versions.push(op.encryption_version);
            // Move the payload instead of cloning it (can be up to 96MB).
            // Nothing reads `op.payload` after this.
            payloads.push(std::mem::take(&mut op.payload));
            // NULL means one visit; readers use unwrap_or(1).
            let visit_count_i32: Option<i32> = if op.is_bulk_history_import() {
                op.visit_count.map(|n| n as i32)
            } else {
                None
            };
            visit_counts.push(visit_count_i32);
            if op.is_bulk_history_import() {
                bulk_object_ids.insert(op.object_id);
            }
            if op.object_type == "historyVisit" {
                match op.visit_hours.take() {
                    Some(hours) => {
                        for (hour, count) in hours {
                            *hour_buckets.entry(hour).or_insert(0) += count;
                        }
                    }
                    // No histogram (older client build): bucket the whole op
                    // — visitCount for a bulk chunk, 1 for a plain visit — at
                    // this transaction's own upload hour, computed once,
                    // right after this loop.
                    None => legacy_visit_total += op.visit_count.unwrap_or(1),
                }
            }

            if vocabulary::is_terminal_operation(&op.object_type, &op.operation_type) {
                tombstones.insert(
                    (op.object_type.clone(), op.object_id),
                    (cursor, op.lamport_timestamp, op.operation_id),
                );
            } else if vocabulary::is_restore_operation(&op.object_type, &op.operation_type) {
                restores.insert((op.object_type.clone(), op.object_id));
            }
            if vocabulary::is_origination_operation(&op.object_type, &op.operation_type) {
                let count = visit_count_i32.map(|n| n as i64).unwrap_or(1);
                // Duplicate create in one batch: keep the largest count.
                originations
                    .entry((op.object_type.clone(), op.object_id))
                    .and_modify(|v| *v = (*v).max(count))
                    .or_insert(count);
            }
        }

        // Incremental `sync_stats` update (see migrations/0007_sync_stats.sql).
        // Computed now, before the sets below are moved into the writes.
        //
        // These are net changes, not op counts. An object created and
        // deleted in the same batch nets to 0. An update to an existing
        // object counts 0.
        //
        // historyVisit is create-only, so it only adds. Tabs can close but
        // never restore, so the tab restore term is always 0 today.
        let bookmark_types: &[&str] = &["bookmark", "bookmarkFolder"];
        let tab_types: &[&str] = &["tab"];
        let history_types: &[&str] = &["historyVisit"];

        // Take the tag-1 stats lock (same as compaction and `/stats`), then
        // compute deltas from each object's real before/after state, not
        // from op types alone. Otherwise two devices deleting the same
        // object would both count a removal.
        let touches_stats =
            !originations.is_empty() || !tombstones.is_empty() || !restores.is_empty();
        if touches_stats {
            lock_user_stats(&mut tx, device.user_id).await?;
        }

        // Objects this batch will tombstone or restore, so we can read their
        // current state before writing. Cloned since the sets are used again.
        let tombstone_keys: HashSet<(String, Uuid)> = tombstones.keys().cloned().collect();
        let restore_keys: HashSet<(String, Uuid)> = restores.clone();
        let touched_keys: Vec<(String, Uuid)> = tombstone_keys
            .iter()
            .cloned()
            .chain(restore_keys.iter().cloned())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let pre_active: HashSet<(String, Uuid)> = if touched_keys.is_empty() {
            HashSet::new()
        } else {
            let (touched_types, touched_ids): (Vec<String>, Vec<Uuid>) =
                touched_keys.iter().cloned().unzip();
            sqlx::query!(
                r#"
                SELECT object_type, object_id FROM tombstones
                WHERE user_id = $1 AND active = true
                AND (object_type, object_id) IN (SELECT * FROM UNNEST($2::text[], $3::uuid[]))
                "#,
                device.user_id,
                &touched_types,
                &touched_ids
            )
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(|r| (r.object_type, r.object_id))
            .collect()
        };

        // History counts visits, not rows. It can't be deleted or restored,
        // so it's safe to compute straight from `originations`.
        let history_visit_delta: i64 = originations
            .iter()
            .filter(|((t, _), _)| history_types.contains(&t.as_str()))
            .map(|(_, v)| *v)
            .sum();

        sqlx::query!(
            r#"
            INSERT INTO sync_operations
                (operation_id, user_id, device_id, device_sequence, lamport_timestamp,
                 server_cursor, object_type, object_id, operation_type, encryption_version, payload, visit_count)
            SELECT u.operation_id, $1, $2, u.device_sequence, u.lamport_timestamp,
                   u.server_cursor, u.object_type, u.object_id, u.operation_type,
                   u.encryption_version, u.payload, u.visit_count
            FROM UNNEST(
                $3::uuid[], $4::bigint[], $5::bigint[], $6::bigint[],
                $7::text[], $8::uuid[], $9::text[], $10::int[], $11::jsonb[], $12::int[]
            ) AS u(operation_id, device_sequence, lamport_timestamp, server_cursor,
                   object_type, object_id, operation_type, encryption_version, payload, visit_count)
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
            &payloads,
            &visit_counts as &[Option<i32>]
        )
        .execute(&mut *tx)
        .await?;

        // Objects actually new to the ledger this batch (from `RETURNING`).
        // Used instead of `originations` so replayed creates don't count.
        let mut newly_originated: HashSet<(String, Uuid)> = HashSet::new();

        // Write the ledger in the same transaction as the ops, so an accepted
        // `create` always has its ledger row. Re-creates are not an error.
        if !originations.is_empty() {
            // Only keys go to the ledger; the counts were for stats.
            //
            // `historyVisit` is filtered out here *except* for bulk imports,
            // which is the opposite of this filter's original shape. A
            // single-visit `historyVisit`/`visit` op is still dropped: the
            // ownership pre-check above only looks up `sync_objects` for
            // *non-origination* ops, and `visit`'s entire vocabulary is
            // origination-only, so its ledger row could never be read by
            // anything — since migration `0006_sync_objects.sql` forbids
            // ever pruning this table, every synced single visit would
            // otherwise leave one permanent, structurally-unread row here
            // forever. `bulkImport`, by contrast, now needs its row read
            // back by the `known_bulk` lookup above, specifically so a
            // retry (after `sync::compaction` has deleted the original
            // `sync_operations` row) still resolves to `Duplicate` instead
            // of double-counting `sync_stats.history_visit_count`. One row
            // per accepted bulk chunk is bounded (an import produces a
            // handful of chunks, not one per visit), unlike one row per
            // visit. Every other object type has at least one
            // non-origination op that depends on its ledger row
            // (bookmark/bookmarkFolder: update/move/delete/restore; tab:
            // update/close/activate/move; window: update/close; tabGroup:
            // update/delete; extensionStorageEntry: delete), so they must
            // keep writing it regardless. This filters at the insert site
            // rather than changing `is_origination_operation`'s return
            // value, which other correctness paths (the ownership
            // pre-check skip above, and the `history_visit_delta` stats
            // calculation) still rely on.
            let (types, ids): (Vec<String>, Vec<Uuid>) = originations
                .into_keys()
                .filter(|(object_type, id)| {
                    object_type != "historyVisit" || bulk_object_ids.contains(id)
                })
                .unzip();
            if !types.is_empty() {
                // `RETURNING` only gives back rows that were really inserted,
                // so a replayed or raced create counts nothing.
                let rows = sqlx::query!(
                    r#"
                    INSERT INTO sync_objects (user_id, object_type, object_id)
                    SELECT $1, u.object_type, u.object_id
                    FROM UNNEST($2::text[], $3::uuid[]) AS u(object_type, object_id)
                    ON CONFLICT DO NOTHING
                    RETURNING object_type, object_id
                    "#,
                    device.user_id,
                    &types,
                    &ids
                )
                .fetch_all(&mut *tx)
                .await?;
                newly_originated = rows
                    .into_iter()
                    .map(|r| (r.object_type, r.object_id))
                    .collect();
            }
        }

        if !tombstones.is_empty() {
            let mut types = Vec::with_capacity(tombstones.len());
            let mut ids = Vec::with_capacity(tombstones.len());
            let mut tomb_cursors = Vec::with_capacity(tombstones.len());
            let mut tomb_lamport_timestamps = Vec::with_capacity(tombstones.len());
            let mut tomb_operation_ids = Vec::with_capacity(tombstones.len());
            for ((t, id), (cursor, lamport_timestamp, operation_id)) in tombstones {
                types.push(t);
                ids.push(id);
                tomb_cursors.push(cursor);
                tomb_lamport_timestamps.push(lamport_timestamp);
                tomb_operation_ids.push(operation_id);
            }
            // Store the delete op's ordering key so `filter_tombstoned` can
            // compare it with the object's latest update.
            sqlx::query!(
                r#"
                INSERT INTO tombstones
                    (user_id, object_type, object_id, deleted_at_cursor, active,
                     lamport_timestamp, device_id, operation_id)
                SELECT $1, u.object_type, u.object_id, u.cursor, true, u.lamport_timestamp, $6, u.operation_id
                FROM UNNEST($2::text[], $3::uuid[], $4::bigint[], $5::bigint[], $7::uuid[])
                    AS u(object_type, object_id, cursor, lamport_timestamp, operation_id)
                ON CONFLICT (user_id, object_type, object_id)
                DO UPDATE SET deleted_at_cursor = EXCLUDED.deleted_at_cursor, active = true,
                    lamport_timestamp = EXCLUDED.lamport_timestamp,
                    device_id = EXCLUDED.device_id,
                    operation_id = EXCLUDED.operation_id
                "#,
                device.user_id,
                &types,
                &ids,
                &tomb_cursors,
                &tomb_lamport_timestamps,
                device.device_id,
                &tomb_operation_ids
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

        // Compare each tombstoned/restored object's state before and after
        // this batch. Tombstones are written before restores, so delete then
        // restore in one batch ends inactive.
        //
        // If two batches delete the same object, the second sees it already
        // inactive and counts nothing.
        let now_active = |key: &(String, Uuid)| -> bool {
            !restore_keys.contains(key) && tombstone_keys.contains(key)
        };
        let transition_delta = |types: &[&str]| -> i64 {
            touched_keys
                .iter()
                .filter(|k| types.contains(&k.0.as_str()))
                .map(|k| {
                    let was = pre_active.contains(k);
                    let now = now_active(k);
                    match (was, now) {
                        (false, true) => -1,
                        (true, false) => 1,
                        _ => 0,
                    }
                })
                .sum::<i64>()
        };
        let new_origination_delta = |types: &[&str]| -> i64 {
            newly_originated
                .iter()
                .filter(|k| types.contains(&k.0.as_str()))
                .count() as i64
        };

        let bookmark_delta =
            new_origination_delta(bookmark_types) + transition_delta(bookmark_types);
        let tab_delta = new_origination_delta(tab_types) + transition_delta(tab_types);

        // Apply the deltas. Skipped if all are zero.
        //
        // Counts are clamped at zero. The insert clamps the delta itself (it
        // can be negative). The update clamps the sum, using the raw `$2..$4`
        // params, not `EXCLUDED` (which is already clamped). Columns are
        // BIGINT, so no upper clamp is needed.
        //
        // The tag-1 lock taken above is still held here.
        //
        // `history_visit_count` here (and `compact_user`'s own authoritative
        // recount of it) is kept exactly as it was — still written on every
        // batch — but is no longer what `/stats` reads to answer "how many
        // history visits are synced" (docs/protocol.md §8.3.2): that now
        // sums `history_visit_hours`, written just below, which buckets by
        // real visit time instead of upload time. Left in place rather than
        // removed: it costs nothing to keep populated and ripping it out
        // would be a larger, purely cosmetic change for no correctness gain.
        if bookmark_delta != 0 || history_visit_delta != 0 || tab_delta != 0 {
            sqlx::query!(
                r#"
                INSERT INTO sync_stats (user_id, bookmark_count, history_visit_count, tab_count)
                VALUES ($1, GREATEST(0::bigint, $2), GREATEST(0::bigint, $3), GREATEST(0::bigint, $4))
                ON CONFLICT (user_id) DO UPDATE SET
                    bookmark_count = GREATEST(0::bigint, sync_stats.bookmark_count + $2),
                    history_visit_count = GREATEST(0::bigint, sync_stats.history_visit_count + $3),
                    tab_count = GREATEST(0::bigint, sync_stats.tab_count + $4),
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

        // Hourly visit buckets (docs/protocol.md §8.3.2): folded into the
        // same transaction, under the same tag-1 advisory lock acquired
        // above for the `sync_stats` upsert — every accepted historyVisit op
        // is itself an origination (`vocabulary::is_origination_operation`),
        // so `touches_stats` (and therefore the lock) is already guaranteed
        // true whenever `hour_buckets`/`legacy_visit_total` is non-empty.
        // `legacy_visit_total` (ops with no `visitHours` at all) is folded
        // into `hour_buckets` at this transaction's own `now()` — Postgres's
        // `now()` is the transaction start time, the same instant
        // `sync_operations.created_at`'s `DEFAULT now()` resolves to for
        // every row this same INSERT above just wrote, so this is exactly
        // "bucket at the hour this op gets".
        if legacy_visit_total > 0 {
            let legacy_hour: DateTime<Utc> = sqlx::query_scalar!(
                r#"SELECT date_trunc('hour', now()) AS "hour!: DateTime<Utc>""#
            )
            .fetch_one(&mut *tx)
            .await?;
            *hour_buckets.entry(legacy_hour).or_insert(0) += legacy_visit_total;
        }
        if !hour_buckets.is_empty() {
            let (hours, counts): (Vec<DateTime<Utc>>, Vec<i64>) = hour_buckets.into_iter().unzip();
            sqlx::query!(
                r#"
                INSERT INTO history_visit_hours (user_id, hour, visits)
                SELECT $1, u.hour, u.visits
                FROM UNNEST($2::timestamptz[], $3::bigint[]) AS u(hour, visits)
                ON CONFLICT (user_id, hour) DO UPDATE SET visits = history_visit_hours.visits + EXCLUDED.visits
                "#,
                device.user_id,
                &hours,
                &counts
            )
            .execute(&mut *tx)
            .await?;
        }

        // Save the new `last_seq` on the device. A plain assignment is safe:
        // the per-device advisory lock is held until commit.
        sqlx::query!(
            "UPDATE devices SET last_device_sequence = $1 WHERE id = $2",
            last_seq,
            device.device_id
        )
        .execute(&mut *tx)
        .await?;
    }

    // Nothing accepted: return the account's current cursor, like the
    // empty-batch case.
    if accepted_indices.is_empty() {
        server_cursor = current_cursor(&mut *tx, device.user_id).await?;
    }

    tx.commit().await?;

    let mut accepted = Vec::new();
    let mut duplicate = Vec::new();
    let mut rejected = Vec::new();
    for (op, decision) in ops.iter().zip(decisions.iter()) {
        match decision {
            Decision::Accept(_) => accepted.push(op.operation_id),
            Decision::Duplicate => duplicate.push(op.operation_id),
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

/// Generic over the executor, so it works with a pool or a transaction.
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
    let limit = q
        .limit
        .unwrap_or(DEFAULT_DOWNLOAD_LIMIT)
        .clamp(1, MAX_DOWNLOAD_LIMIT);

    // One query that reads the cursor bounds and saves the device's cursor.
    //
    // - The upsert only writes when the cursor moved forward, so idle polls
    //   don't write at all.
    // - When it doesn't write, `upsert` returns no rows. That's why we use
    //   `bounds LEFT JOIN upsert ON true`: `bounds` always has one row.
    //   Don't change this to `FROM bounds, upsert`, or idle polls fail
    //   with `RowNotFound`.
    // - The client's cursor is capped at the highest cursor really handed
    //   out (`LEAST($3, allocated.max_allocated)`), so a bad value can't
    //   push compaction's boundary too high.
    let bounds = sqlx::query!(
        r#"
        WITH bounds AS (
            SELECT
                (SELECT MIN(server_cursor) FROM sync_operations WHERE user_id = $1) AS min_cursor,
                (SELECT MAX(snapshot_cursor) FROM sync_snapshots WHERE user_id = $1) AS max_snapshot
        ),
        allocated AS (
            SELECT COALESCE(
                (SELECT cursor_value FROM sync_cursors WHERE user_id = $1 AND device_id IS NULL),
                0
            ) AS max_allocated
        ),
        upsert AS (
            INSERT INTO sync_cursors (user_id, device_id, cursor_value)
            SELECT $1, $2, LEAST($3, allocated.max_allocated)
            FROM allocated
            ON CONFLICT (user_id, device_id)
            DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = now()
            WHERE sync_cursors.cursor_value < EXCLUDED.cursor_value
            RETURNING 1 AS ok
        )
        SELECT bounds.min_cursor, bounds.max_snapshot, allocated.max_allocated
        FROM bounds
        CROSS JOIN allocated
        LEFT JOIN upsert ON true
        "#,
        device.user_id,
        device.device_id,
        cursor
    )
    .fetch_one(&state.db)
    .await?;

    // After compaction, a device can only resume from the latest snapshot
    // cursor or later (docs/protocol.md §11). Older cursors, including 0
    // for a new device, must resync from a snapshot (§10.3).
    let raw_floor = bounds.min_cursor.map(|m| m - 1).unwrap_or(0);
    let snapshot_floor = bounds.max_snapshot.unwrap_or(0);
    let floor_cursor = raw_floor.max(snapshot_floor);

    if cursor < floor_cursor {
        return Err(AppError::Conflict("cursor_too_old".into()));
    }

    // A cursor above the highest one ever handed out can't be real. This
    // happens after a DB restore. Without this check, the device would get
    // empty pages forever and miss ops. Send it to `/snapshot` instead.
    if cursor > bounds.max_allocated.unwrap_or(0) {
        return Err(AppError::Conflict("cursor_invalid".into()));
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

    let has_more_by_count = rows.len() as i64 > limit;
    if has_more_by_count {
        rows.truncate(limit as usize);
    }

    // Also cap the page by payload bytes. The first row is always kept so
    // paging can't get stuck.
    let mut accumulated_bytes: usize = 0;
    let mut byte_cutoff = rows.len();
    for (i, row) in rows.iter().enumerate() {
        let row_bytes = row.payload.to_string().len();
        if i > 0 && accumulated_bytes + row_bytes > MAX_DOWNLOAD_PAYLOAD_BYTES {
            byte_cutoff = i;
            break;
        }
        accumulated_bytes += row_bytes;
    }
    let has_more_by_bytes = byte_cutoff < rows.len();
    if has_more_by_bytes {
        rows.truncate(byte_cutoff);
    }

    let has_more = has_more_by_count || has_more_by_bytes;
    let next_cursor = rows.last().map(|r| r.server_cursor).unwrap_or(cursor);

    Ok(Json(DownloadResponse {
        operations: rows,
        next_cursor,
        has_more,
    }))
}

#[derive(sqlx::FromRow)]
struct SnapshotTombstoneRow {
    object_type: String,
    object_id: Uuid,
    lamport_timestamp: i64,
    device_id: Uuid,
    operation_id: Uuid,
}

/// How `snapshot` starts its transaction. REPEATABLE READ gives all reads
/// one consistent view (docs/protocol.md §10.3), so no object can be newer
/// than `snapshotCursor`. READ ONLY avoids serialization failures. Public so
/// tests can check it.
pub const SNAPSHOT_TX_ISOLATION: &str = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

/// Builds a point-in-time snapshot on demand (docs/protocol.md §10.3).
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

    // Limit concurrent snapshot builds across the process (see
    // `SNAPSHOT_CONCURRENCY_LIMIT`). Held until the response is built.
    let _snapshot_permit = state
        .snapshot_semaphore
        .acquire()
        .await
        .expect("snapshot semaphore is never closed");

    // Read settings before opening the transaction, to keep it short.
    let history_cutoff = history_retention_cutoff(&state.db, device.user_id).await?;

    // Objects and tombstones are read in one REPEATABLE READ transaction so
    // they match (docs/protocol.md §10.3). Committed right after to keep it short.
    let mut tx = state.db.begin_with(SNAPSHOT_TX_ISOLATION).await?;
    let (snapshot_cursor, objects_map) =
        compute_objects(&mut tx, device.user_id, None, history_cutoff).await?;

    // Same transaction as the objects, so both see the same data.
    let tombstone_rows = sqlx::query_as!(
        SnapshotTombstoneRow,
        "SELECT object_type, object_id, lamport_timestamp, device_id, operation_id \
         FROM tombstones WHERE user_id = $1 AND active = true",
        device.user_id
    )
    .fetch_all(&mut *tx)
    .await?;

    tx.commit().await?;

    let tombstones: HashMap<(String, Uuid), super::conflict::OrderingKey> = tombstone_rows
        .iter()
        .map(|t| {
            (
                (t.object_type.clone(), t.object_id),
                super::conflict::OrderingKey {
                    lamport_timestamp: t.lamport_timestamp,
                    device_id: t.device_id,
                    operation_id: t.operation_id,
                },
            )
        })
        .collect();

    let objects = filter_tombstoned(objects_map, &tombstones);

    // Highest encryption version the client needs (docs/protocol.md §10.3).
    let encryption_version = objects
        .iter()
        .map(|o| o.encryption_version)
        .max()
        .unwrap_or(0);

    let tombstones = tombstone_rows
        .into_iter()
        .map(|t| SnapshotTombstone {
            object_type: t.object_type,
            object_id: t.object_id,
        })
        .collect();

    Ok(Json(SnapshotResponse {
        snapshot_cursor,
        encryption_version,
        objects,
        tombstones,
    }))
}

#[cfg(test)]
mod byte_counter_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn counts_bytes_written() {
        let mut counter = ByteCounter(0);
        assert_eq!(counter.write(b"hello").unwrap(), 5);
        assert_eq!(counter.0, 5);
        counter.write_all(b" world").unwrap();
        assert_eq!(counter.0, 11);
        assert!(counter.flush().is_ok());
    }

    #[test]
    fn matches_serde_json_to_vec_length() {
        let test_payload = serde_json::json!({
            "title": "Example Bookmark",
            "url": "https://example.com/some/long/path?param=1&other=abc#section",
            "nested": {
                "tags": ["alpha", "beta", "gamma"],
                "count": 42,
                "flag": true,
                "empty": null
            }
        });

        let vec_len = serde_json::to_vec(&test_payload).unwrap().len();

        let mut counter = ByteCounter(0);
        serde_json::to_writer(&mut counter, &test_payload).unwrap();
        assert_eq!(counter.0, vec_len);
    }
}
