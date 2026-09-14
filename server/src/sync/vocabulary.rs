/// Operation-type vocabulary per docs/protocol.md §6. The server enforces
/// this so malformed/unknown combinations are rejected up front, but per
/// §13 (protocol compatibility) this list is expected to grow over protocol
/// minor versions — additions here must stay backward compatible (old
/// clients simply won't send the new types).
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
        "historyVisit" => &["visit"],
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

/// Operation types that explicitly clear an existing tombstone (currently
/// only bookmark `restore`, per docs/protocol.md §8.2 — other object types
/// recreate under a fresh objectId instead of un-tombstoning).
pub fn is_restore_operation(object_type: &str, operation_type: &str) -> bool {
    matches!((object_type, operation_type), ("bookmark", "restore") | ("bookmarkFolder", "restore"))
}

/// Operation types that may originate an objectId for the first time
/// (i.e. do not require a prior operation to already own the object).
pub fn is_origination_operation(object_type: &str, operation_type: &str) -> bool {
    matches!(operation_type, "create") || matches!(object_type, "historyVisit")
}
