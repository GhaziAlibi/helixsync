#!/usr/bin/env bash
# Sets the helixsync-server crate version in server/Cargo.toml and
# server/Cargo.lock to $1, so the server's own version (startup log, backup
# headers) matches VERSION. Both files change together: the image is built
# with `cargo build --locked`, which fails if they disagree.
#
# Usage: .github/scripts/set-cargo-version.sh 1.2.3   (from the repo root)
set -euo pipefail

version="${1:?usage: set-cargo-version.sh <version>}"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "not a MAJOR.MINOR.PATCH version: $version" >&2
  exit 1
fi

toml=server/Cargo.toml
lock=server/Cargo.lock

# The first `version = ` line of the [package] table.
awk -v v="$version" '
  /^\[/ { in_package = ($0 == "[package]") }
  in_package && !done && /^version = "/ { print "version = \"" v "\""; done = 1; next }
  { print }
  END { if (!done) exit 1 }
' "$toml" > "$toml.tmp"
mv "$toml.tmp" "$toml"

# The `version = ` line right after `name = "helixsync-server"`.
awk -v v="$version" '
  after_name && /^version = "/ { print "version = \"" v "\""; after_name = 0; done = 1; next }
  { after_name = ($0 == "name = \"helixsync-server\""); print }
  END { if (!done) exit 1 }
' "$lock" > "$lock.tmp"
mv "$lock.tmp" "$lock"
