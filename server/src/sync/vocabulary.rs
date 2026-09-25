/// Allowed operation types per object type (docs/protocol.md §6). Unknown
/// combinations are rejected. New types may be added in later protocol
/// versions, so keep changes backward compatible.
pub fn is_known_object_type(object_type: &str) -> bool {
    matches!(
        object_type,
        "bookmark"
            | "bookmarkFolder"
            | "historyVisit"
            | "tab"
            | "window"
            | "tabGroup"
            | "extensionMeta"
            | "extensionStorageEntry"
    )
}

pub fn allowed_operation_types(object_type: &str) -> &'static [&'static str] {
    match object_type {
        "bookmark" | "bookmarkFolder" => &["create", "update", "move", "delete", "restore"],
        "historyVisit" => &["visit", "bulkImport"],
        "tab" => &["create", "update", "close", "activate", "move"],
        "window" => &["create", "update", "close"],
        "tabGroup" => &["create", "update", "delete"],
        "extensionMeta" => &["observe"],
        "extensionStorageEntry" => &["set", "delete"],
        _ => &[],
    }
}

/// Operation types that create a tombstone for the object (docs/protocol.md §9).
pub fn is_terminal_operation(object_type: &str, operation_type: &str) -> bool {
    matches!(
        (object_type, operation_type),
        ("bookmark", "delete")
            | ("bookmarkFolder", "delete")
            | ("tab", "close")
            | ("window", "close")
            | ("tabGroup", "delete")
            | ("extensionStorageEntry", "delete")
    )
}

/// Operation types that clear a tombstone. Only bookmark `restore`
/// (docs/protocol.md §8.2); other types get a new objectId instead.
pub fn is_restore_operation(object_type: &str, operation_type: &str) -> bool {
    matches!(
        (object_type, operation_type),
        ("bookmark", "restore") | ("bookmarkFolder", "restore")
    )
}

/// Operation types that may create a new objectId (no prior owner needed).
///
/// `extensionMeta`/`observe` and `extensionStorageEntry`/`set` are upserts
/// with no separate `create`, so they must be allowed to create the object,
/// like `historyVisit`. Otherwise they'd never pass the ownership check in
/// `process_batch`.
pub fn is_origination_operation(object_type: &str, operation_type: &str) -> bool {
    matches!(operation_type, "create")
        || matches!(object_type, "historyVisit")
        || matches!((object_type, operation_type), ("extensionMeta", "observe"))
        || matches!(
            (object_type, operation_type),
            ("extensionStorageEntry", "set")
        )
}
