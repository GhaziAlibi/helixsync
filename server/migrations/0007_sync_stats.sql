-- Versioned migration: 0007_sync_stats
--
-- Fixes a performance bug in `sync::routes::stats` (`GET /api/v1/sync/stats`,
-- the web dashboard's bookmark/history/tab counters): on every 30-second
-- `STATS_CACHE` miss it called `compute_objects`, which — purely to produce
-- three integer counts — deserializes the *entire* latest `sync_snapshots`
-- row's `data` JSONB column (every live bookmark/tab/historyVisit for the
-- account, potentially 50,000+ entries with full encrypted payloads) into a
-- `HashMap`. For a large account that's a recurring, unbounded-with-history
-- CPU/memory cost paid just to answer "how many of each type do you have".
--
-- The fix is this small, dedicated per-user counts table, kept fresh by
-- three cooperating mechanisms — no single one of them is "the" source of
-- truth on its own, which is why all three exist together:
--
--   1. Incremental upkeep in `sync::routes::process_batch`: every accepted
--      upload batch computes a net per-bucket delta (originations minus
--      tombstones plus restores, per docs/protocol.md's object lifecycle)
--      and applies it via an atomic upsert in the same transaction as the
--      rest of the batch. Cheap, but *approximate by construction* in the
--      sense that it only ever sees deltas — any bug in the delta math, or
--      any write path that bypasses `process_batch`, would drift it.
--
--   2. Authoritative reconciliation in `sync::compaction::compact_user`:
--      every time compaction actually persists a new snapshot for a user,
--      it counts the live (post-tombstone-filter) object set it's already
--      holding in memory for that snapshot and *overwrites* (not
--      increments) this table with the true count. This bounds any
--      possible drift from mechanism 1 to at most one compaction interval,
--      and is what correctly initializes the row for any account that had
--      operations before this migration shipped, the first time compaction
--      runs for them post-upgrade.
--
--   3. Lazy backfill in the `/stats` handler itself: if no row exists yet
--      for a user (an account with no accepted operation and no compaction
--      pass since upgrading — the narrow gap mechanisms 1 and 2 don't cover
--      until one of them runs), it falls back to the old expensive
--      `compute_objects`-based computation exactly once, and persists the
--      result here so every subsequent request takes the fast path.
--
-- No backfill in this migration itself (unlike `0006_sync_objects.sql`,
-- which had to backfill synchronously because ownership correctness
-- couldn't wait) — correctness for existing accounts is handled lazily by
-- mechanisms 2 and 3 above instead, since a stale/missing count here is
-- merely a perf/staleness concern, not a data-loss one.
CREATE TABLE sync_stats (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bookmark_count INT NOT NULL DEFAULT 0,
    history_visit_count INT NOT NULL DEFAULT 0,
    tab_count INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
