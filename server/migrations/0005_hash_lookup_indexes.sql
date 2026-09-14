-- Versioned migration: 0005_hash_lookup_indexes
-- `web_sessions.session_hash` is looked up on every dashboard-authenticated
-- request (server/src/auth/extractors.rs) and `device_credentials.credential_hash`
-- on every device token refresh (server/src/devices/routes.rs) — neither
-- column had an index, so both were sequential scans, and
-- `device_credentials` grows monotonically (refresh rotates in a new row
-- and only marks the old one revoked, never deletes it), so the scan cost
-- for that one was only ever going to get worse.
CREATE INDEX idx_web_sessions_session_hash ON web_sessions(session_hash);
CREATE INDEX idx_device_credentials_credential_hash ON device_credentials(credential_hash);
