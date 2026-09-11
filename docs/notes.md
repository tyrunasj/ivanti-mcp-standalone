# Notes — traps and gotchas

Running list of things that bite. **Not** design decisions (those are in
[`initial-design.md`](./initial-design.md)) and **not** sequencing (that is
[`implementation-plan.md`](./implementation-plan.md)).

The entry criterion: *something that passes locally, or looks fine in review, and fails
somewhere else.* Each note says what breaks, why, and what to do.

---

## Packaging and containers

**`.dockerignore` must not exclude `package.json`.**
The server reads its own name and version from the manifest at startup, so the image has to
`COPY package.json` alongside `dist/`. A `.dockerignore` that filters it out passes every local
test and fails only in the container, at boot. → Verify by running the built image, not just
`pnpm build`.

**pnpm's `node_modules` cannot be copied into an image as-is.**
It is a symlink farm pointing into the store. `COPY node_modules` produces dangling links and an
image that fails on the first `import`. Produce a self-contained tree with `pnpm deploy --prod`
(or `--node-linker=hoisted`) and copy that instead. The image itself does not build — CI runs
`pnpm build` and the Dockerfile only copies `dist/`.

**Host-built artifacts assume the target platform.**
Production deps are pure JS today, so a macOS-built tree runs on linux/amd64 by luck. The first
native dependency breaks that silently — build on linux in CI.

**Distroless has no shell.**
- No entrypoint wrapper, so `*_FILE` secrets must be read *by the application*, never by a
  `sh -c` that exports env vars.
- `HEALTHCHECK` needs an executable — there is no `curl`. Give the binary a `--health`
  subcommand, or use a k8s `httpGet` probe and skip Docker healthchecks.

**Distroless `static` ships no CA bundle, and `scratch` ships none at all.**
Needed for TLS to Ivanti *and* for fetching the IdP's JWKS. A missing trust store surfaces as a
**token-validation failure**, not as an obvious TLS error — which sends you debugging OAuth when
the problem is the base image.

**`:nonroot` runs as uid 65532.**
Mounted Docker/K8s secret files must be readable by it. Root-owned secrets are the default.

**No tzdata**, if Ivanti dates are ever formatted in a local zone.

---

## Toolchain

**TypeScript is pinned to 6.x deliberately.**
TS 7 (the native port) is released, but `typescript-eslint` declares `typescript >=4.8.4 <6.1.0`
— its canary too. Installing TS 7 gives an unmet-peer warning and silently breaks type-aware
linting. Revisit when typescript-eslint supports 7.

**`pnpm.onlyBuiltDependencies` in `package.json` is ignored by pnpm 10.**
It moved to `pnpm-workspace.yaml`. Without it, esbuild's build script never runs and vitest
cannot start. pnpm warns, but the warning is easy to scroll past.

**`types: ["node"]` must be explicit in `tsconfig.json`.**
`tsconfig.build.json` includes only `src`, and without the explicit `types` entry Node globals
are not discovered there — `pnpm typecheck` passes while `pnpm build` fails with
`Cannot find name 'process'`.

**`src/version.ts` must stay at the root of `src/`.**
It resolves `../package.json` via `import.meta.url`, which works only because `rootDir: src` →
`outDir: dist` preserves depth. Moving it into a subdirectory breaks the path at runtime, not at
compile time.

---

## Dependencies

**Never import `zod/v3`.**
The MCP SDK is v4-first internally (`zod/v4`, `zod/v4-mini`, public types in `z.core.*`). Its
`zod-json-schema-compat` shim branches on `isZ4Schema()`; a v3 schema silently takes the legacy
`zod-to-json-schema` path and the types stop matching the SDK's. It surfaces as confusing generic
errors on `registerTool`, not as a version mismatch.

**`express` arrives transitively via the SDK — declare it before importing it.**
It resolves today only through hoisting. That breaks under pnpm's strict layout and gives no
semver protection. *Currently we do not use it at all*: the OAuth metadata document is small
enough to serve from `node:http`, so the server stays framework-free. Keep it that way unless
something genuinely needs the SDK's express-based routers.

**The SDK's own version cannot be read from `@modelcontextprotocol/sdk/package.json`.**
Its `exports` map has a `./*` entry that resolves that specifier to `dist/cjs/package.json`,
which contains only `{"type":"commonjs"}` — so you get `undefined` rather than an error. Resolve
a real module and walk up to the package root instead (`readSdkVersion()` in `src/version.ts`).

