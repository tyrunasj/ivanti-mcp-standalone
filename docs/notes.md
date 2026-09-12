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

**pnpm's `node_modules` cannot be copied between image stages.**
The default layout is symlinks into a content-addressed store, and a `COPY --from=deps` moves the
links without their target. `pnpm install --prod --node-linker=hoisted` writes real directories,
which is what a distroless runtime can use.

**A distroless image has no shell, so `HEALTHCHECK CMD` cannot be a command line.**
It has to be the exec form against the image's own node — `["/nodejs/bin/node", "…"]` — and the
check itself has to be a script the image carries. `docker/healthcheck.mjs` is plain JS for that
reason: there is no build step inside the image.

**A file-based Docker secret keeps its host ownership, and a distroless image is not root.**
`secrets:` mounts the file as it is on the host, so a key written by your own account with mode 600
is unreadable by uid 65532 inside the container. The server exits 78 with
`EACCES: permission denied, open '/run/secrets/bearer_token'` and the container restart-loops —
which reads like a missing file rather than a permission. `chown 65532:65532` the secret and keep
mode 600: the container can read it and the host account cannot, which is the right way round.

**The tenant hostname resolving on the host says nothing about the container.**
Measured: `dig` on a Mac answered a public address, and the same name inside a container on that
Mac answered `192.168.1.215` — a LAN address it could not route to, so every startup probe failed
as a transport error rather than a 404. `--add-host` (or `extra_hosts:`) pins the address the host
uses. On a Linux host **on that LAN** the same image needs none of this: the name resolves to the
LAN address and the tenant answers. So the failure is a property of where the container runs, not
of the image — check DNS from inside a container before suspecting the server.

**`docker run -e VAR=` sets the variable to an empty string, it does not unset it.**
That is the idiom for clearing a value inherited from `--env-file`, so an empty string now means
"absent" when configuration loads. Before that, `-e AUTH_MODE=` failed with
`Invalid option: expected one of "none"|"bearer"|"oauth"`, which reads like a typo in the schema
rather than a deliberate override.

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

**`AuthenticateTenantAPIKey`'s `role` argument is a request, not a guarantee.**
Asking for a role the account does not hold silently downgrades to its real one. On a live tenant
in 2026-09 it went further: an account holding several roles (`HasMultipleRoles: True`) answered
`ActiveRole: Admin` no matter what was asked for — `ServiceDeskAnalyst`, `SelfService` and
`Employee` all came back as Admin, and the admin console answered 200 for each. So the argument
cannot be used to *drop* privilege either, and a server cannot test its own degraded path by
asking for a lesser role. Read the effective role back from `InitializeSession` (it reports
`ActiveRole`) and refine it with `Session.asmx/GetUserData`; never assume what was asked for.

**Anything Ivanti resolves "for the current user" answers for the service account.**
A saved search called "My …" returns the API key's service account's items, never the caller's.
Filtering by `Customer` is the only thing that reflects the person actually asking — which is why
the effective `DisplayName` belongs in the server instructions.

**The `/HEAT` prefix is usually present but not always.**
`…/HEAT/api/odata/…` on some tenants, `…/api/odata/…` on others. Probe both once at startup and
keep whichever answers, rather than making it a config field someone gets wrong.

**The BO catalog has two sources and neither is strictly better.**
`Workspace.asmx/GetRoleWorkspaces` is role-scoped and rich (display names, layouts) but needs the
ASMX session. `$metadata` entity-type names need only `rest_api_key` and are **wider** — OData
access is governed by Object Permissions, not workspace membership, so an analyst role reads
plenty of objects it has no workspace for.

**`InitializeSession` already reports the effective role.**
Its `SessionStatus` carries `ActiveRole`, `ActiveRoleDisplayName`, `UserName` and
`SessionCsrfToken`, so the identity is known after step two and `GetUserData` only adds the display
name. That matters because `GetUserData` is the step most likely to fail — treating it as optional
keeps the session usable and the role honest. Measured live 2026-09-11.

**The SID is not a GUID.** `AuthenticateTenantAPIKey` answers `"<host>#<KEY>#1"` — 58 characters on
a live tenant. Anything validating it as a GUID would reject a working session.

**`GetRoleWorkspaces` already carries the Business Object id — do not derive it from the layout.**
Each row has `ID` (`Incident#`, `OnboardingRequest#`, `XLJ_Car#`, `CI#Service`) and a `Profile`;
the object workspaces are the ones with `Profile === 'ObjectWorkspace'` — 24 of 31 on a live
tenant, and every one of their ids is real. Deriving the object from `LayoutName` instead
(`Onboarding` → `Onboarding#`, `CarLayout` → `Car#`) is wrong for exactly the interesting cases,
and the confirmation call it forces — `GetWorkspaceData` — answers **HTTP 500** for a wrong guess
rather than a clean "no". One call, no guessing, no 500s. *(Corrected 2026-09-11 after measuring;
the earlier layout-derivation came from `overlord-service`.)*

