// Rebuilds each object's current state from the latest stored snapshot plus
// newer ops, and stores snapshots compressed. Used by `/snapshot`, `/stats`,
// and compaction.
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use uuid::Uuid;

use crate::error::AppResult;

use super::conflict::OrderingKey;
use super::model::SnapshotObject;
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
            });
        }
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
    })
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
/// rows) and plain JSON (rows converted by migration
/// `0008_compress_sync_snapshots.sql`).
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