**SDK 1.30.0 implements protocol `2025-11-25`, not `2026-07-28`.**
It shipped one day before that revision. Check `LATEST_PROTOCOL_VERSION` before assuming a
2026-07-28 requirement is buildable in TypeScript.

---

## MCP protocol

**Never write to stdout.**
Under the stdio transport it carries the JSON-RPC stream; anything written there corrupts the
protocol. All logging goes to stderr via `createLogger`.

**Tool annotations default to *destructive* and *open-world*.**
An unannotated tool reads as dangerous — safe, but useless. Every tool needs explicit values, and
**additive writes must set `destructiveHint: false` explicitly** because the default is `true`.

**`onsessionclosed` fires only on an explicit `DELETE`.**
Clients frequently vanish without one, so an idle TTL is not optional — and neither is a session
cap, since in `none` mode anything that reaches the port can `initialize` forever.

**One `StreamableHTTPServerTransport` holds one `sessionId`.**
A single shared transport collides the moment a second client connects — the second `initialize`
is rejected with `Invalid Request: Server already initialized`, and Claude Code's health check is
enough to trigger it because it counts as a second client. *(Fixed 2026-09-10: transport **and**
`McpServer` per session, keyed by `Mcp-Session-Id`.)*

**One `McpServer` cannot serve two connections.**
`Protocol.connect()` throws `Already connected to a transport… use a separate Protocol instance
per connection`. A singleton server is not an option — it holds per-connection state (negotiated
protocol version, client capabilities, in-flight aborts). What *can* be shared is the tool
definitions: `registerTool` stores config by reference, so build them once
(`createServerFactory`) and register the same objects on every session.

**`tools/list` re-runs zod → JSON Schema on every call.**
The SDK converts inside the `ListToolsRequestSchema` handler, not at registration. So the cost of
many tools is CPU per list request, not memory per session. Worth measuring once the Ivanti tools
land; memoising the conversion by schema object is the fix if it shows.

**An SSE stream's elapsed time is not request latency.**
The `GET /mcp` that opens the event stream stays open for the life of the connection, so logging
its duration the same way as an RPC call made a perfectly healthy 131-second stream look like a
pathological request. Streams log `mcp stream opened` / `mcp stream closed` with `attachedMs`;
RPC calls log `mcp request` with `ms`.

**Clients disconnect without sending DELETE — routinely, not exceptionally.**
Observed live: clearing auth in Claude Code dropped the connection and opened a new session
without ever sending `DELETE`, so `onsessionclosed` never fired and the old session sat in memory
until the idle sweep. This is the *normal* case, which makes `MCP_SESSION_IDLE_TTL_SECONDS`
load-bearing rather than defensive — without it every re-authentication leaks a session
permanently, and `MCP_MAX_SESSIONS` would eventually be reached by ordinary use.

**Session state is in-memory.**
`SessionStore` is a `Map` in the process. Restart drops every session (clients re-`initialize`,
so it reconnects rather than errors), and **replicas need sticky routing by `Mcp-Session-Id`** or
requests hit the wrong instance and get `404 Unknown or expired session`.

---

## Configuration

**Transport and `AUTH_MODE` are separate axes.**
An early version folded `stdio` into `AUTH_MODE`, which made `stdio` and `none` two spellings of
"no authentication" and left no way to say "HTTP" without also picking a door. Both directions now
fail closed: HTTP on with no `AUTH_MODE` refuses to start, and an `AUTH_MODE` set while HTTP is
off is an error rather than a silently ignored setting that looks protective.

**Transports are two booleans, not one list.**
`STDIO_TRANSPORT_ON` / `HTTP_TRANSPORT_ON`, both may be on. A list (`MCP_TRANSPORT=stdio,http`)
was tried and rejected: changing one transport means restating the whole list, which is exactly
what breaks under layered env config — a compose override or k8s patch that sets only `http`
would silently drop `stdio`. Booleans also need reading, not parsing.

**Turn `STDIO_TRANSPORT_ON=false` in an HTTP-only container.**
Left on with no stdin attached the transport just sees EOF — harmless, but noise. It is on by
default because it listens on no socket, which is the safe default when nothing was said.

## OAuth

