-- Versioned migration: 0012_terminal_compaction_index
--
-- `prune_compacted_operations` (server/src/sync/compaction.rs) queries for
-- operations with `operation_type IN ('delete', 'close')` under a certain
-- `server_cursor`. Before this, `sync_operations` only had indexes on 
-- `(user_id, server_cursor)` and `(user_id, object_type, object_id)`.
-- Without an index covering `operation_type`, PostgreSQL must scan every
-- operation up to `server_cursor` and visit the heap to filter out rows
-- that are not terminal operations. For active accounts, this causes
-- unnecessary disk I/O and buffer cache churn during compaction runs.
-- This partial index only tracks terminal operations, making the initial
-- candidate query extremely cheap.
CREATE INDEX idx_sync_operations_terminal
ON sync_operations (user_id, server_cursor)
WHERE operation_type IN ('delete', 'close');
