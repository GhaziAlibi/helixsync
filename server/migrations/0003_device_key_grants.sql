-- Versioned migration: 0003_device_key_grants
-- Relays sealed encryption-root-key material between devices belonging to
-- the same account (docs/encryption.md §3). The server only ever stores
-- and forwards an opaque sealed blob plus a signature it cannot verify —
-- it never sees the plaintext root key and cannot authorize a device on
-- its own; trust is established by the *receiving* device verifying the
-- signature against the granting device's known signing public key.

CREATE TABLE device_key_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    granting_device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    sealed_key TEXT NOT NULL,
    signature TEXT NOT NULL,
    key_version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at TIMESTAMPTZ,
    CONSTRAINT uq_device_key_grants_target UNIQUE (target_device_id)
);