**`OAUTH_AUDIENCE` is not `MCP_PUBLIC_URL`.**
It defaults to it, but **no mainstream IdP mints `aud` from the client's RFC 8707 `resource`
parameter** — Zitadel emits a numeric project id (audience comes from the scope
`urn:zitadel:iam:org:project:id:{projectId}:aud`), Entra emits an App ID URI (`api://…`).
Keycloak behaves the same way. A verifier written to the spec's literal wording rejects every
real token. Validation is **membership in `aud`**, which may be an array.

**`MCP_PUBLIC_URL` must be a canonical resource URI** — absolute, no fragment, no trailing slash.
It is compared verbatim against the token audience, so a stray `/` produces an audience mismatch
that reads like a client bug. Enforced by `canonicalUriProblems()` at startup.

**Entra's issuer string depends on the token version.**
v1: `https://sts.windows.net/{tid}/` · v2: `https://login.microsoftonline.com/{tid}/v2.0`. Pin
`requestedAccessTokenVersion: 2` in the app registration so this is not ambiguous.

**Entra's metadata resolves only on the third discovery probe.**
Its issuer carries a path, and only the path-*appending* form
(`{issuer}/.well-known/openid-configuration`) answers. Dropping the fallback order breaks Entra
while leaving Zitadel working.

**JWKS must refetch on an unknown `kid`.** Entra rotates signing keys; a cache that never
refreshes turns a routine rotation into an outage. `createRemoteJWKSet` handles this — do not
replace it with a naive fetch-once.

**Zitadel's *default* access token is opaque, not JWT.**
Our instance is configured for JWT, so JWKS validation is enough. A new Zitadel app will default
back to opaque, and a JWKS verifier cannot validate it at all — there is nothing to parse.
Introspection (RFC 7662) is the fallback if that ever becomes necessary.

**Half of mainstream IdPs do not support Dynamic Client Registration.**
Measured 2026-09-10: absent on Entra, Google, JumpCloud, Duende and GitLab; present on Okta,
Auth0, Keycloak, Zitadel and Salesforce. So `claude mcp add --client-id <id> --callback-port <n>`
against a **pre-registered** app is the normal path, not a workaround. Assuming DCR works is the
mistake.

**A DCR-created client inherits the IdP's *default* token type.**
Cost real time here: Zitadel's default is Bearer (opaque), so every `/mcp` re-authentication
registered a brand-new app that was opaque again, and flipping one app to JWT lasted exactly
until the next re-auth. Pin the client id instead of chasing apps. Okta has the same shape — its
*org* authorization server issues opaque tokens while a *custom* one issues JWTs.

**Multi-tenant Entra apps are not supported, and the failure is subtle.**
Microsoft's tenant-independent metadata returns an issuer containing a `{tenantid}` placeholder
that a validator is expected to substitute with the token's own `tid` before comparing. Our
verifier matches `iss` exactly, which is right for single-tenant and wrong for multi-tenant. Set
`signInAudience: AzureADMyOrg`. A deployment per tenant is the supported shape anyway.

**In Entra, a redirect URI under *Web* is not the same as one under *Mobile and desktop*.**
They are different manifest arrays (`web.redirectUris` vs `publicClient.redirectUris`), and
`allowPublicClient` defaults to **false** — so a CLI client registered under *Web* is treated as
confidential and asked for a secret it does not have.

**Entra does not advertise `code_challenge_methods_supported`.**
It is the only one of ten surveyed that omits it, and the spec says a conformant client **MUST
refuse to proceed** when it is absent. Entra does support PKCE S256 — it just does not say so.
Nothing server-side can fix another party's metadata document. See design §12.

**A `WWW-Authenticate` description has a length budget; a log line does not.**
The opaque-token diagnostic was ~286 characters against a 200-character cap, so the header was
truncated mid-sentence and the *remedy* — "Set the application to issue JWT access tokens" — never
reached the client. A diagnosis whose fix is cut off is worse than no diagnosis. `TokenVerification`
therefore carries a short `description` for the challenge and an optional longer `detail` for the
log.

**`WWW-Authenticate` values must be printable ASCII.**
RFC 6750 restricts them to %x20-21 / %x23-5B / %x5D-7E, and Node throws
`Invalid character in header content` on anything outside Latin-1 — turning a clean 401 into a
500. An em dash in an error message was enough. `buildWwwAuthenticate` sanitises and truncates,
because the description is prose and prose acquires punctuation.

