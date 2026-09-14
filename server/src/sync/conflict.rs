use serde_json::Value;
use uuid::Uuid;

/// The universal ordering key from docs/protocol.md §8.1:
/// `(lamportTimestamp, deviceId, operationId)`, compared lexicographically,
/// higher wins. `deviceId`/`operationId` are pure tie-breakers with no
/// semantic meaning.
///
/// The server uses this ordering to compute "current state" for snapshots
/// (docs/protocol.md §10.3) via a SQL `ORDER BY` mirroring this tuple — see
/// `sync::routes::snapshot`. For `bookmark`/`bookmarkFolder` objects whose
/// entire operation history is unencrypted, [`merge_bookmark_fields`] below
/// ports the per-field reduction of docs/protocol.md §8.2 (mirroring
/// `resolveField` in `extension/src/sync/conflict.ts`) so the snapshot
/// reflects independently-merged `title`/`url`/move state rather than one
/// operation's whole payload. When any contributing operation is encrypted
/// (`encryptionVersion >= 1`, the production default per
/// `docs/encryption.md`), the server holds no plaintext for that object's
/// fields at all — true end-to-end encryption means it is cryptographically
/// impossible to read into the ciphertext to merge fields, so those objects
/// (and all other object types, which don't need field-level merge) still
/// fall back to whole-object LWW: the single winning operation's full
/// payload, chosen by this same ordering tuple.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct OrderingKey {
    pub lamport_timestamp: i64,
    pub device_id: Uuid,
    pub operation_id: Uuid,
}

/// Reduce a bookmark/bookmarkFolder object's full plaintext operation
/// history (already sorted ascending by [`OrderingKey`] — the caller's SQL
/// `ORDER BY` guarantees this) into its merged current-state payload,
/// mirroring `resolveField` in `extension/src/sync/conflict.ts` field by
/// field per docs/protocol.md §8.2:
///
/// - `title` and `url` are resolved independently: whichever operation last
///   touched that specific field (in ascending-key order — since keys only
///   increase, "last touching write" is exactly the §8.1 winner) supplies
///   the merged value, so a concurrent title change on one device and a url
///   change on another both survive.
/// - `parent`/`position` (the compound `move` field) are resolved together
///   from whichever operation last carried *both*, so a bookmark never ends
///   up with a parent from one operation and a position from another.
///
/// Returns `None` if the history never establishes a title or move state at
/// all (shouldn't happen — `create` always sets both — but the object-level
/// caller falls back to whole-object LWW if so).
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

    let title = title?;
    let (parent, position) = mv?;
    Some(serde_json::json!({
        "title": title,
        "url": url.cloned().unwrap_or(Value::Null),
        "parent": parent,
        "position": position,
    }))
}
