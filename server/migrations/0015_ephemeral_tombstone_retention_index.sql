-- Versioned migration: 0015_ephemeral_tombstone_retention_index
--
-- `housekeeping::run_once` (server/src/housekeeping.rs) now also sweeps
-- `tombstones` rows for ephemeral object types (`tab`, `window`), filtered
-- on `created_at < cutoff AND object_type IN ('tab', 'window')`. Neither
-- type has a restore path (`vocabulary::is_restore_operation` only matches
-- bookmarks), so once a tab/window tombstone ages past
-- `ephemeral_tombstone_retention_secs` it has nothing left to protect: the
-- object id can never be reused or restored. Bookmark/bookmarkFolder
-- tombstones are intentionally excluded from this sweep (they stay `active`
-- until an explicit `restore`), so the index below is scoped to exactly the
-- two swept types, mirroring the scoping of `idx_tombstones_user_active` in
-- 0011_tombstones_active_index.sql to the predicate every real query
-- actually uses.
CREATE INDEX idx_tombstones_ephemeral_created_at
ON tombstones (created_at)
WHERE object_type IN ('tab', 'window');
