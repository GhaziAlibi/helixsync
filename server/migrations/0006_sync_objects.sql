-- Versioned migration: 0006_sync_objects
--
-- Fixes a real data-loss bug: `sync::routes::process_batch`'s ownership
-- pre-check for non-origination operations (an `update`/`move`/`delete`/
-- `close`/`activate`/... on an object that must already exist) queried
-- `sync_operations` directly to decide whether the caller's user already
-- owns `(object_type, object_id)`. That works right up until
-- `sync::compaction::compact_user` runs: compaction folds every operation
-- below a user's ack boundary into a `sync_snapshots` row and then deletes
-- *all* of those raw `sync_operations` rows, including an object's
-- originating `create`. Once that happens the object's rows are gone from
-- `sync_operations` entirely (it lives on only inside the opaque
-- `sync_snapshots.data` JSONB blob), so the ownership pre-check can never
-- again find it — every subsequent legitimate edit to that object (a
-- rename, a move, closing a tab, ...) is permanently rejected
-- `object_not_found`. The extension treats that rejection as a retriable
-- ordering race, requeues it for a bounded number of cycles, then silently
-- gives up — real, silent data loss for any account old enough that
-- compaction has run (default hourly).
--
-- The fix is a dedicated object-existence ledger that is *never* touched by
-- compaction — deliberately decoupled from `sync_operations`'s own
-- retention/compaction lifecycle, so an object's ownership record survives
-- forever regardless of how much of its operation history has been folded
-- into snapshots and swept away. This table intentionally has no retention
-- policy and no TTL: it exists to answer exactly one question ("has this
-- user ever originated this object?") for as long as the object could ever
-- be referenced again, which is indefinitely.
--
-- IMPORTANT: no future compaction/retention pass may `DELETE FROM
-- sync_objects` for a live object. The only correct removal path (not
-- implemented today) would be tied to full account deletion via
-- `ON DELETE CASCADE` on `user_id`, not to operation-log aging.
CREATE TABLE sync_objects (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    object_type TEXT NOT NULL,
    object_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, object_type, object_id)
);

-- Backfill for existing deployments: without this, upgrading a server that
-- already has compacted accounts would leave every already-compacted
-- object permanently unresolvable even after this migration ships, since
-- `sync_objects` would start out empty for them.
--
-- 1) Anything still present in `sync_operations` (i.e. not yet compacted
--    away) trivially proves the user owns that object.
INSERT INTO sync_objects (user_id, object_type, object_id)
SELECT DISTINCT user_id, object_type, object_id
FROM sync_operations
ON CONFLICT DO NOTHING;

-- 2) Anything that *has* already been compacted only still exists inside a
--    persisted `sync_snapshots.data` blob — a JSONB array of objects
--    serialized from `SnapshotObject` (server/src/sync/model.rs) with
--    camelCase field names `objectType` (text) and `objectId`
--    (uuid-as-text). Unnest every snapshot ever taken for every user and
--    backfill from those too, so no previously-compacted object is left
--    permanently un-editable by this migration.
INSERT INTO sync_objects (user_id, object_type, object_id)
SELECT DISTINCT s.user_id,
       elem->>'objectType',
       (elem->>'objectId')::uuid
FROM sync_snapshots s,
     jsonb_array_elements(s.data) AS elem
ON CONFLICT DO NOTHING;
