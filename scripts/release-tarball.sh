#!/usr/bin/env bash
# Builds a self-contained tree that runs on any host with Node 22 and no toolchain:
#
#   tar xzf ivanti-mcp-<version>.tar.gz -C /opt/ivanti-mcp
#   node /opt/ivanti-mcp/dist/index.js
#
# `pnpm deploy` is not usable here — pnpm-workspace.yaml declares no packages (it exists only for
# onlyBuiltDependencies), so pnpm has nothing to select. This mirrors the Dockerfile's deps stage
# instead: --node-linker=hoisted writes real directories, because pnpm's default symlink store
# does not survive being moved to another machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
OUT="${1:-$ROOT/release}"
STAGE="$OUT/ivanti-mcp-$VERSION"

rm -rf "$STAGE"; mkdir -p "$STAGE"

# STDOUT IS THE TARBALL PATH AND NOTHING ELSE — the release workflow captures it with
# `$(...)` and hands it straight to the upload step, so anything else printed here
# becomes a filename. `pnpm install` writes progress to stdout: with that mixed in, the
# workflow captured "Lockfile is up to date, resolution step is skipped" as the path,
# the upload matched no file, and the step still exited 0. Everything chatty goes to
# stderr from here on.

# Production dependencies only, laid out flat.
cp "$ROOT/package.json" "$ROOT/pnpm-lock.yaml" "$ROOT/pnpm-workspace.yaml" "$STAGE/"
( cd "$STAGE" && pnpm install --prod --frozen-lockfile --node-linker=hoisted --ignore-scripts ) >&2

# Same prune as the Dockerfile's deps stage, for the same reason: none of this is read
# by a running process. LICENCE files stay — the notices have to travel with the copy.
# Licence files survive: four production packages ship theirs only as .md. See docker/Dockerfile.
find "$STAGE/node_modules" \( -name '*.d.ts' -o -name '*.md' -o -name '*.map' \) \
  -not -iname 'licen[cs]e*' -not -iname 'copying*' -type f -delete

# The build output, and the manifest the server refuses to start without.
cp -R "$ROOT/dist" "$STAGE/dist"
cp -R "$ROOT/docker" "$STAGE/docker"          # healthcheck.mjs, for anyone who wants it
cp "$ROOT/.env.example" "$STAGE/.env.example"
# The licence and the third-party notices ship with every copy, not just the repo.
cp "$ROOT/LICENSE" "$ROOT/THIRD-PARTY-NOTICES.md" "$STAGE/"
cp "$ROOT/README.md" "$STAGE/README.md" 2>/dev/null || true

tar -czf "$OUT/ivanti-mcp-$VERSION.tar.gz" -C "$OUT" "ivanti-mcp-$VERSION"
rm -rf "$STAGE"

ls -lh "$OUT/ivanti-mcp-$VERSION.tar.gz" | awk '{print "  " $5}' >&2
echo "$OUT/ivanti-mcp-$VERSION.tar.gz"
