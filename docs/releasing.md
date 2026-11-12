# Releasing HelixSync

This guide is for maintainers. It describes how a release is built and
published, and the one-time repository setup the pipeline depends on. If you
are deploying a server, see [`deployment.md`](deployment.md) instead; for why
the pipeline is shaped this way, see
[`security.md`](security.md#8-release-pipeline).

## What a release is

Every push to `main` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml).
Nothing is tagged, pushed or published until the CI workflow
([`ci.yml`](../.github/workflows/ci.yml)) has passed:

1. **Version.** [`VERSION`](../VERSION) is the single source of truth. If the
   push itself changed `VERSION` (a deliberate minor or major bump), that value
   is used as-is. Otherwise the workflow bumps the patch number and commits it
   to `main`. It then copies the version into `extension/chrome/manifest.json`
   and `extension/firefox/manifest.json` and tags `vX.Y.Z`.
2. **Images.** The `server` and `web` images are built and pushed to GitHub
   Container Registry as `ghcr.io/<owner>/helixsync-server` and
   `ghcr.io/<owner>/helixsync-web`, tagged `latest` and with the release
   version. Deployments should pin the version rather than follow `latest`.
3. **Extension.** The extension is built and tested, zipped as
   `helixsync-extension-<version>.zip` (Chromium) and
   `helixsync-extension-firefox-<version>.zip` (Firefox, unsigned).
   Each zip is compared with the same browser's zip in the last release that
   has one, ignoring the manifest's version, and is attached to the GitHub
   release only if its files differ and its store publish (steps 4 and 5)
   did not fail, so a failed or rejected publish is retried by the next run.
   The attach step therefore runs after the publish jobs, i.e. once any
   pending approval is given. A change only in `extension/firefox/`
   therefore releases Firefox alone, one only in `extension/chrome/` Chrome
   alone, and one in shared code whichever packages it actually changed.
   Firefox installs the Firefox zip only after Mozilla has signed it.
4. **Chrome Web Store.** When the Chrome zip changed, it is uploaded to the
   Web Store from a separate, protected job (below). The upload is staged:
   after the store approves it, releasing it to users is a manual click in
   the Web Store developer dashboard.
5. **addons.mozilla.org.** When the Firefox zip changed, it is submitted to
   AMO as a new listed version of `helixsync@ghazialibi.github.io`, with the
   source code (the commit, with the stamped manifest versions) and build
   notes for the reviewers, from a separate, protected job (below). Mozilla
   reviews, signs and publishes it; nothing else is clicked.

Pull requests run the same builds but push, tag and publish nothing.

`extension/package.json`, `web/package.json` and `server/Cargo.toml` carry the
version too, but nothing depends on them matching exactly between releases. A
maintainer updates them when bumping a minor or major version.

Contributors never change `VERSION` or the version in either extension manifest
in an ordinary pull request.

## One-time repository setup

Publishing to the Chrome Web Store is a separate job that holds the store
credentials, so it should be protected:

1. **Create the `chrome-web-store` environment** (Settings → Environments →
   New environment). Add **required reviewers** (yourself and any
   co-maintainer) so a publish waits for an explicit approval, and restrict
   **deployment branches** to `main`.
2. **Put the Chrome secrets in that environment** (Environment secrets):
   `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`,
   `CHROME_PUBLISHER_ID`, `CHROME_EXTENSION_ID`. Then **delete any
   repository-level copies** so no other job can read them. The publish job
   skips itself while `CHROME_EXTENSION_ID` is unset, so releases keep working
   before this is set up. The store item must already exist from a manual first
   submission; the API can only publish updates to it.
3. **Create the `firefox-amo` environment** the same way, with the AMO API
   keys (addons.mozilla.org Developer Hub → Tools → Manage API Keys) as
   environment secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. The publish job
   skips itself while `AMO_JWT_ISSUER` is unset. The add-on must already exist
   on AMO from a manual first upload; the job only adds versions to it.
4. In Settings → Code security, enable **private vulnerability reporting**
   (the link in [`SECURITY.md`](../SECURITY.md) depends on it).
5. In Settings → Branches, add a **protection rule for `main`** that requires
   pull requests and the status checks from `ci.yml` (`Server (fmt, clippy,
   tests)`, `Extension (typecheck, tests, build)`, `Web (typecheck, tests,
   build)`, `Audit (npm, cargo)`). The release workflow commits the version
   bump straight to `main`, so allow `github-actions[bot]` to bypass the
   pull-request requirement (or use a ruleset with that bypass).

## Pinned dependencies

Every third-party GitHub Action is pinned to a full commit SHA, with a
trailing comment naming the release. Nothing updates these pins automatically:
to move one, replace the SHA with the commit of the new release tag and update
the comment together. Base images in the Dockerfiles and compose files are
pinned by digest, with the tag kept for readability; refresh a digest with
`docker buildx imagetools inspect <image:tag>`.
