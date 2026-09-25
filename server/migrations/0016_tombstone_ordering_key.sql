-- SERVER_AUDIT.md H3: tombstones ignored the universal ordering key
-- (docs/protocol.md §8.1), so an old delete could permanently erase an
-- object a concurrent/later update should have kept alive. Filtering now
-- needs the deleting operation's own ordering key to compare against the
-- object's current winning operation.
ALTER TABLE tombstones
    ADD COLUMN lamport_timestamp BIGINT,
    ADD COLUMN device_id UUID,
    ADD COLUMN operation_id UUID;

-- Backfill from the originating delete's row when it's still present in
-- sync_operations (not yet pruned by compaction).
UPDATE tombstones t
SET lamport_timestamp = o.lamport_timestamp,
    device_id = o.device_id,
    operation_id = o.operation_id
FROM sync_operations o
WHERE o.user_id = t.user_id
  AND o.object_type = t.object_type
  AND o.object_id = t.object_id
  AND o.server_cursor = t.deleted_at_cursor;

-- A tombstone whose originating row was already compacted away has, under
-- the old unconditional-filter behavior, already permanently removed its
-- object from every persisted snapshot. Backfilling it with the maximum
-- possible ordering key preserves that pre-existing outcome (it keeps
-- "winning") instead of silently resurrecting history the old code already
-- discarded; the fix only changes behavior for tombstones recorded from
-- here on.
UPDATE tombstones
SET lamport_timestamp = 9223372036854775807,
    device_id = '00000000-0000-0000-0000-000000000000',
    operation_id = '00000000-0000-0000-0000-000000000000'
WHERE lamport_timestamp IS NULL;

ALTER TABLE tombstones
    ALTER COLUMN lamport_timestamp SET NOT NULL,
    ALTER COLUMN device_id SET NOT NULL,
    ALTER COLUMN operation_id SET NOT NULL;
