-- Versioned migration: 0004_password_derived_encryption
-- Replaces the device-to-device key-grant relay (0003) with a
-- password-derived encryption root key (docs/encryption.md §2): every
-- device derives the same REK locally from the account password plus this
-- per-user salt via Argon2id, so no device-to-device authorization
-- handshake is needed for a new device to read existing data. The
-- key-grant table and the device public/signing keys it depended on are
-- now dead weight.
--
-- The DEFAULT on encryption_salt backfills existing rows with a random
-- value at migration time (nobody has derived a REK from it yet on any
-- pre-existing account, so there's nothing to invalidate); new rows always
-- pass an explicit value (server/src/auth/routes.rs::register), so the
-- default is dropped immediately after.
ALTER TABLE users
    ADD COLUMN encryption_salt TEXT NOT NULL
    DEFAULT encode(sha256(gen_random_uuid()::text::bytea), 'base64');
ALTER TABLE users ALTER COLUMN encryption_salt DROP DEFAULT;

DROP TABLE device_key_grants;

ALTER TABLE devices DROP COLUMN public_key;
ALTER TABLE devices DROP COLUMN signing_public_key;
