-- HelixSync initial schema
-- Versioned migration: 0001_init

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
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
    public_key TEXT,
    signing_public_key TEXT,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_sync_operations_operation_id UNIQUE (operation_id),
    CONSTRAINT uq_sync_operations_device_sequence UNIQUE (device_id, device_sequence),
    CONSTRAINT uq_sync_operations_server_cursor UNIQUE (user_id, server_cursor)
);

CREATE INDEX idx_sync_operations_user_cursor ON sync_operations(user_id, server_cursor);
CREATE INDEX idx_sync_operations_object ON sync_operations(user_id, object_type, object_id);

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

CREATE TABLE sync_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    snapshot_cursor BIGINT NOT NULL,
    encryption_version INT NOT NULL DEFAULT 0,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_snapshots_user ON sync_snapshots(user_id, snapshot_cursor DESC);

CREATE TABLE tombstones (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    object_type TEXT NOT NULL,
    object_id UUID NOT NULL,
    deleted_at_cursor BIGINT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_tombstones_object UNIQUE (user_id, object_type, object_id)
);

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

CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