**The admin console is real, and the path needs `services/`.**
`/HEAT/AdminUI/AppDesign.asmx/GetBriefBusinessObjects` answers **404**;
`/HEAT/AdminUI/services/AppDesign.asmx/GetBriefBusinessObjects` answers **200** with the tenant's
complete catalog — 1324 objects, 505 KB, ~50 ms warm — each with `id`, `name`, `displayName`,
`description`, `commonlyUsed` and `pureValidationObject`. Booleans arrive as the strings `'True'`
and `'False'`. An admin-rights key reaches it; a key without those rights does not, which is why
everything built on it falls back to the workspace list and then to the metadata names.

**`permissions` in that catalog is not an access boundary.**
It takes the values 0, 2 and 3 (47 / 829 / 448 objects), and a `permissions: 0` object such as
`CurrencyCode#` still reads perfectly well over OData. It describes admin-console design rights,
not data access — filtering a catalog by it would hide objects the caller can read.

**The handshake is fast.** Measured with curl on a live tenant: `AuthenticateTenantAPIKey` 18-58 ms,
`InitializeSession` 29 ms, `GetUserData` 68 ms. A slow handshake means something else is wrong.

**The `.ashx` handlers live one folder deeper than expected.**
`/HEAT/handlers/GridDataHandler.ashx` answers 404; the real path is
`/HEAT/handlers/GridDataHandler/GridDataHandler.ashx` — a folder per handler, found by reading the
app's own `Default.aspx`. The third calling convention is confirmed there: a form-urlencoded body,
the CSRF token as a **lowercase `_csrftoken` header**, and a `text/html` reply. Without that header
the handler answers **551**; with it, 200. The payload each handler wants is its own business and
is still unknown for GridDataHandler. *(Corrected 2026-09-11 — the earlier note said the handler
was absent on this tenant.)*

**Ivanti names a field three times, and the user reads the one nearest them.**

| Layer | Where it lives | Example |
|---|---|---|
| technical name | the object | `Symptom` |
| display name | `TableMeta.Fields[].DisplayName` | `Description` |
| form label | a form control's `Label` | whatever this form's designer chose |

A form may rename a field **for its own users**, so the display name is not the last word: two
forms over the same object can show the same field under different words, and the words a person
quotes are their form's. `fieldLabels` therefore resolves form label → display name → technical
name, in that order.

**The limit of that, measured:** the form this server resolves is the create/header form, and on a
stock tenant it binds almost no fields — `Incident.Admin.Header.AUSpark` has **one** field-bound
control out of twenty. So nearly every label in practice comes from layer 2, and a field renamed
on some other form is invisible here. That is a gap to know about rather than one to paper over:
when a user's words match nothing, ask which screen they are reading rather than assuming the
field does not exist.

**Field labels and link fields differ per object — the same field name can mean different things.**
Measured across one tenant's forms: `ProfileLink` is labelled **"Customer"** on `Incident#` and
**"Contact Link"** on `ServiceReq#`; `Change#` has no `ProfileLink` at all and carries
`RequestorLink`; `FRS_Knowledge#` has **no link fields** while `CI#` has 21. The label "Customer"
exists on exactly one of those objects. "Description" resolves to `Symptom` on incidents and
service requests, `Description` on changes, problems and CIs, and **`Details`** on knowledge
articles.

So nothing may hardcode a mapping, and a tool description that teaches one object's field names as
the general rule is a bug even when the code is right: the model will carry `ProfileLink_RecID`
from an incident to a change, where it does not exist. The rule that *is* general is the shape —
a link is `<Link>_RecID` plus `<Link>_Category` — and `get_link_fields` answers the rest per
object. `Task#Assignment` has no form for an admin role here at all, so it has no answer to give.

**Ivanti's required-field refusals name DISPLAY names, and some of them are not fields.**
`Required field Incident.Description value must be provided` means `Symptom`; `Incident.Customer`
is not a field at all but a link, written as `ProfileLink_RecID` plus `ProfileLink_Category`. The
translation lives on the form — `TableMeta.Fields[].DisplayName` and `LinkIdMap` — and without it
a caller writes a field that does not exist. Measured live 2026-09-11.

**Required-field rules are conditional, and fire on a status change.**
An incident accepts `Status: 'Logged'` with nothing else, and refuses `Status: 'Active'` until
`Category` and `Owner` are set — in the same call. Nothing asks for them beforehand, and
`BusObjectRequiredRules` on the form lists thirteen fields without saying when each applies. So
the useful thing to report is Ivanti's own message, translated.

**The CSDL `validated` flag and the form disagree — in both directions.**
Task's `$metadata` reports **no** validated fields while its form declares **twenty**; a role's
form can equally be narrower than the object. Gating the write path on the CSDL flag therefore
sent a picklist value out unresolved and Ivanti answered **500 with an empty message**. The form
is the authority for a write; the form chain is cached per object, so consulting it costs three
calls once.

**A quick-action "preview" over the grid path RUNS the action.**
`Save.asmx/SaveDataExecuteAction` honours `shouldSave: false` on the **FormParams** path only;
`GridParams` ignores it and executes while answering like a probe. So a preview needs a form the
role can reach, and where there is none this server refuses to preview rather than guessing. The
form path is verified harmless: two previews against a live incident left `LastModDateTime`
unchanged.

