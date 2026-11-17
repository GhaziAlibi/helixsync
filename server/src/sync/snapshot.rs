// Rebuilds each object's current state from the latest stored snapshot plus
// newer ops, and stores snapshots compressed. Used by `/snapshot`, `/stats`,
// and compaction.
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use uuid::Uuid;

use crate::error::AppResult;

use super::conflict::OrderingKey;
use super::model::{SnapshotLayer, SnapshotObject};
use super::vocabulary;

/// Max size a stored snapshot may decompress to. Real snapshots are
/// 30-50MB; this leaves room while stopping a gzip bomb.
const MAX_DECOMPRESSED_SNAPSHOT_BYTES: u64 = 256 * 1024 * 1024;

#[derive(sqlx::FromRow)]
struct SnapshotSourceRow {
    object_type: String,
    object_id: Uuid,
    operation_type: String,
    encryption_version: i32,
    payload: serde_json::Value,
    // Not in the output; used to rebuild each op's `OrderingKey` in Rust.
    lamport_timestamp: i64,
    device_id: Uuid,
    operation_id: Uuid,
    // Kept so retention can still prune historyVisits stored in a snapshot
    // (see `SnapshotObject::created_at`).
    created_at: DateTime<Utc>,
    // Visit count for bulk history ops (docs/protocol.md §8.3). NULL means one.
    visit_count: Option<i32>,
}

impl SnapshotSourceRow {
    fn ordering_key(&self) -> OrderingKey {
        OrderingKey {
            lamport_timestamp: self.lamport_timestamp,
            device_id: self.device_id,
            operation_id: self.operation_id,
        }
    }
}

const FIELD_MERGE_OBJECT_TYPES: &[&str] = &["bookmark", "bookmarkFolder"];

/// Merges a bookmark/bookmarkFolder's saved state (`base`, from a snapshot)
/// with newer ops (sorted by [`OrderingKey`]). Treating
/// `base` as the first op gives the same result as merging the full history
/// (docs/protocol.md §8.2), which is why compaction can delete old rows.
///
/// Uses whole-object LWW instead if any payload is encrypted or the type
/// doesn't need field merging.
fn combine_object(
    object_type: String,
    object_id: Uuid,
    base: Option<SnapshotObject>,
    new_ops_ascending: Vec<SnapshotSourceRow>,
) -> Option<SnapshotObject> {
    if new_ops_ascending.is_empty() {
        return base;
    }

    let new_all_plaintext = new_ops_ascending
        .iter()
        .all(|op| op.encryption_version == 0);
    let base_plaintext = base.as_ref().is_none_or(|b| b.encryption_version == 0);

    if new_all_plaintext
        && base_plaintext
        && FIELD_MERGE_OBJECT_TYPES.contains(&object_type.as_str())
    {
        let mut payloads: Vec<serde_json::Value> = Vec::with_capacity(new_ops_ascending.len() + 1);
        if let Some(b) = &base {
            payloads.push(b.payload.clone());
        }
        payloads.extend(new_ops_ascending.iter().map(|op| op.payload.clone()));
        if let Some(merged) = super::conflict::merge_bookmark_fields(&payloads) {
            // Not subject to history retention, but still needs a
            // `created_at`; use the latest op's upload time.
            let created_at = new_ops_ascending
                .iter()
                .map(|op| op.created_at)
                .chain(base.as_ref().map(|b| b.created_at))
                .max()
                .expect("new_ops_ascending checked non-empty above");
            // The object's key is the higher of `base`'s key and the newest
            // op's key, so tombstones compare against the true latest write.
            let newest_new_key = new_ops_ascending
                .last()
                .map(SnapshotSourceRow::ordering_key)
                .expect("new_ops_ascending checked non-empty above");
            let ordering_key = base
                .as_ref()
                .map(|b| b.ordering_key().max(newest_new_key))
                .unwrap_or(newest_new_key);
            return Some(SnapshotObject {
                object_type,
                object_id,
                // A merged payload shaped like a `create` payload.
                operation_type: "create".to_string(),
                encryption_version: 0,
                payload: merged,
                created_at,
                // Only historyVisit has a visit count.
                visit_count: None,
                lamport_timestamp: ordering_key.lamport_timestamp,
                device_id: ordering_key.device_id,
                operation_id: ordering_key.operation_id,
                layers: Vec::new(),
            });
        }
    }

    let all_encrypted = new_ops_ascending
        .iter()
        .all(|op| op.encryption_version >= 1)
        && base.as_ref().is_none_or(|b| b.encryption_version >= 1);
    if all_encrypted && LAYERED_OBJECT_TYPES.contains(&object_type.as_str()) {
        return Some(combine_layered(
            object_type,
            object_id,
            base,
            new_ops_ascending,
        ));
    }

    // Whole-object LWW: the last (highest-key) op wins and replaces `base`.
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
        visit_count: winner.visit_count.map(|v| v as i64),
        lamport_timestamp: winner.lamport_timestamp,
        device_id: winner.device_id,
        operation_id: winner.operation_id,
        layers: Vec::new(),
    })
}

