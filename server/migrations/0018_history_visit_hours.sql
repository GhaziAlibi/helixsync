-- Versioned migration: 0018_history_visit_hours
--
-- `sync_stats.history_visit_count` (and the `historyVisit` rows it's
-- derived from) is keyed on upload time (`sync_operations.created_at`),
-- not real visit time — payloads are end-to-end encrypted, so this was the
-- only timestamp the server could see. That means a one-time bulk import
-- counts in full for a whole retention window measured from *upload* time,
-- then drops out all at once, instead of following the browser's own
-- rolling window measured from *visit* time (docs/protocol.md §8.3.2).
--
-- Fix: the extension now optionally sends `visitHours`, a per-hour visit
-- COUNT histogram, in plaintext (URLs/titles stay encrypted in `payload` —
-- only counts are ever exposed). This table accumulates those counts,
-- independent of `sync_operations`/`sync::compaction`'s upload-time-based
-- pruning, so a bucket survives its originating operation being compacted
-- away. `sync::routes::stats` sums buckets at or after the account's
-- retention cutoff instead of reading `sync_stats.history_visit_count`.
--
-- `sync_stats.history_visit_count` itself is left as-is (still written by
-- `sync::routes::process_batch` and `sync::compaction::compact_user`) —
-- it's simply no longer read by `/stats`. Removing it outright would be a
-- larger, riskier change for no correctness benefit.
--
-- `sync_stats.history_hours_seed_before` marks accounts that predate this
-- migration: existing rows are stamped with the current time so
-- `sync::routes::stats` knows to seed `history_visit_hours` once, lazily,
-- from their existing live `historyVisit` objects (bucketed by
-- `created_at`, since real visit time was never recorded before this
-- migration) before it can trust the new table for them. Rows created after
-- this migration (by `process_batch`'s upsert, or by `compact_user`'s
-- reconciliation) leave this column at its default of NULL — they were
-- always written by a build that already populates `history_visit_hours`
-- directly, so there is nothing to seed.
CREATE TABLE history_visit_hours (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hour TIMESTAMPTZ NOT NULL,
    visits BIGINT NOT NULL CHECK (visits >= 0),
    PRIMARY KEY (user_id, hour)
);

ALTER TABLE sync_stats ADD COLUMN history_hours_seed_before TIMESTAMPTZ NULL;
UPDATE sync_stats SET history_hours_seed_before = now();