**A quick action's failure is in `validationErrors`, not in `status`.**
The shape is `validationErrors[recId].fieldErrors[field].fieldMessages[]`, and those messages name
the field — *"Category: Required field Incident.Category value must be provided"* — while the
top-level status says only that something went wrong. `PreDeleteObject` is worse: a clean preview
answers **status `error`** while carrying nothing but warnings, so only `errorMessages` blocks.

**Seven of 104 quick actions on a stock Incident are `UIAction`.**
They are behaviour of Ivanti's own web client with nothing to execute server-side: running one
answers OK and changes nothing. Both the preview and the run refuse them, because reporting that
as success is worse than refusing.

**Action ids are per-tenant *and* role-scoped.** An id seen under another role, or on another
tenant, does not exist here — so every call re-reads the list rather than trusting an id it was
handed.

**A saved search keeps every key and blanks the values under `$select`.**
Asking for `$select=Subject` returns all 181 keys with nulls in the ones not selected, so it costs
a round trip and saves nothing; the trim is client-side. A search that matches nothing answers
**204 with an empty body**. Thirteen of the 25 saved searches on a stock Incident begin "My" and
resolve against the signed-in account — the API key's, never the caller's.

**Ivanti has no aggregation endpoint.** "How many per status" is one filtered count per value, and
the values come from the field's own validation list. That is why `group_count` is capped at 25
buckets: each one is a round trip.

**A base type cannot be created — its subtypes can.**
`Task#` is a base type with seven subtypes (`Task#Assignment`, `Task#WorkOrder`, …), and `TaskType`
is its type *selector*, not a picklist: `get_pick_list_values` reports no options because there are
none to choose. `POST /Tasks` answers `400 Required field Task.TaskType` and, once a plausible
value is supplied, **500 ISM_5000 with an empty message**. `POST /task__assignments` with nothing
but a Subject succeeds. Reading the base type is fine — `/Tasks` returns all 215 tasks whatever
subtype each one is.

Subtypes are visible in any catalog (`task__assignment` in CSDL, `Task#Assignment` in the admin
console), so `get_object_metadata` reports them and a failed create names them. Detecting them
needs the **widest** catalog: no default metadata graph contains `task__assignment`, so asking
only the graphs reports "no subtypes" and the real cause never surfaces.

**A validated field's values are not in `$metadata`.**
They live on the create form, reached by walking `GetRoleWorkspaces` → `GetWorkspaceData` →
`FindFormViewData` → `GetFormDefaultData` → `GetFormValidationListData`. Calling the last one
without that context fails with a misleading *"You do not have permission to view this item"*.
The reply is columns, not objects: the stored value is at the **lowest** index in `FieldMap`,
`DisplayName` labels it, `RecId` identifies it, and an empty list with `SameAs` means "reuse that
field's options". Measured live: Incident Status has 7 values, Priority 5, Source 13.

**A cascade parent supplied under the wrong name filters nothing, silently.**
`GetFormValidationListData` takes the parents inside the data model, so a key the form does not
have is simply ignored and the answer comes from the unfiltered list — whose values may not be
valid for the record in hand. Nothing in the reply says so, which is why the tool compares the
supplied keys against the form's own fields and reports the ones it ignored.

**An unknown entity set is not an error — Ivanti invents the entity.**
`/api/odata/nonexistents/$metadata` answers **200** with valid CSDL containing
`<EntityType Name="nonexistent" />` and an `EntitySet` to match: no fields, no relationships. Every
real Business Object has at least RecId, so `parseCsdl` drops field-less entity types and the
catalog reports the name as unknown *with suggestions*. Measured live 2026-09-11.

**Only the graph's root entity carries relationships.**
Measured live: in the incidents graph, `task` has 90 fields and **0** relationships; in
`tasks/$metadata` the same entity has 90 fields and **29**. Field counts agree across graphs
(90/90, 127/127, 278/278) — relationships do not. So a relationship-less hit is not an answer, it
is a reason to fetch the entity's own graph, which is what `MetadataCatalog.entity()` does.

**No single document lists the tenant's Business Objects.**
A CSDL graph names only what its root relates to. The incidents graph names 38 entities; eight
well-known graphs together name ~200, in under a second. The full ~1300-entry list lives behind
`/HEAT/AdminUI/`, which an analyst key is refused — so the union of graphs is the widest catalog an
ordinary key can reach, and `list_business_objects` says so rather than implying completeness.
Lookups are not limited to it: `entity()` finds anything real by fetching its own graph.

**A page of whole records is 187,000 characters.**
`list_records` with the default `top=25` and no field list measured **187,278 chars (~47k tokens)**
on a live tenant — an incident carries ~180 fields. The same call projected to a compact set is
9,496. A tool description asking the caller to narrow the fields does not prevent this; the
default has to be narrow, with an explicit `"*"` for the rare case that wants everything.

**`$top` is capped at 100.** 100 returns 100 rows; **101 answers 400** `ISM_4000 "Invalid Request
Payload"`. `$skip` pages without repeating rows, so paging is the way past the cap.

