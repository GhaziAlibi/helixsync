## What and why

<!-- What does this change, and what problem does it solve? Link the issue, if any. -->

## How it was tested

<!-- Commands you ran and what you checked by hand. See CONTRIBUTING.md for the full list CI runs. -->

## Checklist

- [ ] The relevant checks pass locally (server: `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`; extension and web: `npm run typecheck`, `npm test`, `npm run build`).
- [ ] Behavior changes come with tests.
- [ ] If I added or changed a `sqlx::query!` family macro in `server/src`, I regenerated and committed `server/.sqlx/` (`cargo sqlx prepare`).
- [ ] If I changed the wire format, an endpoint or the schema, I updated `docs/protocol.md` and the other affected docs.
- [ ] I added a line under "Unreleased" in `CHANGELOG.md` for anything users or operators will notice.
- [ ] I did not edit `VERSION` or the version in `extension/manifest.json` (release automation owns them).
- [ ] No secrets, personal data or real browsing data in code, tests, logs or screenshots.
