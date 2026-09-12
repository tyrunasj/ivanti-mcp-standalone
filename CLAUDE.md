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

**Stages B1-B3 are in.** Fourteen tools: `get_version`, plus the read tier — `list_business_objects`,
`get_object_metadata`, `get_record`, `list_records`, `count_records`, `get_related_records`,
`fulltext_search_object`, `list_assigned_work`, `get_service_request_parameters`,
`get_service_request_parameter_options`, `get_attachment_details`, the retrievable pair
`search` / `fetch`, `get_pick_list_values`, and the writes — `create_record`, `update_record`,
`delete_record`, `link_records`, `unlink_records`. In `enduser` mode only `create_record` is
registered among the writes: editing and deleting wait for B7 to define "own records", and until
then an end-user deployment must not let anyone change anyone's ticket. Writes and the workflow surface are later
stages.

**The Ivanti session is a second authentication protocol, not a header.** OData and REST take
`Authorization: rest_api_key=<key>`; the ASMX services take a SID cookie plus a CSRF token,
obtained by a three-step handshake (`AuthenticateTenantAPIKey` → SID,
`InitializeSession` → CSRF and the active role, `GetUserData` → display name). It lives in
`src/ivanti/session/` and never sends the API key as a header. The handshake is shared by
concurrent callers and re-run once on a 401.

**The capability tier decides what the credential can reach**, and is probed once at startup
because tools are selected once:

| Tier | The credential | What it adds |
|---|---|---|
| `odata` | the API key alone | every read tool; ~194 objects from metadata graphs |
| `session` | the ASMX handshake opens | the identity, and the role's own workspaces |
| `admin` | the admin console answers too | the complete catalog — 1324 objects with descriptions |

Higher tiers only ever *add*. A lower tier is **not** a failure: refusing to start would punish
exactly the customers who cannot hand an MCP server an admin key. `get_pick_list_values` is the
first tool the tier actually gates — it needs a create form, which OData cannot see.

**`IVANTI_MAX_TIER` caps the server below what the credential can do.** It exists because the
degraded paths cannot otherwise be exercised: `AuthenticateTenantAPIKey`'s `role` argument is
ignored, so an admin account asked for `SelfService` still answers `Admin`. Run with
`IVANTI_MAX_TIER=session` to see exactly what a customer without admin rights gets.
`AuthenticateTenantAPIKey`'s `role` argument is a *request* that silently downgrades, so the
effective role is always read back — `InitializeSession` reports it, and `GetUserData` refines it.

**`/HEAT/AdminUI/` is used when available and never required.** An admin-rights key reaches the
admin console, and it is by far the best source for some things — `GetBriefBusinessObjects`
returns **1324** Business Objects with display names and descriptions, against 194 from the
metadata graphs and 24 from the role's workspaces. Most customers will not issue such a key, so
every feature built on it degrades instead of breaking, and
`src/tools/admin-ui-guard.test.ts` drives every registered tool over a tenant whose admin console
refuses, asserting that none of them fails and none of them requests that path.

**The path needs the `services/` segment**: `/HEAT/AdminUI/services/AppDesign.asmx/…`.
Without it Ivanti answers 404, which reads as "this tenant has no admin console".

**The server's `instructions` carry the identity.** This process signs in as one account, so
anything Ivanti resolves "for the current user" answers for that account and not for whoever is
asking. Told this once at connect time, a model stops reporting one person's queue as another's;
`src/server/instructions.ts` builds it from the capability profile.

## Container

Everything container-related is in `docker/` — `Dockerfile`, `compose.yaml`, `healthcheck.mjs` —
but the **build context is the repository root**, so:

```bash
docker build -f docker/Dockerfile -t ivanti-mcp .
docker compose -f docker/compose.yaml up
```

`.dockerignore` stays at the root: that is where the context is and where the classic builder
looks for it. Three stages:
build → production dependencies → **distroless** runtime (`gcr.io/distroless/nodejs22-debian12`,
uid 65532, no shell, no package manager). 245 MB.

- **pnpm's symlinked `node_modules` does not survive a `COPY` between stages.** The dependency
  stage installs with `--node-linker=hoisted` so the layout is real directories.
- **`package.json` ships next to `dist/`** — `src/version.ts` reads it at startup and the server
  refuses to start without it.
- **The health check is a Node script** (`docker/healthcheck.mjs`), because a distroless image has
  no shell and no curl. It exits 0 when `HTTP_TRANSPORT_ON` is off: a stdio deployment serves no
  HTTP, and reporting it unhealthy for running as configured would be worse than not checking.
