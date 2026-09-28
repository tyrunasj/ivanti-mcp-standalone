# Development

How to build, check and run the server while working on it. Running it for real — a Node host, a
container, Kubernetes, releases — is [`deployment.md`](./deployment.md).

## Commands

`pnpm dev` and `pnpm start` load `.env` via `--env-file-if-exists`, so a clone without one still
runs. `.env.example` documents every setting; `.env` is gitignored.


```bash
pnpm install
pnpm dev                      # tsx watch on src/index.ts
pnpm typecheck                # tsc --noEmit over src + config files
pnpm lint                     # eslint (type-aware)
pnpm test                     # vitest run
pnpm test:watch
pnpm build                    # tsc -p tsconfig.build.json -> dist/ (excludes *.test.ts)
pnpm start                    # node dist/index.js

pnpm vitest run src/config/load-config.test.ts        # a single test file
pnpm vitest run -t 'rejects a missing Authorization'   # a single test by name
```

Running the server needs at minimum `AUTH_MODE`; see `.env.example`. It fails closed and
exits 78 (`EX_CONFIG`) with a list of every problem when configuration is incomplete.

**Before any commit, run all four:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
`pnpm handbook:sync` regenerates the manifest snapshot `docs/handbook.html` embeds, and
`pnpm handbook:check` (run in CI) fails when a description changed without it. `pnpm version:sync`
writes `package.json`'s version into `Chart.yaml` and the handbook.

`pnpm budget` prints the manifest and `instructions` spend against their caps — the figures no
document should quote, because they move with every description.

`typecheck` is not redundant with `build` — the build config excludes tests and fixtures, so it is
the only thing that type-checks the test suite. `/ship` runs them and refuses on the first failure.

## Testing against the live tenant

Unit tests prove the code; they have repeatedly passed while the manifest misled a model. So a
change to the tool surface is verified by **driving the tools** against the real tenant, through
an MCP server that runs the working tree directly over stdio:

```bash
claude mcp add ivanti-dev -s local \
  -e STDIO_TRANSPORT_ON=true -e HTTP_TRANSPORT_ON=false -e AUTH_MODE= -e MCP_PUBLIC_URL= \
  -- "$PWD/node_modules/.bin/tsx" --env-file-if-exists="$PWD/.env" "$PWD/src/index.ts"
```

The loop is **edit → `/mcp` → reconnect `ivanti-dev`**. tsx compiles on spawn and a stdio server
is spawned per connection, so reconnecting *is* the redeploy — no build, no image, no cluster.

- **It is the real tenant, with the real key.** A local *server*, not a local Ivanti: writes are
  real.
- **`AUTH_MODE=` and `MCP_PUBLIC_URL=` are deliberate.** `.env` is written for HTTP, and an
  `AUTH_MODE` set while HTTP is off is a startup failure by design. An empty value means unset
  (`withoutEmpty`), and the client's environment beats `--env-file`.
- **A running connection keeps the process it spawned.** Changes land on reconnect, not before.
- **A fresh connection ends the conversation** — the pin is gone and the first call asks for
  `act_as` again. So does 30 minutes of silence (`MCP_IDENTITY_IDLE_TTL_SECONDS`).
- **Verify names before writing.** Field, object, relationship and picklist names come from
  `get_object_metadata`, `get_link_fields` and `get_pick_list_values`, never from memory — the
  write path now refuses an unknown field, but a *wrong-but-real* one writes to the wrong place.

The deployed build stays reachable alongside it as `ivanti-http`, so the working tree and the
cluster can be compared in one session. A tool added after the session started is not in its
manifest until the client restarts; a throwaway script that spawns the server and speaks
JSON-RPC on stdin covers the gap.

## Toolchain constraints

- **TypeScript is pinned to 6.x on purpose.** TS 7 (the native port) is released, but
  `typescript-eslint` still declares `typescript >=4.8.4 <6.1.0`. Upgrading TypeScript breaks
  type-aware linting until typescript-eslint catches up.
- **Zod v4 only.** The MCP SDK is v4-first internally (`zod/v4`, `zod/v4-mini`, and public
  types in `z.core.*`). Never import `zod/v3` — the SDK's `zod-json-schema-compat` shim then
  takes its legacy branch and schema types stop matching the SDK's.
- **SDK 1.30.0 implements protocol `2025-11-25`, not `2026-07-28`.** Requirements from the
  newer spec revision are not implementable here yet; check `LATEST_PROTOCOL_VERSION` before
  assuming otherwise.
- **`express` arrives transitively via the SDK.** Declare it in `package.json` before
  importing it — pnpm's strict layout will otherwise fail the build, which is the point.