/// Encrypted object types whose operations can carry only some fields (a
/// bookmark's `update` or `move`, a tab's `activate`).
const LAYERED_OBJECT_TYPES: &[&str] = &["bookmark", "bookmarkFolder", "tab", "window", "tabGroup"];

/// Operation types whose payload is the object's whole state. Everything
/// before the latest of these is superseded and dropped.
const FULL_STATE_OPERATIONS: &[&str] = &["create", "restore"];

/// How many operations of one type are kept after the latest full-state
/// operation. Bounds an object that is changed endlessly (a tab activated
/// every time it is switched to) without letting that flood push out its
/// other kinds of change.
const MAX_LAYERS_PER_OPERATION_TYPE: usize = 8;

/// One operation of an object, as `combine_layered` sees it.
struct Link {
    operation_type: String,
    encryption_version: i32,
    payload: serde_json::Value,
    created_at: DateTime<Utc>,
    visit_count: Option<i64>,
    key: OrderingKey,
}

impl Link {
    fn from_row(row: SnapshotSourceRow) -> Self {
        Link {
            key: row.ordering_key(),
            operation_type: row.operation_type,
            encryption_version: row.encryption_version,
            payload: row.payload,
            created_at: row.created_at,
            visit_count: row.visit_count.map(|v| v as i64),
        }
    }
}

