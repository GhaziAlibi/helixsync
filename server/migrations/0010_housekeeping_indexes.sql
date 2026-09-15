-- Versioned migration: 0010_housekeeping_indexes
--
-- `housekeeping::run_once` (server/src/housekeeping.rs) periodically deletes
-- expired rows from `device_credentials`, `web_sessions`, and `audit_logs`,
-- each filtered on its own timestamp column (`expires_at`, `expires_at`, and
-- `created_at` respectively). None of the three had an index on that
-- column: `device_credentials` only had `(device_id)` and, since
-- 0005_hash_lookup_indexes, `(credential_hash)`; `web_sessions` only had
-- `(user_id)` and `(session_hash)`; `audit_logs` only had
-- `(user_id, created_at DESC)`, which can't serve a range scan on
-- `created_at` alone since the delete's WHERE clause doesn't filter on
-- `user_id`. Every sweep was therefore a full sequential scan of a
-- monotonically growing table, on a cadence controlled by
-- `housekeeping_interval_secs`.
CREATE INDEX idx_device_credentials_expires_at ON device_credentials(expires_at);
CREATE INDEX idx_web_sessions_expires_at ON web_sessions(expires_at);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
