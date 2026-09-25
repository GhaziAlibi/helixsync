use serde_json::Value;
use uuid::Uuid;

/// Ordering key from docs/protocol.md §8.1: `(lamportTimestamp, deviceId,
/// operationId)`, compared in order, higher wins. The last two are just
/// tie-breakers.
///
/// Snapshots use this to pick each object's current state. Plaintext
/// bookmarks get a per-field merge ([`merge_bookmark_fields`]). Encrypted
/// objects, and all other types, use whole-object last-writer-wins, since
/// the server can't read encrypted fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct OrderingKey {
    pub lamport_timestamp: i64,
    pub device_id: Uuid,
    pub operation_id: Uuid,
}

/// Merges a plaintext bookmark/bookmarkFolder history (sorted ascending by
/// [`OrderingKey`]) into its current state. Mirrors `resolveField` in
/// `extension/src/sync/conflict.ts` (docs/protocol.md §8.2):
///
/// - `title` and `url` are each taken from the last op that set them, so
///   concurrent edits to different fields both survive.
/// - `parent`/`position` come together from the last op that set both.
///
/// Other fields are copied from the latest payload.
///
/// Returns `None` if no title or move state was ever set (the caller then
/// falls back to whole-object LWW).
pub fn merge_bookmark_fields(payloads_ascending: &[Value]) -> Option<Value> {
    let mut title: Option<&Value> = None;
    let mut url: Option<&Value> = None;
    let mut mv: Option<(&Value, &Value)> = None;

    for payload in payloads_ascending {
        if let Some(t) = payload.get("title") {
            title = Some(t);
        }
        if let Some(u) = payload.get("url") {
            url = Some(u);
        }
        if let (Some(parent), Some(position)) = (payload.get("parent"), payload.get("position")) {
            mv = Some((parent, position));
        }
    }

    let title = title?.clone();
    let (parent, position) = mv?;
    let (parent, position) = (parent.clone(), position.clone());
    let url = url.cloned().unwrap_or(Value::Null);

    // Start from the latest payload so fields we don't merge (dateAdded,
    // tags, ...) are kept, then overwrite the merged fields.
    let mut merged = payloads_ascending
        .last()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    merged.insert("title".to_string(), title);
    merged.insert("url".to_string(), url);
    merged.insert("parent".to_string(), parent);
    merged.insert("position".to_string(), position);

    Some(Value::Object(merged))
}
