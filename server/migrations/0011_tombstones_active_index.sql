-- Versioned migration: 0011_tombstones_active_index
--
-- `tombstones` only had `uq_tombstones_object` on
-- `(user_id, object_type, object_id)`, with no index covering `active`.
-- But every read of the table — `snapshot` and `stats` (server/src/sync/routes.rs)
-- and `compact_user` (server/src/sync/compaction.rs) — runs the same shape:
--     SELECT object_type, object_id FROM tombstones WHERE user_id = $1 AND active = true
-- Postgres can use the unique index to narrow to `user_id`, but still has to
-- visit the heap and filter `active` row by row, so the scan cost grows with
-- the lifetime count of tombstoned objects for an account, not just the
-- currently-active ones. No query anywhere filters `active = false` or reads
-- the table without the `active = true` predicate, so a partial index on
-- exactly that predicate is smaller and cheaper to maintain than a full
-- `(user_id, active, object_type, object_id)` index would be, and it still
-- covers every real query. It also carries `object_type, object_id` as index
-- columns, which are exactly the two columns those queries select, so this
-- can serve as an index-only scan with no heap access at all.
CREATE INDEX idx_tombstones_user_active
ON tombstones (user_id, object_type, object_id)
WHERE active = true;