**`@odata.count` arrives unasked, and can contradict its own rows.**
Ivanti includes it on plain queries without `$count=true`. It has been seen smaller than the page
it came with; `readTotal` reports that as a **floor** (`exact: false`) rather than a total, because
reporting a floor as a total is the failure the count tools exist to prevent.

**`$search` is the only substring mechanism, and it works.**
Case-insensitive, composes with `$filter`, and returns a count: `printer` matched 48 incidents on
a live tenant where `contains(Subject,'printer')` returned the full unfiltered 545. `$expand`, by
contrast, is silently ignored under `rest_api_key` — a request that looks like it inlined related
records did not.

**Null and dates in a filter.** An empty field matches only as `Owner eq '$NULL'`. Dates are bare
and unquoted — `CreatedDateTime gt 2026-01-01`; the OData v2 form `datetime'…'` is rejected with a
400 that blames the field rather than the literal.

**The validation-list endpoint is a POST.**
`/api/rest/ServiceRequest/{paramRecId}/ValidationList` needs `POST` with a constraints body: a GET
answers an empty XML array, which looks like "this list has no values".

**A refused key answers `401 ISM_4001`, not a 404.**
`"Invalid Session key or Authentication token or Host"` — measured with a wrong key and with an
empty one. The startup probe treats a 401/403 on any candidate as "the tenant is reachable, the
credential is wrong" and says so, because "could not reach Ivanti" sends whoever reads it to check
DNS and firewalls for a problem that is one environment variable.

**`Accept: application/json` on `$metadata` turns a 200 into a 500.**
Ivanti tries to content-negotiate CSDL into JSON and throws: the body comes back as
`Unhandled system exception: {&quot;error&quot;…}`, 592 bytes, status 500. The *same URL* with
`Accept: application/xml` (or no Accept at all) answers 200 with 325 KB of CSDL. Measured on a
live tenant 2026-09-11. `requestText` therefore defaults to XML, and the base-path probe asks for
XML explicitly.

**`$metadata` is served per graph, and the obvious forms are the ones that do not exist.**
Measured live: `/HEAT/api/odata/$metadata` and `/HEAT/api/odata/businessobject/$metadata` both
answer `404 ISM_4004 "No service"`, while `/HEAT/api/odata/incidents/$metadata` answers the full
related graph — 38 entity types, 325 KB. Note the path has **no `businessobject` segment** and the
graph name is lowercase plural, unlike the CRUD route (`/api/odata/businessobject/Incidents`).
`overlord-service` arrived at the same three-candidate ladder, so this is not one tenant's quirk.

**Ivanti has three different ways of saying "no rows", and two of them are not arrays.**
Measured live:

| Request | Answer |
|---|---|
| Entity set, `$filter` matches nothing | **200 with a completely empty body** |
| Navigation property with nothing related | `{"value": "No instances found."}` — a **string** |
| Anything with rows | `{"value": [ … ]}` |

The sentinel is the nastier one: `value.length` is 19 and `value[0]` is `"N"`, so a caller that
trusts it reports 19 related records. `readCollection()` in `src/ivanti/odata-response.ts` absorbs
both, and **refuses any other string** rather than reporting prose as an empty result — "Access
denied" must not arrive as "no rows".

**Confirmed live: `$select` on a single-record GET returns nothing at all.**
Not merely a thin record — the body is `{"@odata.context": …}` and no fields whatsoever, while the
same record without `$select` returns 182. Projection is client-side, full stop.

**A 200 from `$metadata` is not proof the base path is right.**
A login page or a WAF interstitial answers 200 with HTML, and taking that as success poisons
everything downstream — the wrong base path is then used for every request and reads like an
authentication failure. The probe checks for an `<Edmx>` root, not just the status.
*(Found while building B1, 2026-09-11.)*

**The startup probe needs its own timeout.**
It runs before the process serves anything, so an unreachable tenant that accepts the connection
and never answers hangs the startup indefinitely — worse than exiting, because a container stuck
part-way through starting looks alive. `PROBE_TIMEOUT_MS`, separate from the request timeout.
*(Found while building B1, 2026-09-11.)*

**`encodeURIComponent` does not escape `'`, and Ivanti keys are single-quoted.**
`Incidents('<RecId>')` breaks out of the key on an apostrophe, so the key builder escapes it
explicitly. RecIds are 32-char hex in practice, but a URL builder should not depend on its
callers being well behaved. *(Found while building B1, 2026-09-11.)*

**Three CSRF conventions on one session, differing only by casing and placement.**
`.asmx` wants `_csrfToken` in the JSON body; `.ashx` handlers want lowercase `_csrftoken` as a
header with a form-urlencoded body and reply with a JavaScript object literal rather than JSON;
multipart uploads want `_csrfToken` as a **header, mixed-case**. Getting any of them wrong looks
like an auth failure. *(All three now have callers; the multipart casing was confirmed
2026-09-12 by the service-request attachment path.)*

