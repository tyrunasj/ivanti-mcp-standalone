# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A standalone MCP server for Ivanti Neurons for ITSM, shipped as a Docker image and also
runnable locally. Separate from the existing Overlord-hosted Ivanti MCP.

Three documents, with different jobs:
- **`docs/initial-design.md`** — decisions and why.
- **`docs/implementation-plan.md`** — the order of work, in stages.
- **`docs/notes.md`** — traps: things that pass locally and fail elsewhere. **Add to it whenever
  you hit one**, rather than fixing it silently.
- **`docs/configuration.md`** — how to configure the server against a real IdP, per provider,
  plus a symptom→cause table. `.env.example` is the reference; this is the guide.

**`docs/initial-design.md` is the source of truth for design decisions.** It records what was
decided, why, and — in §10 — which alternatives were rejected and for what reason. Read it
before proposing architectural changes; several obvious-looking simplifications were already
considered and turned down for stated reasons.

The Ivanti tools do not exist yet. Only `get_version` is implemented.

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

## Architecture

Composition runs one way: `index.ts` loads config, builds the server, then picks a transport.
Nothing lower in the stack reads `process.env`.

```
config/   env-schema (shape) -> read-secret-file (*_FILE) -> validate-config (rules) -> load-config (orchestration)
tools/    tool-definition (type) -> get-version (one tool) -> register-tools (which tools this mode exposes)
server/   create-server (assembly) -> start-stdio | start-http; http/ holds pure request-policy functions
ivanti/   base-path (startup probe) -> transport (rest_api_key HTTP) ; odata-url, odata-filter, errors are pure
```

Each file has one reason to change, and tests live next to the file they cover
(`foo.ts` / `foo.test.ts`).

**Config loads in three phases, and the order is load-bearing.** Secrets resolve first
(`BEARER_TOKEN_FILE` → `BEARER_TOKEN`), then the schema parses shape, then `validateConfig`
applies cross-field rules. A rule like "bearer mode needs a token" cannot be judged before the
secret file has been read. `env-schema.ts` describes *what a setting is*; `validate-config.ts`
decides *which combinations are allowed*. Keep that split.

**Two audience modes, chosen at startup.** `MCP_MODE=full` (IT staff, everything) or
`enduser` (create on allowlisted Business Objects, edit only own records). Tool narrowing
happens in `selectTools()` at registration time, never inside a handler: an unregistered tool
never appears in `tools/list`, so the model cannot call it at all.

**Transport and auth are separate axes.** `STDIO_TRANSPORT_ON` (default `true`) and
`HTTP_TRANSPORT_ON` (default `false`) are independent toggles — **both can be on**, and each
transport then gets its own `McpServer`, because `connect()` binds one transport at a time.
`AUTH_MODE` (`none` | `bearer` | `oauth`) decides who may connect and applies **only** to HTTP.
Fail closed throughout: HTTP on without an `AUTH_MODE` refuses to start, an `AUTH_MODE` set while
HTTP is off is an error rather than a no-op, and both transports off is refused. mTLS was dropped; it
belongs at the TLS-terminating proxy, not in this process.

OAuth lives in `src/auth/oauth/`: `verify-token` (jose/JWKS), `discover-metadata` (AS discovery,
spec probe order), `protected-resource-metadata` (RFC 9728 document + well-known paths),
`www-authenticate` (the challenge), `create-verifier` (startup composition). It is built on
`node:http` — **express is deliberately not a dependency**; the SDK's `mcpAuthMetadataRouter` is
express-based but the document is small enough to serve directly.

**JWKS only — introspection is deferred, not forgotten.** Measured across ten IdPs (design §9c):
`jwks_uri` is universal, introspection is absent on 4 including Entra. Adding it later is purely
additive behind the existing `TokenVerifier` type; see design §10 for the revisit triggers.

**Assume the IdP does not support DCR.** Half the surveyed providers don't, so a pre-registered
client (`--client-id`) is the documented default path.

**`OAUTH_AUDIENCE` is not `MCP_PUBLIC_URL`.** It defaults to it, but no mainstream IdP mints
`aud` from the client's RFC 8707 `resource` parameter — Zitadel emits a numeric project id,
Entra an App ID URI. Validation is membership in `aud`, which may be an array.
This server never mints tokens, serves no `/register`, and hosts no client ID metadata
document: registration is strictly between the client and the authorization server. Never use
the SDK's `mcpAuthRouter` or `proxyProvider` — those are the authorization-server half. See
design doc §11 for the verified spec requirements.

