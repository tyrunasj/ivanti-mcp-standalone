# syntax=docker/dockerfile:1
#
# Built from the REPOSITORY ROOT, not from this directory:
#   docker build -f docker/Dockerfile -t ivanti-mcp .
#   docker compose -f docker/compose.yaml up
#
# `.dockerignore` stays at the root because that is where the context is and where
# the classic builder looks for it; BuildKit would also accept
# `docker/Dockerfile.dockerignore`, but a second copy is a second thing to drift.

# ──────────────────────────────────────────────────────────────────────────────
# Build: the toolchain never reaches the final image.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app

# pnpm is pinned rather than taken from corepack, which has been moved and
# deprecated across Node releases; the version here must match package.json.
RUN npm install --global pnpm@10.20.0

# Dependencies first, so a source-only change does not re-resolve the lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ──────────────────────────────────────────────────────────────────────────────
# Production dependencies, laid out flat.
#
# pnpm's default store is a tree of symlinks into a content-addressed store,
# which does not survive a COPY into another image: the links point at paths
# that are not there. `--node-linker=hoisted` writes real directories instead.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app
RUN npm install --global pnpm@10.20.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --node-linker=hoisted --ignore-scripts

# ──────────────────────────────────────────────────────────────────────────────
# Runtime: distroless. No shell, no package manager, no npm — nothing to exec
# into and nothing to install from, which is the point. Runs as `nonroot`.
# ──────────────────────────────────────────────────────────────────────────────
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# `src/version.ts` reads ../package.json at startup and the server refuses to
# start without it: an unidentifiable deployment is worse than one that fails.
COPY package.json ./
COPY docker/healthcheck.mjs ./docker/healthcheck.mjs

# Only meaningful with HTTP_TRANSPORT_ON=true; the stdio transport needs no port.
EXPOSE 3000

# There is no shell, so this is the exec form against the image's own node.
# The script exits 0 when the HTTP transport is off — a stdio deployment has
# nothing to poll, and a container that reports itself unhealthy for running as
# designed is worse than no check at all.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "docker/healthcheck.mjs"]

# The distroless entrypoint is already `node`.
CMD ["dist/index.js"]