- **The tenant hostname must resolve inside the container**, which is not the same question as
  whether it resolves on the host. On a Mac, a split-horizon answer gave the container a LAN
  address it could not route to and every startup probe failed as a connection error; on a Linux
  host on that LAN the same image needed nothing. `extra_hosts` / `--add-host` pins it when needed.
- **Verified on both**: Docker Desktop on macOS (arm64) and Ubuntu 26.04 / Docker 29.1.3 on x86_64,
  the latter beside the tenant it talks to.
- Runs under `--read-only`, `--cap-drop ALL` and `no-new-privileges`; nothing is written to disk.

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
server/   create-server (assembly) -> start-stdio | start-http; http/ holds pure request-policy functions

ivanti/   connect (composition: probe -> transport -> catalog)
  http/       transport (rest_api_key), errors, base-path (startup probe)
  odata/      url, filter, query, projection, response — all pure
  metadata/   csdl (parser), catalog (fetch + cache), entity-names, suggest-names
  service-request/  parameter-shape (decodes what Ivanti encodes oddly)

tools/    tool-definition (defineTool) -> register-tools (which tools this mode exposes)
  shared/     deps, result, run-tool, resolve-object, explain-field-error
  schema/     list-business-objects, get-object-metadata
  records/    get-record, list-records, count-records, get-related-records, list-assigned-work
  search/     fulltext-search-object, search, fetch, record-identity
  service-request/, attachments/
