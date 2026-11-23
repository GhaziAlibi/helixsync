-- Selective-sync rulesets (docs/protocol.md §17). Additive only: two new
-- tables and a backfill, no change to an existing table, so it is safe on a
-- live database and backward compatible with extensions that don't know
-- about rulesets.
--
-- A ruleset's contents (name, rules) are end-to-end encrypted by the
-- dashboard; the server stores the opaque `envelope` and which devices are
-- assigned to which ruleset.
CREATE TABLE sync_rulesets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Bumped on every envelope write. Bound into the envelope's AAD
    -- (docs/encryption.md §6.5) and checked with `If-Match`.
    revision BIGINT NOT NULL DEFAULT 1,
    is_default BOOLEAN NOT NULL DEFAULT false,
    -- NULL only for a Default ruleset nobody has edited yet: "no rules".
    envelope JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (is_default OR envelope IS NOT NULL)
);

CREATE INDEX idx_sync_rulesets_user ON sync_rulesets(user_id);
-- One Default per account.
CREATE UNIQUE INDEX uq_sync_rulesets_default ON sync_rulesets(user_id) WHERE is_default;

-- Many-to-many: a ruleset has any number of devices, a device any number of
-- rulesets.
CREATE TABLE sync_ruleset_assignments (
    ruleset_id UUID NOT NULL REFERENCES sync_rulesets(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (ruleset_id, device_id)
);

CREATE INDEX idx_sync_ruleset_assignments_device ON sync_ruleset_assignments(device_id);

-- Every existing account gets an empty Default ruleset, and every active
-- device is assigned to it. An empty Default means no filtering, so nothing
-- changes for anyone until a ruleset gets rules. A revoked device
-- (`revoked_at IS NOT NULL`) is not assigned: it can't connect any more.
INSERT INTO sync_rulesets (user_id, is_default)
SELECT id, true FROM users;

INSERT INTO sync_ruleset_assignments (ruleset_id, device_id)
SELECT r.id, d.id
FROM devices d
JOIN sync_rulesets r ON r.user_id = d.user_id AND r.is_default
WHERE d.revoked_at IS NULL;
