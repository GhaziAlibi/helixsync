-- HelixSync schema

-- Password-wrapped account key (SEC-01): the password never reaches the
-- server. The client derives a master key M = Argon2id(password, kdf_salt,
-- kdf_params) locally, splits it into authKey (sent here, hashed into
-- password_hash exactly like a password used to be) and a KEK that never
-- leaves the client. The account's actual encryption root, a random 32-byte
-- account key, is generated once client-side and stored here only in its
-- wrapped (KEK-encrypted) form — opaque to the server.
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    kdf_salt TEXT NOT NULL,
    kdf_params JSONB NOT NULL,
    wrapped_account_key TEXT NOT NULL,
    account_key_version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User-level synchronization configuration (dashboard §29 / extension options §30).
CREATE TABLE user_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sync_bookmarks BOOLEAN NOT NULL DEFAULT true,
    sync_history BOOLEAN NOT NULL DEFAULT true,
    sync_tabs BOOLEAN NOT NULL DEFAULT false,
    sync_tab_groups BOOLEAN NOT NULL DEFAULT false,
    sync_extensions BOOLEAN NOT NULL DEFAULT false,
    tab_restore_policy TEXT NOT NULL DEFAULT 'disabled'
        CHECK (tab_restore_policy IN ('disabled', 'ask', 'automatic')),
    history_retention TEXT NOT NULL DEFAULT '30d'
        CHECK (history_retention IN ('7d', '30d', '90d', '1y', 'unlimited')),
    require_encryption BOOLEAN NOT NULL DEFAULT false,
    extension_storage_allowlist JSONB NOT NULL DEFAULT '[]',
    extension_storage_denylist JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    browser TEXT,
    browser_version TEXT,
    platform TEXT,
    extension_version TEXT,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    -- Last accepted `sync_operations.device_sequence` for this device.
    -- Persisted here (rather than derived via `MAX(device_sequence)` from
    -- `sync_operations`) because compaction deletes the raw operation rows
    -- once folded into a snapshot, which would otherwise make a fully
    -- compacted device's sequence unrecoverable and let it silently reuse
    -- old sequence numbers.
    last_device_sequence BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_devices_user_id ON devices(user_id);

CREATE TABLE device_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    credential_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ
);

CREATE INDEX idx_device_credentials_device_id ON device_credentials(device_id);
CREATE INDEX idx_device_credentials_credential_hash ON device_credentials(credential_hash);
CREATE INDEX idx_device_credentials_expires_at ON device_credentials(expires_at);

CREATE TABLE sync_operations (
    id BIGSERIAL PRIMARY KEY,
    operation_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    device_sequence BIGINT NOT NULL,
    lamport_timestamp BIGINT NOT NULL,
    server_cursor BIGINT NOT NULL,
    object_type TEXT NOT NULL,
    object_id UUID NOT NULL,
    operation_type TEXT NOT NULL,
    encryption_version INT NOT NULL DEFAULT 0,
    payload JSONB NOT NULL,
    -- How many plaintext visits this row represents. Set for
    -- `historyVisit`/`bulkImport` rows, NULL otherwise; NULL means "one
    -- visit" so readers use `COALESCE(visit_count, 1)` / `unwrap_or(1)`.
    visit_count INTEGER NULL,
    -- Exact byte length of `payload`'s original wire text, recorded at
    -- insert (`sync::routes::process_batch`). Not derivable from `payload`
    -- itself afterwards: Postgres reformats JSONB on write (whitespace,
    -- key order, numeric literals), so `octet_length(payload::text)` would
    -- drift from what was actually charged against the account's storage
    -- quota. Compaction's prune sums this column to credit back exactly
    -- what each deleted row added, so `sync_stats.storage_bytes` can never
    -- drift away from the truth over an insert+delete cycle.
    payload_bytes INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_sync_operations_operation_id UNIQUE (operation_id),
    CONSTRAINT uq_sync_operations_device_sequence UNIQUE (device_id, device_sequence),
    CONSTRAINT uq_sync_operations_server_cursor UNIQUE (user_id, server_cursor)
);

CREATE INDEX idx_sync_operations_user_cursor ON sync_operations(user_id, server_cursor);
CREATE INDEX idx_sync_operations_object ON sync_operations(user_id, object_type, object_id);

-- Terminal-operation lookups (`prune_compacted_operations`) only ever filter
-- on `operation_type IN ('delete', 'close')`, so this partial index keeps
-- that scan cheap without covering every operation type.
CREATE INDEX idx_sync_operations_terminal
ON sync_operations (user_id, server_cursor)
WHERE operation_type IN ('delete', 'close');