**Keyword `search` over-matches, and the extra rows look exactly like real ones.**
`search: "John"` on Employees returns John Smith, John Davis, John M Doe — **and Scott Johnson**,
because it is a substring match across the record's text fields. Anything that asks a human to
pick themselves from a candidate list has to re-filter the result client-side against the fields it
actually meant, or it will offer a stranger as a plausible option.
*(Measured 2026-09-12, while designing `act_as`.)*

**`DisplayName` is assembled and includes the middle name.** "John M Doe", "Katherine M Joseph" —
so the full name a person types for themselves routinely fails to `eq`-match it. Match on
`FirstName` + `LastName`; display `DisplayName`. *(Measured 2026-09-12.)*

**OData `eq` is case-insensitive here.** `FirstName eq 'harold' and LastName eq 'SANDERS'` matches
Harold Sanders. Useful — no normalisation needed on either side — but worth knowing rather than
assuming, since it is the opposite of what `eq` means in several other OData implementations.
*(Measured 2026-09-12.)*

**`CreatedBy` can be overridden; `LastModBy` cannot.** Ivanti fills both from the session, but a
create that sends `CreatedBy` keeps it — measured on an incident and on a note. `LastModBy` is
stamped by the engine on every write even when sent explicitly, and the write **reports it as
changed** while storing the session account. That split is useful rather than annoying: an end
user's ticket can say they authored it while `LastModBy` records the account that performed it,
which is what actually happened. *(Measured 2026-09-12.)*

**A raw field update is not a vote.** Setting an approval vote row's `Status` to `Approved` stored
the status, overwrote `VotedBy` with the **session account** despite being sent the approver's
login, and left the parent approval `Pending` — the workflow never fired. The verbs that work are
the `Approve Vote` / `Deny Vote` quick actions on the **vote row**, not "Approve My Vote" on the
approval, which resolves "my" from the session and would record the wrong person. Because the row
already belongs to a named approver, acting on it records *their* decision.
*(Measured 2026-09-12.)*

**A quick action runs through the form path with an empty form name.** `frs_approvalvotetracking`
has no form for the Admin role, so `run_quick_action` refuses it — but `SaveDataExecuteAction` with
`FormParams` and `formName: ''` executed it correctly (`saved: true, status: OK`) and moved the
row. So the no-form refusal is about not being able to *preview*, not about being unable to run:
where a run is intended and verified afterwards, the empty form name is enough and the grid path
is still never needed. *(Measured 2026-09-12.)*

**A vote that registers does not always advance its approval.** The vote row moved to `Approved`
with a fresh `VotedDateTime`, and the parent `frs_approval` stayed `Pending` — one voter, no
quorum to wait for, and no change after waiting. Whether that is specific to a 16-month-old demo
record or general is not established, so `vote_on_approval` reads **both** rows back and says
plainly when the vote is in but the approval has not moved. *(Measured 2026-09-12.)*

**A service request's attachments are staged before the request exists, and only the ASMX submit
binds them.** Three calls in order: `GetPackageDataSDA` (a session side effect, and the submit
refuses staged ids without it having run again immediately beforehand), `GetUploadTicket`, then a
multipart POST to `SelfService/handlers/UploadAttachmentHandler.ashx` carrying `objectId: ''`,
`objectType: 'ServiceReq#'`, the ticket and `multiplefiles: true`. The handler answers a
JavaScript object literal, not JSON: `{ attachmentIds:[ { filename:"x" ,attachmentId:"CE16…" } ] }`
— unquoted keys, leading commas. `SubmitRequestForUser` then takes `attachmentsToUpload` as
`[[id, filename]]` pairs, and its two location fields are not what they are named:
`strCustomerLocation` carries the form name `ServiceReqHeader.New`. Verified end to end — the file
lands with `ParentLink_Category: 'ServiceReq'` pointing at the new request.
*(Measured 2026-09-12.)*

**Keyword search reaches only what Ivanti INDEXES, and an empty result reads exactly like "none
exist".** Measured: `png` finds none of the tenant's **344 PNG attachments**, and `laptop` finds
neither computer whose `ChassisType` is literally "Laptop". It covers a ticket's subject,
description and notes — not structured fields, and on some objects almost nothing. This was the
single most dangerous sentence in the tool manifest, because it told a model an empty result
"genuinely means no match". *(Found 2026-09-12 by six agents driving the tools blind.)*

**A grouped count can omit most of the table while every bucket says `exact: true`.** The buckets
come from a create form's validation list; records holding a value that list no longer offers fall
into no bucket. Measured: a change's statuses summed to **12 of 51**, an incident's categories to
**81 of 547**. The per-bucket flag guards the wrong thing — the counts were right, the set of
buckets was short. `group_count` now reports `total` and `unaccounted`. *(Measured 2026-09-12.)*

**An unfiltered picklist is a SUBSET, not the union.** An incident's `Category` answers **5**
values unfiltered, **13** under one Service, and its backing object holds **69**. The unfiltered
answer is the list for the form's default parent, so presenting it as "the categories" understates
by an order of magnitude. *(Measured 2026-09-12.)*

