

## Clean-up against the no-backward-compat rule

The app isn't live, so code that exists only for old clients or old data
shouldn't be there.

### 10. Old-client and old-data code still in the tree

- [x] `POST /auth/password` "kept for old clients" —
      `server/src/auth/routes.rs:37`; keep only `PATCH` (check that
      `web/src/api/client.ts` uses `PATCH`).
- [x] `legacy_visit_total` path for uploads without `visitHours` —
      `server/src/sync/routes.rs:618`, `:663–667`, `:1003–1010`; make
      `visitHours` required on `historyVisit` ops instead.
- [x] Old stats seeding through `sync_stats.history_hours_seed_before` and
      the seed path in `server/src/sync/stats.rs` (`:57`, `:68`
      `seed_history_visit_hours`, `:212`); drop the column from
      `server/migrations/0001_init.sql` in place and regenerate `.sqlx/`.
- [x] `sync_stats.history_visit_count` too: the comment at
      `server/src/sync/routes.rs:957–964` says `/stats` no longer reads it and
      it's kept only because removing it is "cosmetic".
- [x] Old bulk-import resume-field migration — `extension/src/history/bulk.ts:330–381`
      (`LegacyResumeFields`).
- [x] `server/src/sync/routes.rs:63` "The header is optional for now"
      (`x-protocol-version`) — now required.

### 11. Redundant index on the busiest table

- **Where:** `server/migrations/0001_init.sql:114`
  (`idx_sync_operations_user_cursor ON sync_operations(user_id, server_cursor)`).
- **What:** duplicates the index that `uq_sync_operations_server_cursor
  UNIQUE (user_id, server_cursor)` (line 111) already creates, adding write
  cost to every upload.
- **Fix:**
  - [x] Delete the `CREATE INDEX` line in place and regenerate `.sqlx/` if
        any cached query plan depends on it (none should).

---

## Minor

### 12. Unbounded string fields

- `devices.browser`, `browser_version`, `platform`, `extension_version`
  (`server/src/devices/routes.rs:60–68`, and the poll body in
  `server/src/auth/requests.rs:160–168`) and register's `kdf_salt`,
  `kdf_params`, `wrapped_ak`, `recovery_wrapped_ak`
  (`server/src/auth/routes.rs:133–144`) have no length limit beyond the 2 MB
  body cap. Same for `user_agent` stored on sessions and auth requests.
- [ ] Add length checks next to `validate_device_name`; validate
      `kdf_salt` is 16 bytes base64url and `kdf_params` has only bounded
      `m`/`t`/`p` integers (the same bounds the clients enforce).

### 13. Timing difference on login-with-device for unknown emails

- `server/src/auth/requests.rs:113–122` returns early for an unknown email,
  skipping the `INSERT` and the audit write, so the response is slightly
  faster than for a real account. Rate limits (3 per 10 min per email,
  10/min per IP) make this hard to use.
- [ ] Optional: do equivalent work on the unknown-email path.

### 14. `revoke_device` updates outside a transaction

- `server/src/devices/routes.rs:455`: the device update and the credential
  revoke are two separate statements (`revoke_self` uses one transaction).
  Harmless today because refresh rejects revoked devices.
- [ ] Wrap both in one transaction for consistency.

### 15. `/changes` recomputes payload size

- `server/src/sync/routes.rs:1180` uses `octet_length(payload::text)`, which
  re-serializes every candidate row's JSONB (bulk rows can be tens of MB),
  while `sync_operations.payload_bytes` already stores the size.
- [ ] Use `payload_bytes` in the sizing query.

### 16. Background tasks don't survive a panic

- `server/src/sync/compaction.rs:27`, `server/src/housekeeping.rs:26`,
  `server/src/main.rs` sweepers: each runs in a bare `tokio::spawn`; a panic
  inside a pass ends that task for the life of the process with only the
  default panic message.
- [ ] Optional: catch panics per pass (or supervise and respawn) and log them.

### 17. Dev-only npm advisories

- `npm audit` without `--omit=dev`: extension 1 high, web 6 high + 2 moderate
  (`source-map-js` and others). Build tooling only; nothing shipped.
- [ ] `npm audit fix` in both, then re-run tests and builds.

### 18. Web tests depend on the local environment

- On this machine the web tests fail (7) because the untracked
  `web/.env.local` sets `VITE_API_BASE_URL=http://localhost:8080`; they pass
  with it unset. `web/.dockerignore` excludes `.env.*`, so images are
  unaffected.
- [ ] Optional: make `web/src/api/client.test.ts` independent of
      `VITE_API_BASE_URL` (stub `import.meta.env` in the test).

---

## What's already solid

- Encryption: the server only ever sees a key derived from the password;
  ciphertexts are bound to object type, id and operation (AAD); clients
  reject out-of-bounds KDF parameters from the server.
- Auth: CSRF double-submit on every dashboard write; refresh-token rotation
  with reuse detection; account-enumeration resistance on prelogin, login
  and device registration; all SQL parameterized and compile-time checked.
- Deployment: strict CSP and security headers; non-root server container;
  graceful shutdown with a deadline; `/healthz` and `/readyz`.
- Release pipeline: Actions pinned to commit SHAs; publishing secrets isolated
  from install steps; Chrome Web Store uploads are staged, not auto-published.

## Order of work

1. Item 1 (rustls) and item 2 (versions, after the decision).
2. Item 4 (password-change rate limit).
3. Item 3 (push, watch CI and the release build).
4. Item 5 (after the design decision) and item 6 (reproduce first).
5. Items 7–11.
6. Items 12–18 as time allows.