**Never mount the SDK's `mcpAuthRouter` or `proxyProvider`.**
They are the *authorization-server* half — `authorize`, `token`, `register`, `revoke`. Mounting
them turns this server into an IdP. We serve only `mcpAuthMetadataRouter`-equivalent metadata and
bearer verification.

---

## Ivanti

**Business Object allowlists key on the *technical* name**, never the display name — display
names are customizable and localizable per tenant, so a rename silently empties the allowlist.

**Incident numbers are sequential.** Exposing `get_record` by IncidentNumber in `enduser` mode is
ticket enumeration across the whole company; the model would happily walk #11160, #11161, #11162.

**Ticket text is attacker-controlled.** Anyone who can file a ticket can put text in front of the
model, which is why read tools carry `openWorldHint: true` and why an asserted identity is pinned
server-side rather than re-read from tool arguments.

**The Ivanti auth header is `rest_api_key=<key>` — equals sign, not a space.**
`Authorization: rest_api_key=super-secret-key`. Asserted by a test in `overlord-service`; our
first placeholder guessed the space form. *(Resolved 2026-09-11.)*

**Never call `/HEAT/AdminUI/`.**
Those are admin-console services. A tenant API key may carry *any* role and an analyst key is
refused there, so depending on them works only for customers willing to issue an admin-rights
key. `overlord-service` removed its two call sites (`AppDesign.asmx/GetBriefBusinessObjects`,
`AdminAPI.asmx/GetObjectEx`) and keeps a test that drives every descended tool over a stubbed
fetch and asserts no URL contains that path — so reintroducing it fails in CI rather than only on
an analyst-key tenant. Worth carrying over verbatim.

**`AuthenticateTenantAPIKey`'s `role` argument is a request, not a guarantee.**
Asking for a role the account does not hold silently downgrades to its real one — verified live.
Read the effective role back from `Session.asmx/GetUserData`; never assume what was asked for.

**Anything Ivanti resolves "for the current user" answers for the service account.**
A saved search called "My …" returns the API key's service account's items, never the caller's.
Filtering by `Customer` is the only thing that reflects the person actually asking — which is why
the effective `DisplayName` belongs in the server instructions.

**The `/HEAT` prefix is usually present but not always.**
`…/HEAT/api/odata/…` on some tenants, `…/api/odata/…` on others. Probe both once at startup and
keep whichever answers, rather than making it a config field someone gets wrong.

**Ivanti's single-record GET cannot be trusted with `$select`.**
It answers **200 with an empty body**. Projection has to happen client-side — which also means a
projected field the entity lacks is simply absent rather than an error.

**The BO catalog has two sources and neither is strictly better.**
`Workspace.asmx/GetRoleWorkspaces` is role-scoped and rich (display names, layouts) but needs the
ASMX session. `$metadata` entity-type names need only `rest_api_key` and are **wider** — OData
access is governed by Object Permissions, not workspace membership, so an analyst role reads
plenty of objects it has no workspace for.

**Three CSRF conventions on one session, differing only by casing and placement.**
`.asmx` wants `_csrfToken` in the JSON body; `.ashx` handlers want lowercase `_csrftoken` as a
header with a form-urlencoded body and reply with a JavaScript object literal rather than JSON;
multipart uploads want `_csrfToken` as a header. Getting any of them wrong looks like an auth
failure.

---

## Observability

**`/health` must answer without a token, so everything it returns is public.**
A liveness probe cannot authenticate. So the anonymous response is `{"status":"ok"}` and nothing
else, while identity, uptime and session count require the same authorization as any other
request. Status is **always 200** either way — a probe that flaps because a token expired would
restart a healthy container.

**Never report memory or CPU from `/health`.**
An earlier version did. Resource load handed to an anonymous caller turns blind probing into a
guided attack: watch `sessions` against the cap, watch `rssMb` and CPU to see whether load is
landing. Process metrics belong to the container runtime, which is already authenticated. (It
also avoided a second trap — `process.cpuUsage()` legitimately exceeds 100% of wall-clock time
because V8 uses background threads, so an unnormalised figure read as a bug.)

## Testing

**Build a `Config` through `configFixture`, never as a literal.**
Four test files each hand-built one, and adding five `OAUTH_*` keys broke all four at once.