**`ISM_4000` is not only "not found".** It is Ivanti's code for a refused payload generally: a
missing record answers it with `"Invalid key"`, and a **prompt-gated status transition** answers
the same code with `DataLayer.PromptException`. Matching the bare code made every gated transition
report "the record or field does not exist", which sent two independent testers hunting a field
name that was never wrong. *(Found 2026-09-12.)*

**An unhandled Ivanti exception volunteers session internals.** A 500 from `PreDeleteObject` came
back carrying `SessionId`, `TenantId`, `LoginId`, `Hostname` and `ServiceName`. `scrubErrorBody`
redacted the API key because that was the only thing anyone had thought to look for; these now go
too. *(Found 2026-09-12.)*

**Ivanti refuses an upload by file EXTENSION, per tenant, and answers 200 while doing it.** The
same bytes upload as `.txt` and are refused as `.log`, with `IsUploaded: false` and
`"Invalid attachment type"` inside a success status. *(Measured 2026-09-12.)*

**A service-request date is stored at the offset in force ON THAT DATE, not today's.**
`2026-11-01` submitted in September stores as `2026-10-31T23:00:00Z` — local midnight at the
winter offset, after the clocks change. Comparing instants against the offset discovered from a
recent record calls a correct write a mismatch, and a mismatch reported on a correct write is what
sends a caller into a second, non-idempotent submit. A bare date is compared by the day it lands
on, with an hour of tolerance. *(Measured 2026-09-12.)*

**`FRS_Knowledge` is a base type and the article body is not on it.** The base carries title,
status and a summary; an IssueResolution's actual fix lives in `Resolution` on
`frs_knowledge__issueresolution`. `FRS_KnowledgeType` on the base row names the subtype
(`IssueResolution` → `frs_knowledge__issueresolution`). Whatever fields the subtype has that the
base lacks *are* the body, which holds for all six subtypes without naming any of them.
*(Measured 2026-09-12.)*

**A client truncates a long tool description silently, and from the END.** So whatever sits last
is what disappears — which is where warnings go. Measured in `overlord-service` against the Claude
Code harness: two tools cut at ~2040 and ~2044, pointing at a 2 KiB cap that the MCP spec does not
mention. `src/tools/description-budget.test.ts` fails the build at 2000 rather than letting a
warning vanish into a conversation.

**Closed is final, and Ivanti means it everywhere except updates.** A closed record is read-only:
a DELETE answers 400 and a reopen action answers `saved: true, status: 'error'` while changing
nothing — both expected, and the second is another outing for the untrustworthy `saved` flag. A
resolved record is not read-only and reopens normally. The **update** path is the one place Ivanti
does not hold the line: a PATCH to a closed record is accepted and stored, which is the gap this
server closes. A test record closed in passing therefore cannot be tidied away — it stays until
the tenant is reset. *(Measured 2026-09-12.)*

**Ivanti marks a closed record read-only and then writes to it anyway.** A closed incident carries
`ReadOnly: true` — measured across statuses, true for `Closed` and false for `Resolved`, `Active`
and `Logged`, which is exactly the lifecycle: a resolved ticket can still be reopened, a closed one
is final. A PATCH against one answered **200 and stored the change**. `IsInFinalState` looks like
the same signal and is not: it reads false even on closed records. So the flag is enforced in this
server or nowhere. *(Measured 2026-09-12.)*

**A file downloads from the same endpoint that deletes it.** `GET /api/rest/Attachment?ID=<recid>`
streams the bytes with a real `content-type` and `content-disposition`; it is the same path as the
`DELETE`, differing only in method. Read it as bytes, never as text — decoding a PNG as UTF-8
produces something that is no longer a PNG. *(Measured 2026-09-12.)*

**An approval step holds no approver.** `frs_approval` has `Owner`/`OwnerTeam` for the step itself;
the people are on its `frs_approvalvotetracking` rows, where `Owner` is the approver's **login**
(`OwnerRecId` is null on this tenant), and `PrimaryParentObject` / `PrimaryParentID` name what is
waiting. So "what needs my approval" is a filter on the vote-tracking object, not on the approval.
*(Measured 2026-09-12.)*

**An object allowlist guards the object you NAME, not the object you REACH.** `get_related_records`
gated only its source, so on a tenant whose `ENDUSER_BUSINESS_OBJECTS` refuses `Employees`,
`IncidentOwnerEmployee` from an allowed incident returned the owning analyst's full employee record
— login, email, status. Traversal now checks the relationship's *target* against the same gate.
The same hole exposed staff-internal journal notes on the caller's own ticket, which `list_notes`
filters by `PublishToWeb` and a raw traversal did not.
*(Found 2026-09-12 while wiring notes; a gate that is enforced in one direction only is not a
gate.)*

**A group Business Object's extension name can end in `s`, and the name resolver singularised it
away.** `journal__notes` — the extension a person writes a note to — became `journal__note`, so
`list_business_objects` handed out a name that `list_records` then refused, suggesting the name it
had just been given. The entity set is the CSDL name plus a literal `s` (`journal__notess`), and
the guess that builds it would not add a second `s` either, so the right graph was never fetched.
Both directions now try the name as given before the guess. *(Found 2026-09-12.)*

