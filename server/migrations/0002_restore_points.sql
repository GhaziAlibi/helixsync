-- Bookmark restore points (docs/protocol.md §16).
--
-- Each row is one encrypted, opaque snapshot of a user's bookmark tree. The
-- server never parses `envelope`. Additive only: constant defaults, no table
-- rewrite, so it is safe on a live database.
CREATE TABLE bookmark_restore_points (
    id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN
        ('manual', 'scheduled', 'pre_restore', 'pre_import', 'pre_resync', 'mass_delete')),
    bookmark_count INT NOT NULL CHECK (bookmark_count >= 0),
    encryption_version INT NOT NULL CHECK (encryption_version >= 0),
    codec TEXT CHECK (codec IN ('deflate-raw')),
    envelope BYTEA NOT NULL,          -- raw envelope JSON text, never parsed
    size_bytes INT NOT NULL CHECK (size_bytes >= 0),
    pinned BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_restored_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, id)
);

CREATE INDEX idx_restore_points_user_created
    ON bookmark_restore_points (user_id, created_at DESC);
CREATE INDEX idx_restore_points_created
    ON bookmark_restore_points (created_at) WHERE NOT pinned;

-- Restore points have their own byte budget and never count against
-- `storage_bytes`, so a full point budget can never block sync.
ALTER TABLE sync_stats ADD COLUMN restore_point_bytes BIGINT NOT NULL DEFAULT 0
    CHECK (restore_point_bytes >= 0);

ALTER TABLE user_settings ADD COLUMN restore_points_automatic BOOLEAN NOT NULL DEFAULT true;