/// Encrypted counterpart of the plaintext field merge: the server can't read
/// the fields, so it keeps the chain of operations since the object's latest
/// full state and lets the reader fold them in order. The object's own fields
/// stay those of the latest operation, as for whole-object LWW, so readers that
/// ignore `layers` see what they always did.
fn combine_layered(
    object_type: String,
    object_id: Uuid,
    base: Option<SnapshotObject>,
    new_ops_ascending: Vec<SnapshotSourceRow>,
) -> SnapshotObject {
    let mut links: Vec<Link> = Vec::new();
    if let Some(base) = base {
        for layer in base.layers {
            links.push(Link {
                key: OrderingKey {
                    lamport_timestamp: layer.lamport_timestamp,
                    device_id: layer.device_id,
                    operation_id: layer.operation_id,
                },
                operation_type: layer.operation_type,
                encryption_version: base.encryption_version,
                payload: layer.payload,
                created_at: base.created_at,
                visit_count: None,
            });
        }
        links.push(Link {
            key: OrderingKey {
                lamport_timestamp: base.lamport_timestamp,
                device_id: base.device_id,
                operation_id: base.operation_id,
            },
            operation_type: base.operation_type,
            encryption_version: base.encryption_version,
            payload: base.payload,
            created_at: base.created_at,
            visit_count: base.visit_count,
        });
    }
    links.extend(new_ops_ascending.into_iter().map(Link::from_row));
    links.sort_by_key(|l| l.key);
    // Snapshots saved before ordering keys were stored have nil operation
    // ids; those must not be mistaken for each other.
    links.dedup_by(|a, b| !a.key.operation_id.is_nil() && a.key.operation_id == b.key.operation_id);

    let winner = links.pop().expect("an object has at least one operation");

    // Nothing before the latest full state matters.
    if let Some(at) = links
        .iter()
        .rposition(|l| FULL_STATE_OPERATIONS.contains(&l.operation_type.as_str()))
    {
        links.drain(..at);
    }

    // A deletion carries no state, and the winner may itself be one.
    links.retain(|l| !vocabulary::is_terminal_operation(&object_type, &l.operation_type));

    // Newest first, so the cap keeps the latest of each partial type.
    let mut kept_by_type: HashMap<String, usize> = HashMap::new();
    let mut layers: Vec<SnapshotLayer> = Vec::new();
    for link in links.into_iter().rev() {
        if !FULL_STATE_OPERATIONS.contains(&link.operation_type.as_str()) {
            let kept = kept_by_type.entry(link.operation_type.clone()).or_insert(0);
            if *kept >= MAX_LAYERS_PER_OPERATION_TYPE {
                continue;
            }
            *kept += 1;
        }
        layers.push(SnapshotLayer {
            operation_type: link.operation_type,
            payload: link.payload,
            lamport_timestamp: link.key.lamport_timestamp,
            device_id: link.key.device_id,
            operation_id: link.key.operation_id,
        });
    }
    layers.reverse();
    if vocabulary::is_terminal_operation(&object_type, &winner.operation_type) {
        layers.clear();
    }
    // A full-state winner has nothing before it that matters.
    if FULL_STATE_OPERATIONS.contains(&winner.operation_type.as_str()) {
        layers.clear();
    }

    SnapshotObject {
        object_type,
        object_id,
        operation_type: winner.operation_type,
        encryption_version: winner.encryption_version,
        payload: winner.payload,
        created_at: winner.created_at,
        visit_count: winner.visit_count,
        lamport_timestamp: winner.key.lamport_timestamp,
        device_id: winner.key.device_id,
        operation_id: winner.key.operation_id,
        layers,
    }
}

/// Sorts one object's rows by `OrderingKey` and merges them into `objects`.
/// Called once per object while streaming, so each group can be freed early.
fn flush_object_group(
    object_type: String,
    object_id: Uuid,
    mut ops: Vec<SnapshotSourceRow>,
    objects: &mut HashMap<(String, Uuid), SnapshotObject>,
) {
    // Rows arrive grouped by object, not sorted by `OrderingKey`; sort here.
    ops.sort_by_key(SnapshotSourceRow::ordering_key);
    let base_entry = objects.remove(&(object_type.clone(), object_id));
    if let Some(combined) = combine_object(object_type.clone(), object_id, base_entry, ops) {
        objects.insert((object_type, object_id), combined);
    }
}

/// Streams rows grouped by object and merges each group as soon as the next
/// one starts. Only one object's rows are in memory at a time.
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

/// Turns the account's `history_retention` setting into a cutoff time for
/// `historyVisit` ops. Returns `None` for "unlimited", unknown values, or no
/// settings (keep data when unsure).
///
/// Visits are encrypted, so the cutoff uses upload time
/// (`sync_operations.created_at`), not the visit's real time.
///
/// [`compute_objects`] applies it twice: in SQL on new rows, and in memory
/// on objects from the saved snapshot.
pub(super) async fn history_retention_cutoff<'e, E>(
    executor: E,
    user_id: Uuid,
) -> AppResult<Option<DateTime<Utc>>>
where
    E: sqlx::PgExecutor<'e>,
{
    let retention: Option<String> = sqlx::query_scalar!(
        "SELECT history_retention FROM user_settings WHERE user_id = $1",
        user_id
    )
    .fetch_optional(executor)
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

/// Serializes objects to JSON and gzips them for storage in `sync_snapshots`.
/// Snapshots can be 30-50MB of raw JSON.
pub(super) fn compress_snapshot_data(objects: &[SnapshotObject]) -> AppResult<Vec<u8>> {
    use std::io::Write;

    let json = serde_json::to_vec(objects).map_err(anyhow::Error::from)?;

    // Enforce the same cap as `decompress_snapshot_data`, so we never save
    // a snapshot we can't read back.
    if json.len() as u64 > MAX_DECOMPRESSED_SNAPSHOT_BYTES {
        return Err(anyhow::anyhow!(
            "snapshot data is {} bytes, more than the {MAX_DECOMPRESSED_SNAPSHOT_BYTES} byte read cap; refusing to persist an unreadable snapshot",
            json.len()
        )
        .into());
    }

    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&json).map_err(anyhow::Error::from)?;
    Ok(encoder.finish().map_err(anyhow::Error::from)?)
}