```

`tools/` is the surface that gets tuned — descriptions, arguments, annotations — so it sits at the
top of `src/`, not inside `ivanti/`. Nothing under `tools/` builds a URL or parses a response:
that belongs to `ivanti/`, which knows nothing about MCP.

Each file has one reason to change, and tests live next to the file they cover
(`foo.ts` / `foo.test.ts`).

**Config loads in three phases, and the order is load-bearing.** Secrets resolve first
(`BEARER_TOKEN_FILE` → `BEARER_TOKEN`), then the schema parses shape, then `validateConfig`
applies cross-field rules. A rule like "bearer mode needs a token" cannot be judged before the
secret file has been read. `env-schema.ts` describes *what a setting is*; `validate-config.ts`
decides *which combinations are allowed*. Keep that split.

**Identity is threaded, never reached for.** `CallerIdentity` (`src/auth/identity.ts`) carries a
provenance — `anonymous`, `asserted`, `verified` — and arrives at a handler as its second
argument, bound per session by `registerTools`. Only the closure is per session; the tool *config*
stays shared, so the zod schemas still exist once. `get_version` reports the provenance and never
the person: a tool that answered *who* would be an identity oracle for anyone who can call it.

**Three rules from design §5 live in `identity-pin.ts`.** A verified session ignores any claim
outright — not merged, not preferred, or the strong path has a bypass. A session with no token
pins the first claim. A later, different claim is **refused**, because Ivanti ticket text is
written by whoever filed the ticket and a conversation can be told to become someone else by a
record it merely read. An HTTP session also belongs to the subject that opened it: another
verified subject presenting its own valid token gets 403.

**Every tool call is audited in `registerTools`**, the one place they all pass through: tool,
session, provenance — and the subject only when an issuer vouched for it. Arguments are never
logged, and an asserted subject is never logged as though it were a fact.

**Two audience modes, chosen at startup.** `MCP_MODE=full` (IT staff, everything) or
`enduser`. Tool narrowing happens in `selectTools()` at registration time, never inside a handler:
an unregistered tool never appears in `tools/list`, so the model cannot call it at all.

**In `enduser` mode, `ENDUSER_BUSINESS_OBJECTS` is a gate, not a hint.** `createObjectGate` is
built once at registration and every object-taking tool passes through it — `resolveObject`
refuses a name outside the list *before* resolving it, so a gated object is not even confirmed to
exist. The catalog lists only allowed objects, the cross-object search fans out over only those,
assigned work reports only those, `fetch` re-checks the object encoded in its id, an attachment is
refused when its `ParentLink_Category` is gated, and the service-request parameter tools are gated
on `ServiceReq` itself. `full` mode gets `OPEN_GATE` and is unaffected. Refusals name the objects
that *are* allowed: a model told only "no" retries with a synonym.

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

**Every write resolves, then verifies.** `resolveValidatedWrite` turns a picklist value into the
value *plus its option's RecId* — Ivanti stores the pair, and a value written alone can be
accepted and stored as nothing — and `confirmWrite` reads the record back before any tool reports
success. A value that is not on the list is refused before anything is written, with the list.
**The form is the authority on what is validated, not `$metadata`**: Task's CSDL reports no
validated fields while its form declares twenty.

**A field has three names, resolved in one order.** The form's own label for it, then the
object's display name, then the technical name — `fieldLabels` in `form-context.ts` does that, and
`displayNames` maps every layer back to the field so a refusal quoting any of them can be
translated. All of it is per object *and* per form: `ProfileLink` is "Customer" on an incident and
"Contact Link" on a service request, and a change has no such field at all. Never teach one
object's field names as the general rule — `get_link_fields` and `get_object_metadata` answer for
the object at hand.

**Ivanti's write refusals speak a different language.** A required-field message names the
*display* name (`Incident.Description` is `Symptom`) and sometimes names a link rather than a
field (`Incident.Customer` is `ProfileLink_RecID` + `ProfileLink_Category`).
`explain-required-fields.ts` translates both through the form. The rules are conditional: an
incident goes to `Logged` with nothing, and to `Active` only with Category and Owner.

**A quick-action preview must use the form path.** `SaveDataExecuteAction` honours
`shouldSave: false` on `FormParams` and **ignores it on `GridParams`**, where a "preview" is a live
execution that reports itself as a probe. `src/ivanti/quick-actions/execute.ts` therefore never
builds `GridParams`, and `preview_quick_action` refuses when the role has no form rather than
falling back. `run_quick_action` probes again itself — the commit echoes a token minted by *that*
probe — and is the only tool marked destructive *and* non-idempotent.

**Read `validationErrors`, not `status`.** A quick action's real failure is
`validationErrors[recId].fieldErrors[field].fieldMessages[]`, which names the field;
`PreDeleteObject` answers status `error` for a clean preview that carries only warnings, so only
`errorMessages` count as blockers.

**`unlink_records` checks the link exists first.** Ivanti accepts an unlink of something that was
never linked and, on a Contains relationship, severs the target from whichever record *is* its
parent — damage to a third record that nothing in the reply mentions.

**A validated field's allowed values live on a create form, nowhere else.** `$metadata` says a
field *is* validated and stops there, so `get_pick_list_values` walks
workspace → layout → view → form (`form-context.ts`, cached per object) and then asks
`GetFormValidationListData` with a transient data model. The rows come back as **columns**: the
stored value sits at the lowest index in `FieldMap`, `DisplayName` labels it, `RecId` identifies
it. Some lists cascade — pass the parent value, and note that a parent supplied under a name the
form does not have filters nothing, which the tool reports rather than swallowing.

**`src/ivanti/transport.ts` is the `rest_api_key` surface only** — OData, REST and `$metadata`.
The header is `Authorization: rest_api_key=<key>`, with an equals sign. The ASMX surface
authenticates with a SID cookie plus a CSRF token and has its own session lifecycle; keeping the
two apart is what stops a caller reaching for the wrong credential.

**Every collection read goes through `readCollection()`.** Ivanti has three encodings for "no
rows" and only one of them is an array: an entity set whose filter matches nothing answers **200
with an empty body**, and an empty navigation property answers `{"value": "No instances found."}`
— a string that cheerfully reports `.length === 19`. Unrecognised prose in `value` is an error,
not an empty result.

**Every tool resolves the object through the metadata catalog, never by string conversion.**
`resolveObject()` costs nothing after the first call and turns a wrong name into a naming error
*with suggestions* — Ivanti's own answer to a wrong entity set is an empty result, which reads as
"there are no such records". The catalog also answers the reverse trap: an unknown entity set
makes Ivanti **fabricate** a field-less entity type and return it as valid CSDL, so a parsed
document with no fields is a typo, not a schema.

**Row payloads default to a compact field set.** A full Ivanti record is ~180 fields, and a
default page of 25 measured **187,278 characters** — one careless `list_records` would spend a
context window. `resolveRowFields` returns `COMPACT_ROW_FIELDS` unless the caller names fields or
passes `"*"`, and the response says which it did. Telling the model to pass a field list in the
description is not a substitute for a safe default.

**Projection is client-side, always.** `$select` on a single-record GET returns `@odata.context`
and nothing else, and blanks the values on saved searches. `buildQuery` therefore has no
`$select` and no `$expand` — the latter is silently ignored under API-key auth, so a caller would
read "no related records" from a request that never happened. Use `get_related_records`.

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
  `validateConfig` so the process refuses to start rather than degrading quietly. Settings that
  name *tenant* things are checked against the tenant at startup too —
  `ENDUSER_BUSINESS_OBJECTS` is resolved through the metadata catalog and exits 78 with
  suggestions, because a misspelled allowlist entry silently narrows what an end user may do.
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
