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

# Production dependencies only, laid out flat.
cp "$ROOT/package.json" "$ROOT/pnpm-lock.yaml" "$ROOT/pnpm-workspace.yaml" "$STAGE/"
( cd "$STAGE" && pnpm install --prod --frozen-lockfile --node-linker=hoisted --ignore-scripts )

# The build output, and the manifest the server refuses to start without.
cp -R "$ROOT/dist" "$STAGE/dist"
cp -R "$ROOT/docker" "$STAGE/docker"          # healthcheck.mjs, for anyone who wants it
cp "$ROOT/.env.example" "$STAGE/.env.example"
cp "$ROOT/README.md" "$STAGE/README.md" 2>/dev/null || true

tar -czf "$OUT/ivanti-mcp-$VERSION.tar.gz" -C "$OUT" "ivanti-mcp-$VERSION"
rm -rf "$STAGE"

echo "$OUT/ivanti-mcp-$VERSION.tar.gz"
ls -lh "$OUT/ivanti-mcp-$VERSION.tar.gz" | awk '{print "  " $5}'
