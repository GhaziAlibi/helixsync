-- Versioned migration: 0014_sync_stats_bigint
--
-- `sync_stats` counters (migrations/0007_sync_stats.sql) were INT with no
-- upper bound tied to the validation in `sync::routes::process_batch`,
-- which accepted a `bulkImport` `visitCount` up to `i32::MAX`. A tiny
-- payload could declare `visitCount: 2147483647`; the very next batch's
-- incremental upsert (`history_visit_count + EXCLUDED.history_visit_count`)
-- then overflowed the INT column (Postgres `22003 integer_out_of_range`),
-- rolling back the whole transaction and permanently failing every future
-- batch for that account — compaction's authoritative reconciliation
-- saturated at `i32::MAX` too, so it never repaired the account either.
--
-- Paired with `sync::routes::MAX_VISIT_COUNT_PER_OP` (a 1,000,000 ceiling
-- on `visitCount` per operation, applied at validation time) and the
-- `GREATEST`-clamped upsert in `process_batch`, this migration removes the
-- overflow ceiling by widening all three counters to BIGINT, and adds a
-- CHECK >= 0 so a negative net delta (e.g. a first-ever batch that only
-- deletes pre-existing bookmarks) can never persist a negative count
-- instead of clamping to zero.
ALTER TABLE sync_stats ALTER COLUMN bookmark_count TYPE BIGINT;
ALTER TABLE sync_stats ALTER COLUMN history_visit_count TYPE BIGINT;
ALTER TABLE sync_stats ALTER COLUMN tab_count TYPE BIGINT;

ALTER TABLE sync_stats ADD CONSTRAINT sync_stats_bookmark_count_non_negative CHECK (bookmark_count >= 0);
ALTER TABLE sync_stats ADD CONSTRAINT sync_stats_history_visit_count_non_negative CHECK (history_visit_count >= 0);
ALTER TABLE sync_stats ADD CONSTRAINT sync_stats_tab_count_non_negative CHECK (tab_count >= 0);