**The Ivanti base path is probed, not configured.** Tenants serve the API under `/HEAT` or at
the root, and `connectIvanti()` walks base path × CSDL form at startup — `incidents/$metadata`,
then the service root, then `businessobject/$metadata` — keeping the first that answers with a
CSDL document. A 200 carrying a login page is rejected, because the wrong base path then reads
like an authentication failure for the life of the process. The ladder is not defensive
programming: on a live tenant the two obvious forms answer `404 ISM_4004` and only the
entity-scoped graph exists. **Ask for XML** — `Accept: application/json` on `$metadata` makes
Ivanti answer 500 while trying to render CSDL as JSON. `IVANTI_BASE_URL` and
`IVANTI_API_KEY(_FILE)` are optional today and must be set together; with neither, the server
starts and warns. A configured tenant that cannot be reached **fails the startup** rather than
deferring the error to the first tool call.

**`src/ivanti/transport.ts` is the `rest_api_key` surface only** — OData, REST and `$metadata`.
The header is `Authorization: rest_api_key=<key>`, with an equals sign. The ASMX surface
authenticates with a SID cookie plus a CSRF token and has its own session lifecycle; keeping the
two apart is what stops a caller reaching for the wrong credential.

**Every collection read goes through `readCollection()`.** Ivanti has three encodings for "no
rows" and only one of them is an array: an entity set whose filter matches nothing answers **200
with an empty body**, and an empty navigation property answers `{"value": "No instances found."}`
— a string that cheerfully reports `.length === 19`. Unrecognised prose in `value` is an error,
not an empty result.

**Ivanti has no 404 and silently drops `$filter` functions.** Get-by-key answers
`400 ISM_4000 "Invalid key"` — the same code as a bad field name — so `isIvantiNotFound()` owns
that dialect. `contains()`, `startswith()` and friends are *ignored* and the full unfiltered set
returned, which is why `assertSupportedFilter()` refuses them locally before the request is made.
Never report success from a 200.

**Version comes from `package.json`.** `src/version.ts` reads the manifest at startup — keep
that module at the root of `src/`, since it resolves `../package.json` and relies on
`rootDir: src` → `outDir: dist` preserving depth. A container image **must copy `package.json`**
next to `dist/`; the server throws on a missing manifest rather than reporting a placeholder
version, because an unidentifiable deployment is worse than one that fails to start.

**Tool definitions are built once; servers are per connection.** `createServerFactory(config)`
calls `selectTools()` at startup and `factory.create()` hands out an `McpServer` per connection.
The split is forced by the SDK — `Protocol.connect()` throws *"use a separate Protocol instance
per connection"* — but `registerTool` stores config **by reference**, so the shared definitions
mean one copy of every zod schema regardless of session count. Never call `selectTools()` per
session.

**HTTP sessions are per-client and in-memory.** Each `initialize` creates its own transport *and*
its own `McpServer` — one transport instance holds one session id, so a shared transport rejects
the second client. `SessionStore` bounds them by `MCP_MAX_SESSIONS` (503 beyond it) and sweeps
idle ones after `MCP_SESSION_IDLE_TTL_SECONDS`; the TTL is required because `onsessionclosed`
fires only on an explicit DELETE. Being in-memory, replicas would need sticky routing by
`Mcp-Session-Id`.

## Invariants worth not breaking

- **Never write to stdout.** Under the stdio transport it carries the JSON-RPC stream. All
  logging goes to stderr via `createLogger`.
- **`MCP_PUBLIC_URL` is required and never derived from the request.** Behind a reverse proxy
  the Host header and scheme are rewritten, but RFC 9728 metadata and token audiences must
  match the externally visible URL exactly.
- **Origin validation is mandatory on every HTTP mode**, not just open mode — invalid Origin
  answers 403. It is what prevents DNS rebinding from a page the user merely visits.
- **New config keys fail closed.** If a mode needs a setting, add the rule to
  `validateConfig` so the process refuses to start rather than degrading quietly.
- **Annotate every tool explicitly.** Unannotated tools default to destructive and open-world.
  Reads get `readOnlyHint`/`idempotentHint`; additive writes must set `destructiveHint: false`
  because the default is `true`. Ivanti tools that return ticket text are an untrusted-content
  surface and keep `openWorldHint: true`.
- **The API key is redacted from every Ivanti error body** (`scrubErrorBody`, called in the
  transport — the only layer that knows the key). Ivanti echoes submitted values in failures and
  the ASMX session sends the key as a *body parameter*, so error text is the realistic path from
  credential to log line. Only the key itself is redacted: a generic "key-shaped token" pass would
  eat the 32-char hex RecIds the model needs from error text.
- **Ivanti request logs carry the path, never the query.** A `$filter` routinely contains a
  person's name.
- Business Object allowlists key on the **technical** BO name, never the display name, which
  is customizable per tenant.