-- sync_cursors serves two roles distinguished by device_id:
--   device_id IS NULL  -> per-user server_cursor allocator (single row)
--   device_id NOT NULL -> per-device last-acknowledged cursor (for compaction eligibility)
CREATE TABLE sync_cursors (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    cursor_value BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_sync_cursors_user_device UNIQUE NULLS NOT DISTINCT (user_id, device_id)
);

-- `data` holds an account's entire merged object set, gzip-compressed by the
-- application before write (`sync::routes::compress_snapshot_data`) — BYTEA
-- rather than JSONB so Postgres never has to de-TOAST and re-serialize a
-- multi-hundred-MB JSON document on every compaction pass or snapshot fetch.
CREATE TABLE sync_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    snapshot_cursor BIGINT NOT NULL,
    encryption_version INT NOT NULL DEFAULT 0,
    data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_snapshots_user ON sync_snapshots(user_id, snapshot_cursor DESC);

-- Dedicated object-existence ledger, deliberately decoupled from
-- `sync_operations`'s compaction/retention lifecycle: it exists to answer
-- "has this user ever originated this object?" for as long as the object
-- could ever be referenced again, which is indefinitely. No future
-- compaction/retention pass may delete a live object's row here; the only
-- correct removal path is full account deletion via `ON DELETE CASCADE` on
-- `user_id`.
CREATE TABLE sync_objects (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    object_type TEXT NOT NULL,
    object_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, object_type, object_id)
);

-- Per-user object counts, kept fresh by process_batch's incremental deltas,
-- compaction's authoritative reconciliation, and the /stats handler's lazy
-- backfill — avoids deserializing an account's entire snapshot just to
-- answer "how many of each type do you have".
CREATE TABLE sync_stats (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bookmark_count BIGINT NOT NULL DEFAULT 0 CHECK (bookmark_count >= 0),
    history_visit_count BIGINT NOT NULL DEFAULT 0 CHECK (history_visit_count >= 0),
    tab_count BIGINT NOT NULL DEFAULT 0 CHECK (tab_count >= 0),
    -- Sum of `sync_operations.payload_bytes` currently on-disk for this
    -- account (F-04): incremented by `process_batch` on insert, decremented
    -- by compaction's prune on delete, so it always tracks the operation
    -- log's real size. Checked against `Config::max_account_storage_bytes`
    -- before a new upload is accepted.
    storage_bytes BIGINT NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Marks accounts that predate `history_visit_hours`: stamped so
    -- `sync::routes::stats` knows to seed that table once, lazily, from
    -- existing live `historyVisit` objects before trusting it. NULL for
    -- accounts created by a build that already writes `history_visit_hours`
    -- directly.
    history_hours_seed_before TIMESTAMPTZ NULL
);

-- Per-hour visit-count histogram, keyed on real visit time rather than
-- upload time, so a rolling retention window follows the browser's own
-- notion of "recent" (docs/protocol.md §8.3.2) instead of the time an
-- operation happened to be uploaded. Independent of `sync_operations`
-- pruning, so a bucket survives its originating operation being compacted
-- away.
CREATE TABLE history_visit_hours (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hour TIMESTAMPTZ NOT NULL,
    visits BIGINT NOT NULL CHECK (visits >= 0),
    PRIMARY KEY (user_id, hour)
);

CREATE TABLE tombstones (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    object_type TEXT NOT NULL,
    object_id UUID NOT NULL,
    deleted_at_cursor BIGINT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    -- Ordering key of the deleting operation itself (docs/protocol.md §8.1),
    -- compared against an object's current winning operation so an old
    -- delete can never erase an object a concurrent/later update should
    -- have kept alive.
    lamport_timestamp BIGINT NOT NULL,
    device_id UUID NOT NULL,
    operation_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_tombstones_object UNIQUE (user_id, object_type, object_id)
);

-- Every read of this table filters `user_id = $1 AND active = true` and
-- selects only `object_type, object_id`; scoping the index to that exact
-- predicate and column set makes it an index-only scan.
CREATE INDEX idx_tombstones_user_active
ON tombstones (user_id, object_type, object_id)
WHERE active = true;

-- `tab`/`window` tombstones have no restore path, so once one ages past
-- `ephemeral_tombstone_retention_secs` it has nothing left to protect;
-- scoped to just those two types since bookmark/bookmarkFolder tombstones
-- stay active until an explicit restore.
CREATE INDEX idx_tombstones_ephemeral_created_at
ON tombstones (created_at)
WHERE object_type IN ('tab', 'window');

CREATE TABLE web_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    user_agent TEXT,
    ip_address TEXT
);

CREATE INDEX idx_web_sessions_user ON web_sessions(user_id);
CREATE INDEX idx_web_sessions_session_hash ON web_sessions(session_hash);
CREATE INDEX idx_web_sessions_expires_at ON web_sessions(expires_at);

CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