**`Journal` is a group object; a note is its `journal__notes` extension, and the two behave
differently.** Creating on the group needs `JournalType` by hand and puts the text in `Subject`;
creating on the extension sets the type itself, defaults `Category` to `Memo`, and has a real
`NotesBody` field. Reading through the group relationship returns Ivanti's own email traffic —
**7 of 7** journals on this tenant's incidents are `JournalType: Email` — while querying the
extension returns notes only. `PublishToWeb` is what separates a reply to the customer from an
internal note, and it defaults to **false**. *(Measured 2026-09-12.)*

**A knowledge article has an audience, and it is a row-level rule.** Ivanti's self-service portal
searches only articles whose `Status` is `Published`; Draft, In Review, Reviewed, Expired,
Archived and Rejected are internal. On this tenant that is 27 published against 18 that are not.
An object allowlist cannot express "this object, but only these rows", which is why the knowledge
base is reached through its own tool rather than by allowlisting `FRS_Knowledge`.
*(Measured 2026-09-12; states from the Ivanti admin docs.)*

**The attachment upload does half the job and reports success.** `POST /api/rest/Attachment`
stores the bytes and answers `[{FileName, IsUploaded: true, Message: '<RecId>'}]` — and leaves
`ParentLink_RecID` and `ParentLink_Category` **null**. The file exists, belongs to nothing, and is
reachable only by searching the attachment table for its name. Linking it is a second request, a
PATCH of the pair. Worse, the upload does not check the parent: posting against a RecId of all
zeroes answered 200 and created an attachment, so the parent has to be read *before* the bytes go.
*(Measured 2026-09-12; overlord recorded the same in May.)*

**A delete of an attachment that never existed answers 204.** So does a real one. `deleted: true`
means nothing unless the record was read before and after. *(Measured 2026-09-12.)*

**A service-request submit answers HTTP 200 when it refuses.** The envelope is
`{IsSuccess: false, ErrorText: "...", ServiceRequests: []}` and nothing is created. It names one
missing parameter at a time, by parameter *name*, so fixing one reveals the next.
*(Measured 2026-09-12.)*

**A service-request datetime needs the tenant offset NEGATED, and the sign is destructive.**
Sending `2026-09-30T00:00:00Z` to a UTC+2 tenant stored, by `localOffset`: `-120` →
`2026-09-30T00:00:00Z` (correct), `0` → `2026-09-29T22:00:00Z` (a day early), `+120` →
**`0001-01-01T00:00:00`** — the value destroyed, while the submit still reported `IsSuccess: true`.
The offset in a rendered Ivanti datetime is the one in force *at that instant*, so reading it off
an old row gets a daylight-saving-shifted answer; the newest row is the one to ask.
*(Measured 2026-09-12.)*

**A combo service-request parameter needs its option's RecId as a sibling key.** `par-<id>` holds
the value and `par-<id>-recId` the option; without it the submit is refused with *"'Department'
validation list's value was submitted without it's identifier."* — Ivanti's own apostrophes.
*(Measured 2026-09-12.)*

**`strUserId` on a service request is the person's RecId**, and `Frs_CompositeContract_Contacts`
shares it: the contact row for an employee or an external contact has the *same* RecId as the
person. So the id `act_as` pins is the one the submit wants, with no second lookup.
*(Measured 2026-09-12.)*

**An offering carries two different ids.** `strSubscriptionId` is what a submit takes and
`strRecId` what the parameter tools take. Mixing two offerings' ids creates a request with **none**
of the answers applied, which Ivanti reports as success — the only signal is an empty
`parameterTemplateParameterIds` in the reply. The whole catalog is also 144 KB of JSON for 132
offerings, most of it per-offering rendering hints. *(Measured 2026-09-12.)*

**An attachment's "relationship" to its ticket is just the attachment's own parent fields, so
unlinking one orphans it.** `IncidentContainsAttachment` and
`attachments?$filter=ParentLink_RecID eq '<incident>'` return the same row, because the
relationship is a view over `ParentLink_RecID` + `ParentLink_Category` on the attachment. Measured
live: `unlink_records` leaves the attachment row in place with **both halves null** — a file that
is on no ticket, that no ownership check can match, and that an end user therefore cannot reach or
clean up ever again. `link_records` puts the pair back, but only for someone who still has the
RecId, which after orphaning nothing will hand out. Detaching a file is `delete_attachment`;
attaching one is the multipart upload, which sets the pair itself. Neither is `link_records`.
*(Measured 2026-09-12 on throwaway records, all removed.)*

**CSDL spells an object lowercase; records spell it mixed-case, and a write needs the record's
spelling.** `$metadata` names the entity `employee`, while an incident's `ProfileLink_Category`
holds `Employee`. Deriving one from the other means guessing at capitalisation for every tenant
that renamed something, so `customer-link.ts` reads the spelling off sampled rows instead.
*(Found while building `act_as`, 2026-09-12.)*

