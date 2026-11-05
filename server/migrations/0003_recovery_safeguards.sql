-- Account-recovery safeguards (docs/encryption.md §9.1, §9.4). Additive only:
-- a nullable column, a wider CHECK, a new table. Safe on a live database and
-- backward compatible with existing clients.

-- Set when the user proves they hold the current recovery code (typing it
-- back). NULL means "not confirmed": every existing account starts there, and
-- every place that replaces the code resets it. A flag, not a secret.
ALTER TABLE users ADD COLUMN recovery_code_confirmed_at TIMESTAMPTZ;

-- Two-device password reset: a third request kind, `reset`.
ALTER TABLE auth_requests DROP CONSTRAINT auth_requests_kind_check;
ALTER TABLE auth_requests
    ADD CONSTRAINT auth_requests_kind_check CHECK (kind IN ('web', 'device', 'reset'));

-- One row per connected device that approved a `reset` request. The request
-- becomes `approved` only when a second, distinct device approves.
CREATE TABLE auth_request_approvals (
    request_id UUID NOT NULL REFERENCES auth_requests(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (request_id, device_id)
);