/// Runs compression on the blocking pool so it doesn't stall Tokio.
pub(super) async fn compress_snapshot_data_async(
    objects: Vec<SnapshotObject>,
) -> AppResult<Vec<u8>> {
    tokio::task::spawn_blocking(move || compress_snapshot_data(&objects))
        .await
        .map_err(|e| anyhow::anyhow!("snapshot compression task failed: {e}"))?
}

/// Reverse of [`compress_snapshot_data`]. Handles two formats: gzip (new
/// rows) and plain JSON (uncompressed rows, as written
/// before snapshots were compressed).
///
/// Tries gzip first. Gzip starts with `0x1f 0x8b` and JSON with `{` or `[`,
/// so plain JSON always fails gzip right away and we fall back to it.
pub(super) fn decompress_snapshot_data(bytes: &[u8]) -> AppResult<Vec<SnapshotObject>> {
    use std::io::Read;

    // Read one byte past the limit. `Take` stops silently, so this is how
    // we tell "fits exactly" from "too big".
    let mut decoder = flate2::read::GzDecoder::new(bytes).take(MAX_DECOMPRESSED_SNAPSHOT_BYTES + 1);
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
            // Not gzip: treat as plain JSON (the old format).
            serde_json::from_slice(bytes).map_err(anyhow::Error::from)?
        }
    };
    Ok(parsed)
}

/// Runs decompression and parsing on the blocking pool so it doesn't stall Tokio.
pub(super) async fn decompress_snapshot_data_async(
    bytes: Vec<u8>,
) -> AppResult<Vec<SnapshotObject>> {
    tokio::task::spawn_blocking(move || decompress_snapshot_data(&bytes))
        .await
        .map_err(|e| anyhow::anyhow!("snapshot decompression task failed: {e}"))?
}

