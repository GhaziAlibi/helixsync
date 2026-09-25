-- Versioned migration: 0009_devices_last_sequence
--
-- Fixes a correctness + performance bug in `sync::routes::process_batch`'s
-- device-sequence validation. That check previously determined a device's
-- last-used `device_sequence` (the strict monotonic ordering guard: an
-- accepted op must have `device_sequence > last_seq`, see the
-- `sequence_conflict` rejection) via `SELECT MAX(device_sequence) FROM
-- sync_operations WHERE device_id = $1` on every upload. Two problems:
--
--   1. Cost: a lookup against `sync_operations` on every single upload,
--      even though this table is exactly the one `sync::compaction` exists
--      to keep small — every upload paid an index scan to re-derive a fact
--      that changes by exactly one write per batch.
--
--   2. Correctness (the real bug): once `sync::compaction::compact_user`
--      folds a device's operations into a snapshot and deletes the
--      underlying `sync_operations` rows (the same lifecycle
--      `0006_sync_objects.sql` documents for the ownership check), a device
--      with *zero* remaining rows in `sync_operations` — e.g. one that's
--      been idle since the last compaction pass folded away everything it
--      ever sent — makes `MAX(device_sequence)` return NULL, coalesced to
--      0. The device's real last sequence number could be arbitrarily
--      higher. Resetting the check to 0 lets that device's next upload
--      reuse `device_sequence` values it already used and had accepted
--      before compaction ran, silently colliding with its own prior
--      history instead of being correctly rejected as `sequence_conflict`.
--
-- The fix is to stop deriving this from `sync_operations` at all and
-- instead persist it directly on `devices`, maintained transactionally by
-- `process_batch` every time a batch actually advances it (see the
-- corresponding code change in `sync::routes::process_batch`). This is safe
-- under the same per-device `pg_advisory_xact_lock` that already serializes
-- concurrent uploads from one device for the old query.
ALTER TABLE devices ADD COLUMN last_device_sequence BIGINT NOT NULL DEFAULT 0;

-- Backfill for existing deployments: without this, upgrading would start
-- every existing device's counter at 0 — the exact bug this migration
-- fixes, just moved to happen once at migration time instead of on every
-- compaction cycle thereafter.
--
-- `sync_operations`' current MAX(device_sequence) per device is the best
-- available signal at migration time, and it's applied here. But it is
-- known to be insufficient for a device that has *already* been fully
-- compacted as of right now, before this migration ever runs: compaction
-- deletes the raw rows this backfill reads, and unlike `sync_objects`
-- (0006_sync_objects.sql), a device's true last `device_sequence` cannot be
-- recovered from `sync_snapshots` either — `SnapshotObject`
-- (server/src/sync/model.rs) only carries `object_type`/`object_id`/
-- `operation_type`/`encryption_version`/`payload` per merged object, never
-- the originating device_id/device_sequence of the operations folded into
-- it. That information is simply gone once compacted; there is no
-- surviving source of truth to reconstruct it from at migration time.
--
-- Practical impact of that gap: a device that is already fully compacted
-- (no rows left in `sync_operations`) at the moment this migration runs
-- starts its `last_device_sequence` at 0 here, same as today's bug — this
-- migration does not retroactively fix that specific device's history. What
-- it does fix is every case going forward from this deploy on: any device
-- with at least one surviving row gets its true known sequence restored
-- correctly, and from this point forward `process_batch` keeps
-- `last_device_sequence` continuously up to date on every accepted batch,
-- so no device can ever again go through a compaction pass and lose this
-- number — the recurrence of the bug is what this migration eliminates,
-- even though it cannot perfectly repair already-compacted history at the
-- instant it runs.
UPDATE devices d
SET last_device_sequence = COALESCE(
    (SELECT MAX(so.device_sequence) FROM sync_operations so WHERE so.device_id = d.id),
    0
);