**The field tying a record to a person is different on every object, and the familiar name is
sometimes absent.** An incident uses `ProfileLink_RecID`; a service request has that *and*
`AlternateContactLink_RecID`; a change has neither and uses `RequestorLink_RecID`. A name ladder
answers wrongly for the change and ambiguously for the service request, so the field is discovered
from data — sample rows, see which `*_Category` actually holds a person object — with the ladder
kept only as a tie-break and for an object that has no records yet. Verified live: 51 of 51
changes answer `RequestorLink`, and the service request's alternate contact is null on every row.
*(Measured 2026-09-12.)*

---

**A bad `$orderby` answers 204, which reads as "no rows".**
A mistyped *filter* field answers `400 ISM_4000` and can be explained. A mistyped **orderBy**
field — or a mistyped direction — answers **204 No Content**, one of Ivanti's three encodings for
an empty result. Measured on `incidents`: no `$orderby` and `CreatedDateTime asc` both answer 200
with `@odata.count` 548; `CreatedDate asc`, `NotAFieldAtAll asc` and `CreatedDateTime bogus` all
answer 204. So one missing `Time` silently turns 548 records into none, with no error anywhere.
`assertOrderBy` refuses locally before the request, the way `assertSupportedFilter` does. Accepted
forms, all verified: bare field, `asc`/`desc` in either case, several clauses comma-separated.
*(Measured 2026-09-12.)*

**`$search` ANDs on spaces, honours `or`, and matches from the start of a word.**
Four behaviours, none documented by Ivanti. On `incidents`: `projector` → 3, `boardroom` → 2,
`projector boardroom` → 2, `projector printer` → **0**, `projector or printer` → 51,
`projector AND printer` → **0** (the word `AND` is searched for literally),
`"projector remote"` → **0** (quoting matches nothing), `projec` → 3, `rojector` → **0**.
So passing a user's sentence through returns zero about a record that exists, and the only way to
widen is `or`. *(Measured 2026-09-12.)*

**A refused attachment extension arrives as HTTP 300, not a 2xx or a 4xx.**
Ivanti keeps a per-tenant allowlist and decides from the *filename*. The same bytes uploaded as
`.txt` answer 200 with `IsUploaded: true`; as `.log` they answer **300 Multiple Choices** with
`[{"IsUploaded":false,"Message":"Upload Failed, Invalid attachment type."}]`. Because `fetch`
reports 300 as `ok: false`, the transport threw before anything read the body — so the whole
"explain the refusal" path was unreachable and the caller saw a bare `Ivanti POST 300`.
*(Measured 2026-09-12.)*

**`CreatedBy` can be overridden on an attachment; `ParentLink_Category` must be the AdminUI id.**
A PATCH linking a new attachment fails with *"Role Admin does not have rights to update following
fields"* when `ParentLink_Category` is `Incident`, and succeeds with `Incident#`. With the right
spelling, `CreatedBy` set in the same PATCH is accepted **and sticks** — so an uploaded file can be
attributed to the person it came from rather than to the server's service account. `LastModBy`
still does not stick, the same split as on record creation. *(Measured 2026-09-12.)*

**`IsInFinalState` is `false` on closed records.**
It reads like the field for "can this still be edited" and is not: measured across this tenant,
every record carries `false` regardless of status, including `Closed`. `Status` and `ReadOnly`
are the fields that answer. *(Measured 2026-09-12.)*

**An unhandled ASMX exception volunteers session internals, escaped inside a JSON string.**
A 500 body carries `LogEntryId` whose value is itself JSON-encoded, so `SessionId`, `TenantId`,
`LoginId`, `ClientIpAddress`, `Hostname` and `ServiceName` arrive as `\"SessionId\":\"…\"`
rather than `"SessionId":"…"`. A scrub regex matching only the unescaped form redacted exactly one
of the six — the one field that happens to sit outside the nested string — and read as working.
*(Measured 2026-09-12.)*

**No fixed field list identifies a record across tenants.**
A tenant defines its own Business Objects and renames fields on the ones Ivanti ships, so
`COMPACT_ROW_FIELDS` is a preference and never a definition. Measured: `attachment` and
`standarduserteam` share not one name with it and came back as a RecId plus two timestamps; their
identifying fields are `ATTACHNAME` and `Team`. Metadata does not rescue it — CSDL reports
`nullable: false` on almost nothing (`incident` and `change`: zero required fields) and
under-reports validated fields. So the default falls back to the row's own leading fields and says
that it did. *(Measured 2026-09-12.)*

**The tenant's grid columns are not reachable from the ASMX surface.**
`GetWorkspaceData` returns `GridViewData`, but it carries only `viewName`, `objectType`,
`gridName`, `defaultPreviewForm`, `formMap` and `toolbarDef` — no column list.
`FindGridViewData`, `GetGridViewData`, `GetListData` and `Services/Grid.asmx` all fail. So "which
fields does this tenant show in a list" has no cheap answer, which is why the point above falls
back to the row. *(Measured 2026-09-12.)*

**A test fixture that throws synchronously does not exercise a `.catch`.**
`connectionFixture` built its transport as `Promise.resolve(answer(url))`, and `answer` throws —
so the throw escaped before the promise existed and any `.catch()` on the call never ran. The real
transport is async and always rejects. One whole error path (`uploadAttachment` unpacking Ivanti's
300) passed its tests while being unreachable in production.

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