/// Computes every object's current state as of `ceiling` (or now). Starts
/// from the latest saved snapshot at or below the ceiling and merges newer
/// ops on top, so deleted old rows aren't needed.
///
/// `history_cutoff` drops older `historyVisit` ops (`None` disables it).
///
/// Returns `(resolved_cursor, objects_by_key)`. Callers filter tombstones
/// themselves.
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

    let (base_cursor, mut objects): (i64, HashMap<(String, Uuid), SnapshotObject>) = match base_row
    {
        Some((cursor, data)) => {
            let parsed: Vec<SnapshotObject> = decompress_snapshot_data_async(data).await?;
            let map = parsed
                .into_iter()
                .filter(|o| {
                    history_cutoff
                        .is_none_or(|c| o.object_type != "historyVisit" || o.created_at >= c)
                })
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

    // The history filter only affects historyVisit rows, and does nothing
    // when `history_cutoff` is None.
    //
    // Rows are streamed and ordered by object (not cursor), so only one
    // object's rows are held at a time. The `(user_id, object_type,
    // object_id)` index gives this order without a sort. Per-object
    // `OrderingKey` order is restored in `flush_object_group`.
    match ceiling {
        Some(c) => {
            let rows = sqlx::query_as!(
                SnapshotSourceRow,
                r#"
                SELECT object_type, object_id, operation_type, encryption_version, payload,
                       lamport_timestamp, device_id, operation_id, created_at, visit_count
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
                       lamport_timestamp, device_id, operation_id, created_at, visit_count
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

    // Apply retention to historyVisits that came from the saved snapshot.
    // They never show up in `new_rows` again, so the SQL filter can't catch
    // them. Done after the merge so recent ones get merged first.
    if let Some(cutoff) = history_cutoff {
        objects.retain(|_, obj| obj.object_type != "historyVisit" || obj.created_at >= cutoff);
    }

    Ok((resolved_cursor, objects))
}

/// Active tombstones for `user_id`, keyed by object and valued by the delete
/// op's ordering key (what `filter_tombstoned` compares against).
pub(super) async fn load_active_tombstones<'e, E>(
    executor: E,
    user_id: Uuid,
) -> AppResult<HashMap<(String, Uuid), OrderingKey>>
where
    E: sqlx::PgExecutor<'e>,
{
    let tombstones = sqlx::query!(
        "SELECT object_type, object_id, lamport_timestamp, device_id, operation_id \
         FROM tombstones WHERE user_id = $1 AND active = true",
        user_id
    )
    .fetch_all(executor)
    .await?
    .into_iter()
    .map(|r| {
        (
            (r.object_type, r.object_id),
            OrderingKey {
                lamport_timestamp: r.lamport_timestamp,
                device_id: r.device_id,
                operation_id: r.operation_id,
            },
        )
    })
    .collect();
    Ok(tombstones)
}

/// Returns only live objects, given all objects and the active tombstones
/// (keyed by the delete op's ordering key). Used by `/snapshot` and compaction.
///
/// A tombstone only hides an object if its key beats the object's latest
/// write (docs/protocol.md §8.2). A later or winning update keeps it live.
///
/// Objects whose winning op is itself a delete/close are always dropped.
/// Tab/window tombstones get cleaned up by housekeeping, so without this a
/// closed tab could reappear in snapshots.
pub(super) fn filter_tombstoned(
    mut objects_map: HashMap<(String, Uuid), SnapshotObject>,
    tombstones: &HashMap<(String, Uuid), OrderingKey>,
) -> Vec<SnapshotObject> {
    objects_map.retain(|key, obj| {
        if vocabulary::is_terminal_operation(&obj.object_type, &obj.operation_type) {
            return false;
        }
        match tombstones.get(key) {
            Some(tombstone_key) => *tombstone_key < obj.ordering_key(),
            None => true,
        }
    });
    objects_map.into_values().collect()
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
                visit_count: None,
                lamport_timestamp: 0,
                device_id: Uuid::nil(),
                operation_id: Uuid::nil(),
                layers: Vec::new(),
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

    #[tokio::test]
    async fn round_trips_async() {
        let objects = sample_objects(50);
        let compressed = compress_snapshot_data_async(objects.clone())
            .await
            .expect("async compression should succeed");
        let decompressed = decompress_snapshot_data_async(compressed)
            .await
            .expect("async decompression should succeed");
        assert_eq!(decompressed.len(), objects.len());
        assert_eq!(decompressed[0].object_type, "note");
    }

    #[test]
    fn rejects_a_payload_that_decompresses_past_the_cap() {
        // Repetitive data compresses tiny but inflates past the cap (gzip bomb).
        use std::io::Read as _;
        let oversized_len = MAX_DECOMPRESSED_SNAPSHOT_BYTES + 1024;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::copy(&mut std::io::repeat(b'a').take(oversized_len), &mut encoder)
            .expect("streaming into the encoder should succeed");
        let compressed = encoder.finish().expect("gzip finish should succeed");

        let result = decompress_snapshot_data(&compressed);
        assert!(
            result.is_err(),
            "decompressing past the cap should be rejected, not silently truncated"
        );
    }

    #[test]
    fn compress_refuses_to_persist_what_decompress_would_reject() {
        // Over the read cap, so the writer must refuse it.
        let oversized_len = (MAX_DECOMPRESSED_SNAPSHOT_BYTES + 1024) as usize;
        let mut objects = sample_objects(1);
        objects[0].payload = serde_json::json!({ "body": "a".repeat(oversized_len) });

        let result = compress_snapshot_data(&objects);
        assert!(
            result.is_err(),
            "a snapshot bigger than the read cap must never be persisted"
        );
    }
}

#[cfg(test)]
mod combine_layered_tests {
    use super::*;
    use serde_json::json;

    fn row(
        object_type: &str,
        operation_type: &str,
        lamport: i64,
        encrypted: bool,
    ) -> SnapshotSourceRow {
        SnapshotSourceRow {
            object_type: object_type.to_string(),
            object_id: Uuid::nil(),
            operation_type: operation_type.to_string(),
            encryption_version: i32::from(encrypted),
            payload: json!({ "op": operation_type, "n": lamport }),
            lamport_timestamp: lamport,
            device_id: Uuid::nil(),
            operation_id: Uuid::from_u128(lamport as u128),
            created_at: Utc::now(),
            visit_count: None,
        }
    }

    fn combine(object_type: &str, ops: Vec<SnapshotSourceRow>) -> SnapshotObject {
        combine_object(object_type.to_string(), Uuid::nil(), None, ops).unwrap()
    }

    fn layer_ops(object: &SnapshotObject) -> Vec<(&str, i64)> {
        object
            .layers
            .iter()
            .map(|l| (l.operation_type.as_str(), l.lamport_timestamp))
            .collect()
    }

    #[test]
    fn keeps_the_chain_since_the_latest_full_state_oldest_first() {
        let object = combine(
            "bookmark",
            vec![
                row("bookmark", "create", 1, true),
                row("bookmark", "update", 2, true),
                row("bookmark", "move", 3, true),
            ],
        );
        assert_eq!(object.operation_type, "move");
        assert_eq!(object.payload["n"], 3);
        assert_eq!(layer_ops(&object), vec![("create", 1), ("update", 2)]);
    }

    #[test]
    fn a_later_restore_supersedes_everything_before_it() {
        let object = combine(
            "bookmark",
            vec![
                row("bookmark", "create", 1, true),
                row("bookmark", "update", 2, true),
                row("bookmark", "delete", 3, true),
                row("bookmark", "restore", 4, true),
                row("bookmark", "move", 5, true),
            ],
        );
        assert_eq!(object.operation_type, "move");
        assert_eq!(layer_ops(&object), vec![("restore", 4)]);
    }

    #[test]
    fn a_full_state_winner_has_no_layers() {
        let object = combine(
            "bookmark",
            vec![
                row("bookmark", "update", 1, true),
                row("bookmark", "create", 2, true),
            ],
        );
        assert_eq!(object.operation_type, "create");
        assert!(object.layers.is_empty());
    }

    #[test]
    fn orders_by_key_not_by_arrival() {
        let object = combine(
            "tab",
            vec![
                row("tab", "activate", 3, true),
                row("tab", "create", 1, true),
                row("tab", "update", 2, true),
            ],
        );
        assert_eq!(object.operation_type, "activate");
        assert_eq!(layer_ops(&object), vec![("create", 1), ("update", 2)]);
    }

    #[test]
    fn caps_each_operation_type_so_a_flood_cannot_push_out_other_changes() {
        let mut ops = vec![row("tab", "create", 1, true), row("tab", "update", 2, true)];
        for n in 0..50 {
            ops.push(row("tab", "activate", 10 + n, true));
        }
        let object = combine("tab", ops);

        let activates = object
            .layers
            .iter()
            .filter(|l| l.operation_type == "activate")
            .count();
        // The winner is the newest activate; the cap applies to the layers.
        assert_eq!(activates, MAX_LAYERS_PER_OPERATION_TYPE);
        assert_eq!(object.lamport_timestamp, 59);
        let newest_layer_activate = object
            .layers
            .iter()
            .filter(|l| l.operation_type == "activate")
            .map(|l| l.lamport_timestamp)
            .max()
            .unwrap();
        assert_eq!(
            newest_layer_activate, 58,
            "the latest ones are the ones kept"
        );
        assert!(object.layers.iter().any(|l| l.operation_type == "update"));
        assert!(object.layers.iter().any(|l| l.operation_type == "create"));
        assert!(object
            .layers
            .windows(2)
            .all(|w| w[0].lamport_timestamp < w[1].lamport_timestamp));
    }

    #[test]
    fn a_terminal_winner_keeps_no_layers_and_deletions_are_never_layers() {
        let closed = combine(
            "tab",
            vec![
                row("tab", "create", 1, true),
                row("tab", "update", 2, true),
                row("tab", "close", 3, true),
            ],
        );
        assert_eq!(closed.operation_type, "close");
        assert!(closed.layers.is_empty());

        // A write newer than a delete wins; the delete itself carries no state.
        let revived = combine(
            "bookmark",
            vec![
                row("bookmark", "create", 1, true),
                row("bookmark", "delete", 2, true),
                row("bookmark", "update", 3, true),
            ],
        );
        assert_eq!(layer_ops(&revived), vec![("create", 1)]);
    }

    #[test]
    fn folds_new_operations_onto_a_stored_snapshot_object() {
        let base = combine(
            "bookmark",
            vec![
                row("bookmark", "create", 1, true),
                row("bookmark", "update", 2, true),
            ],
        );
        let next = combine_object(
            "bookmark".to_string(),
            Uuid::nil(),
            Some(base),
            vec![row("bookmark", "move", 3, true)],
        )
        .unwrap();
        assert_eq!(next.operation_type, "move");
        assert_eq!(layer_ops(&next), vec![("create", 1), ("update", 2)]);
    }

    #[test]
    fn the_object_fields_are_still_those_of_the_latest_operation() {
        let object = combine(
            "bookmark",
            vec![
                row("bookmark", "create", 1, true),
                row("bookmark", "update", 2, true),
            ],
        );
        // What a client that ignores `layers` has always seen.
        assert_eq!(object.payload, json!({ "op": "update", "n": 2 }));
        assert_eq!(object.lamport_timestamp, 2);
        assert_eq!(object.operation_id, Uuid::from_u128(2));
    }

    #[test]
    fn other_objects_are_unchanged() {
        // History visits and plaintext or mixed objects use the old rules.
        let visit = combine(
            "historyVisit",
            vec![
                row("historyVisit", "visit", 1, true),
                row("historyVisit", "visit", 2, true),
            ],
        );
        assert!(visit.layers.is_empty());
        assert_eq!(visit.lamport_timestamp, 2);

        let mixed = combine(
            "tab",
            vec![
                row("tab", "create", 1, false),
                row("tab", "update", 2, true),
            ],
        );
        assert!(mixed.layers.is_empty());
        assert_eq!(mixed.lamport_timestamp, 2);
    }

    #[test]
    fn layers_are_left_out_of_the_json_when_empty_and_old_snapshots_still_parse() {
        let object = combine("historyVisit", vec![row("historyVisit", "visit", 1, true)]);
        let json = serde_json::to_value(&object).unwrap();
        assert!(json.get("layers").is_none());

        // A snapshot stored before `layers` existed.
        let old: SnapshotObject = serde_json::from_value(json).unwrap();
        assert!(old.layers.is_empty());

        let layered = combine(
            "bookmark",
            vec![
                row("bookmark", "create", 1, true),
                row("bookmark", "update", 2, true),
            ],
        );
        let json = serde_json::to_value(&layered).unwrap();
        assert_eq!(json["layers"][0]["operationType"], "create");
        assert_eq!(json["layers"][0]["lamportTimestamp"], 1);
    }
}
