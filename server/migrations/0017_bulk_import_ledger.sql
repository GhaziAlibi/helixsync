-- Versioned migration: 0017_bulk_import_ledger
--
-- Companion backfill for `sync::routes::process_batch`'s bulk-history
-- permanent-dedup fix: a `historyVisit`/`bulkImport` op's `object_id` is now
-- recorded in `sync_objects` (the never-pruned existence ledger, see
-- `0006_sync_objects.sql`) so a retry after `sync::compaction` has deleted
-- its `sync_operations` row still resolves as a duplicate instead of
-- double-counting `sync_stats.history_visit_count`. Before this change, bulk
-- rows were explicitly excluded from that ledger (see the old comment this
-- migration's code change removes from `process_batch`), so no bulk object
-- accepted before this deploy has a ledger row yet.
--
-- This backfills only from rows that still exist in `sync_operations` —
-- i.e. bulk imports that have not yet been folded into a snapshot and
-- pruned. A chunk that was *already* compacted before this deploy exists
-- only inside a compressed `sync_snapshots.data` blob, which plain SQL
-- can't unpack cheaply at migration time; those are healed instead by
-- `sync::compaction::compact_user`, which now writes a ledger row for every
-- bulk object it folds into a snapshot, `ON CONFLICT DO NOTHING`, on every
-- future compaction run — so any object missed here is caught on its next
-- compaction pass regardless.
INSERT INTO sync_objects (user_id, object_type, object_id, created_at)
SELECT user_id, object_type, object_id, MIN(created_at)
FROM sync_operations
WHERE object_type = 'historyVisit' AND operation_type = 'bulkImport'
GROUP BY user_id, object_type, object_id
ON CONFLICT DO NOTHING;
