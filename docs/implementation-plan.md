# Ivanti MCP (standalone) — Implementation Plan

**Date:** 2026-09-10 · Companion to [`initial-design.md`](./initial-design.md), which holds the
decisions and their rationale. This document is the order of work.

## Shape of the plan

Two phases. **Phase A finishes and proves authentication with `get_version` as the only tool.**
Phase B adds Ivanti functionality against an auth layer that is already settled.

That ordering is deliberate. Auth is cross-cutting — it touches transport, sessions, config and
every handler — and it is the thing that is genuinely expensive to retrofit. Proving it against a
single trivial tool means no Ivanti behaviour is in the loop when something fails: a 401 is an
auth bug, never a question of whether the Ivanti call was malformed.

`get_version` is sufficient for the entire matrix. Every auth question — is the token valid, is
it for us, does discovery work, does the session survive, is the origin rejected — is answered by
whether one trivial call succeeds or fails.

## Principles

1. **Every stage ends deployable** — runnable, with something a client can call.
2. **A stage is done when its exit criteria pass**, not when the code is written.
3. **Phase B adds one axis per stage:** read before write, `full` before `enduser`.

---

## Where this stands (2026-09-12)

| Stage | | What is missing |
|---|---|---|
| A0 Scaffold | ✅ | — |
| A1 Transport and harness | ✅ | — (the container landed here) |
| A2 Identity seam | ✅ | — (the Employee-record join is B7) |
| A3 OAuth resource server | ✅ | Entra's live token check, blocked by a deployment prerequisite |
| A4 Prove the matrix | 🟡 | the Entra row only — blocked by a verified-domain prerequisite, not by code |
| B1 Transport foundation | ✅ | — |
| B2 Metadata, naming, reads | ✅ | — |
| B3 Session and capability tier | ✅ | the `.ashx` payload and multipart, which wait for a caller |
| B4 Writes and hints | ✅ | — |
| B5 Workflow surface | ⬜ | quick actions, saved searches, `group_count`, `preview_delete` |
| B6 Service requests, attachments | 🟡 | `submit_service_request`, offerings, every attachment write |
| B7 enduser and resources | 🟡 | "own records" (needs A2), and the resources tier |

**Twenty tools are registered today**: `get_version`, eleven reads, `get_pick_list_values`
(session-gated), the retrievable pair, and five writes. Against the 34-tool inventory below, the
fourteen not built are B5's ten, B6's four writes, and `list_request_offerings`.

---

# Phase A — Authentication, complete and proven

## Stage A0 — Scaffold ✅ done

Config with fail-closed validation, structured stderr logging, `get_version`, stdio and HTTP
(`none` / `bearer`) transports, ESLint, Vitest with tests colocated.

**State:** 58 tests, typecheck/lint/build clean. Verified live: bad Origin → 403, `/health` → 200
unauthenticated, incomplete config → exit 78 listing every problem.

**Carried forward — blocks everything in Phase A:** `start-http.ts` creates **one**
`StreamableHTTPServerTransport` and reuses it for all requests. A transport instance holds a
single `sessionId`, so a second concurrent client collides with the first. Auth cannot be
meaningfully tested on a transport that cannot hold two clients.

---

## Stage A1 — Transport correctness and the test harness ✅ done

**Goal:** a server that can hold several clients at once, and a way to stand up a real identity
provider beside it.

**The container landed 2026-09-12**, in `docker/` (`Dockerfile`, `compose.yaml`, `healthcheck.mjs`)
with the build context at the repository root. Three stages — build, production dependencies, distroless
runtime — ~240 MB, uid 65532, no shell. Verified on **two hosts**: Docker Desktop on macOS
(arm64, 245 MB) and Ubuntu 26.04 with Docker 29.1.3 on x86_64 (238 MB), the latter on the same LAN
as the tenant VM it talks to. On both the image speaks MCP over stdio (initialize, tools/list, a
live `list_records` returning incident 10244 of 545), serves HTTP with Docker reporting the
container **healthy** through its own Node health check, and keeps running under
`--read-only --cap-drop ALL --security-opt no-new-privileges`. Four things the build taught us are
in `docs/notes.md`: pnpm's symlinks do not survive a stage copy, a distroless image cannot take a
shell-form HEALTHCHECK, a hostname that resolves on the host may resolve differently inside a
container, and `-e VAR=` means empty rather than absent.

**Built (2026-09-10):**
- Session routing — a transport **and its own `McpServer`** per session, in a bounded map keyed
  by `Mcp-Session-Id`, created on `initialize` and wired through `onsessioninitialized` /
  `onsessionclosed`. Unknown session → 404; POST with no session that is not `initialize` → 400.
- Eviction: `DELETE` closes a session; `MCP_SESSION_IDLE_TTL_SECONDS` (default 1800) sweeps the
  ones that vanish without it, because `onsessionclosed` fires only on an explicit delete.
- `MCP_MAX_SESSIONS` (default 100), refusing further `initialize` with 503.
- Graceful shutdown on `SIGTERM`/`SIGINT`: in-flight requests finish and live sessions close.
- Body read once with a 4MB cap, since routing depends on whether a POST is `initialize`.

Verified live: three concurrent sessions, independent tool calls, DELETE reducing the count, and
`claude mcp list` reporting ✔ Connected — it previously failed with
`Invalid Request: Server already initialized`.

**Still to ship**
- **Single-stage `Dockerfile` on `gcr.io/distroless/nodejs22-debian12`, running as `nonroot`.**
  The image does **not** build — CI (or the developer) runs `pnpm build` first and the image
  only copies the result. Faster images, a trivial Dockerfile, and no toolchain in the build
  context.

  ```dockerfile
  FROM gcr.io/distroless/nodejs22-debian12
  WORKDIR /app
  ARG VERSION
  LABEL org.opencontainers.image.version=$VERSION
  COPY deploy/node_modules ./node_modules
  COPY dist ./dist
  COPY package.json ./
  USER nonroot
  CMD ["dist/index.js"]
  ```

  **The catch: pnpm's `node_modules` is a symlink farm and cannot simply be copied.** Produce a
  self-contained tree first — `pnpm deploy --prod deploy` (or `pnpm install --prod
  --node-linker=hoisted`) — and copy *that*. Copying the working `node_modules` yields an image
  whose imports resolve to dangling links.

  **And build the artifact on the target platform.** Production dependencies are pure JS today
  (`@modelcontextprotocol/sdk`, `jose`, `zod`), so a macOS-built tree happens to run on
  linux/amd64 — but that stops being true the day a native dependency appears. CI should build
  on linux, or the release script should.
- **Version synced from `package.json`, one source of truth.** The server already reads its own
  name and version from the manifest at startup, so the image must:
  - `COPY package.json` alongside `dist/` — without it the server refuses to start, by design,
    since reporting a wrong version is worse than failing loudly;
  - take the tag and OCI labels from the same value:
    `docker build --build-arg VERSION=$(node -p "require('./package.json').version")`, then
    `LABEL org.opencontainers.image.version=$VERSION` and tag `ivanti-mcp:$VERSION`.
- `--health` subcommand, since distroless has no shell for `HEALTHCHECK`.
- `compose.yaml` bringing up the server **next to Zitadel** (already running locally), seeded
  with a project, an app and a couple of users. This is the local harness for Phase A.
  **Microsoft Entra ID is the second target** and cannot be containerised — it is configured
  once as a real tenant app registration and driven by the same test suite.

**Exit criteria**
- Two concurrent HTTP clients hold independent sessions and do not interfere.
- A killed client's session is gone after the TTL; RSS returns to baseline.
- `docker compose up` yields a reachable MCP server and a reachable Zitadel.
- The image runs as uid 65532 and reads a secret from `/run/secrets/...` via `*_FILE`.
- `get_version`, the image tag, and `org.opencontainers.image.version` all report the same
  string, and bumping `package.json` changes all three.

**Why Docker is here rather than at the end:** the OAuth work needs an issuer to point at, and
distroless surprises — missing CA bundle, no shell, uid 65532 file permissions — are far cheaper
to find now than in the middle of debugging token validation. A missing CA bundle presents *as*
an auth failure.

---

## Stage A2 — The identity seam ✅ done

**Goal:** one request-scoped representation of "who is this call for", before there are two
sources feeding it.

**Ships**
- `CallerIdentity` — a request-scoped value threaded into handlers as an explicit argument,
  never read from a global or from `process.env`.
- Three provenances, distinguishable at the type level: `anonymous`, `asserted`, `verified`.
- `get_version` extended to report the caller's provenance (not their identity) so the harness
  can see which path executed.
- The audit-log skeleton: every call records tool, session, and identity provenance.

**Built 2026-09-12, last of Phase A** — after A3 and B1-B4 rather than before them, which cost
more than doing it in order would have: twenty tools already existed and every one of their
handler signatures changed.

- `CallerIdentity` with the three provenances, in `src/auth/identity.ts`.
- Threaded as a handler's second argument. `registerTools` binds one `CallContext` per session;
  the tool *config* stays shared, so the schemas still exist once however many sessions are open.
- The three rules from design §5, in `identity-pin.ts`: a verified session ignores claims, a
  tokenless session pins the first claim, a later different claim is refused. Plus a rule the plan
  did not anticipate — an HTTP session belongs to the subject that opened it, and another verified
  subject presenting its own valid token gets **403**.
- `get_version` reports the provenance and never the person.
- The audit skeleton: `tool called` with tool, session and provenance on every call, arguments
  never, and an asserted subject never written as though it were a fact.

Verified live over both transports: stdio reports `caller: anonymous` and logs
`{"message":"tool called","tool":"get_version","identity":"anonymous"}`; the HTTP path adds the
session id, which is read at call time because it does not exist until `initialize` completes.

**Still deliberately stubbed:** resolving an asserted name to an Ivanti Employee record, and using
it to scope reads. That is B7, and it is now unblocked.

**Deliberately stubbed:** resolving an identity to an Ivanti Employee record. That join needs
Ivanti and lands in Phase B. What matters now is that the seam exists, because it touches every
handler and is the one thing that is expensive to add later.

**Exit criteria**
- A handler cannot obtain identity except through its argument — enforced by lint or review.
- `get_version` reports `anonymous` under `none`, and the harness can tell the paths apart.

---

## Stage A3 — OAuth resource server ✅ done *(Entra live token check blocked, see A4)*

**Goal:** `AUTH_MODE=oauth` works against **both Zitadel and Microsoft Entra ID**.

> **Checked against both IdPs (2026-09-10), and it contradicts a naive reading of the spec.**
> The spec has clients send `resource=<canonical MCP URI>` (RFC 8707) and servers validate the
> token was issued for them. But neither IdP mints `aud` from that parameter:
>
> - **Zitadel** puts audience in via a scope — `urn:zitadel:iam:org:project:id:{projectId}:aud` —
>   and the resulting `aud` is a **numeric project/client ID**, not a URL.
> - **Entra** uses `scope=api://{appIdUri}/.default`; `aud` is the **App ID URI** or the client
>   GUID.
>
> The spec anticipates this — clients *"**MUST** send this parameter regardless of whether
> authorization servers support it"* — but it means **the expected audience is not
> `MCP_PUBLIC_URL`** in practice. This is not a Zitadel quirk: no mainstream IdP mints `aud`
> from the `resource` parameter, Keycloak included.

**Built (2026-09-10), all unit-tested:**
- RFC 9728 Protected Resource Metadata served at **both** well-known paths — the path-inserted
  form and the root fallback — plus the `WWW-Authenticate: Bearer resource_metadata="…"`
  challenge on 401. `offline_access` is stripped from `scopes_supported`.
- Authorization-server metadata discovery following the spec's probe order, including the
  path-appending fallback Entra needs, and rejecting any document whose `issuer` disagrees with
  `OAUTH_ISSUER`. Runs once at startup, so a wrong issuer fails at boot.
- The JWKS verifier, `OAUTH_*` configuration, and the 401/403 mapping.

> **Correction to this plan: `express` turned out not to be needed.** The SDK's
> `mcpAuthMetadataRouter` is express-based, but the metadata document is a small static JSON
> object and the challenge is one header — both are a few lines on `node:http`. So express is
> still not a declared dependency, and the server remains framework-free.

**Verified end to end against Zitadel (2026-09-10)** over a public HTTPS hostname: discovery,
issuer match, JWKS, audience membership, three concurrent sessions, and a subject extracted from a
verified token. Entra's live token check is the one thing left, and it is blocked by a deployment
prerequisite rather than by code — see A4.

**Originally listed as still to do, now done:**
- `OAUTH_AUDIENCE` as **its own setting**, defaulting to `MCP_PUBLIC_URL` but independently
  configurable — `api://…` for Entra, a project ID for Zitadel. Validation is **membership in
  the `aud` claim**, which both IdPs may emit as an array, not string equality.
- `OAUTH_ISSUER` validated exactly. Entra differs by token version: v1 issues
  `https://sts.windows.net/{tid}/`, v2 `https://login.microsoftonline.com/{tid}/v2.0`. Pin
  `requestedAccessTokenVersion: 2` in the app registration so this is not ambiguous.
- **One verifier: JWT over JWKS.** Fetch and cache the key set, refetch on an unknown `kid`
  (Entra rotates signing keys), tolerate clock skew. Both target IdPs issue JWTs — Entra
  always, and the Zitadel app is already configured for JWT access tokens.

  *Deferred, with measurements behind it (design §9c, §10):* RFC 7662 introspection is absent on
  4 of 10 surveyed providers **including Entra**, so it can never be the universal path. `jwks_uri`
  is present on 10 of 10. Introspection stays a future addition — the `TokenVerifier` type makes
  it purely additive, and `looksLikeJwt()` already exists to route to it.
- Status codes: 401 invalid or expired, 403 insufficient scope with `error="insufficient_scope"`,
  400 malformed. `scope` included in the challenge.
- Token claims populate `CallerIdentity` as `verified`.

**Not built, deliberately:** `mcpAuthRouter`, `proxyProvider`, `/register`, client ID metadata
documents. This server never mints tokens, and client registration is strictly between the client
and the authorization server (design §11).

**Exit criteria**
- A client discovers the authorization server from a 401 alone, with no configuration.
- A token issued for a **different audience** is rejected — the test that most often passes by
  accident, because a server that ignores `aud` entirely looks perfectly healthy.
- An expired token yields 401; a valid token with a missing scope yields 403.
- Key rotation at the IdP is picked up without restarting the server.
- **The same server binary works against Zitadel and Entra with only configuration changing.**
  If either needs a code path of its own, the abstraction is wrong.

---

## Stage A4 — Prove the matrix 🟡 four of five rows proven

**Goal:** every access mode exercised deliberately, against the same one tool. This is the
"check it" stage — its output is evidence, not features.

**The matrix.** Transport × door × surface (design §1). `stdio` has exactly one door, so the
combinations are 1 + 3 transports-and-doors, each against two surfaces:

| Transport | Door | `full` | `enduser` | Proven |
|---|---|---|---|---|
| `stdio` | n/a — process trust | ✓ | ✓ | **yes** — locally and from the container image |
| `http` | `none` | loopback default; `MCP_BIND` is the second explicit key | ✓ | **yes** — dev runs throughout B1-B4 |
| `http` | `bearer` | constant-time compare, 401 on mismatch | ✓ | **yes** — the sandbox deployment, 401 without and with a wrong token |
| `http` | `oauth` | verified identity, audience-bound | ✓ | **Zitadel yes**, Entra blocked below |

`enduser` was exercised live on 2026-09-11 with `ENDUSER_BUSINESS_OBJECTS=Incident,Change,ServiceReq`:
the catalog answers three objects, and `Employees`, `frs_hc_calllog` and `fetch('employees:…')`
are each refused with the list of what is allowed.

### Entra: verified as far as is possible without a customer tenant (2026-09-11)

Tested against a live tenant (`23afecaf-…`). **Proven:**

- **Discovery works**, and only via the *third* probe — both path-insertion forms 404, so the
  spec's full fallback chain is load-bearing rather than compliance decoration.
- **Issuer exact-match and JWKS retrieval work** against the live tenant (6 keys).
- **The PKCE-metadata worry was unfounded.** Entra advertises no
  `code_challenge_methods_supported`, and the spec says a client MUST then refuse — but Claude
  Code proceeded and issued a real authorization request. This was the single largest open risk
  in the plan and it is now closed.

**Deferred:** final token verification, blocked by a deployment constraint rather than by code.

Two requirements meet and leave no room locally:

- the **client** validates that the RFC 9728 `resource` equals the endpoint it connected to
  (*"Protected resource … does not match expected …"*);
- **Entra** requires `resource` to be a registered Application ID URI, and permits only
  `api://<appId>` or HTTPS on a **tenant-verified domain**.

So the server's own URL must *be* the Application ID URI — which means **an Entra deployment
needs a public HTTPS hostname on a domain verified in that tenant**. That is the finding worth
carrying forward; it is a deployment prerequisite, not a configuration option.

Our homelab domain could not satisfy it: DNS was provably correct (both authoritative
nameservers and four public resolvers returned the exact token Azure asked for), but the domain
is claimed by another Microsoft tenant, which is an admin-takeover process rather than a config
change. A real customer deploys into their own tenant with their own already-verified domain,
where the configuration is the short version — App ID URI, `MCP_PUBLIC_URL`, `OAUTH_AUDIENCE`
and the endpoint are one identical string.

The remaining untested step is token verification, which is IdP-agnostic code already proven end
to end against Zitadel over a public HTTPS hostname.

**Revisit at the first real Entra deployment**, not before.

---

**Superseded — the original plan said:**
Entra is the majority IdP and the only one of ten surveyed that does not advertise
`code_challenge_methods_supported`, which the spec says makes a conformant client refuse to
proceed (design §12). It also supports neither DCR nor introspection. If a strict client will
not do OAuth against Entra, that reshapes the auth story for most deployments — and every other
item in Phase A is cheaper to redo than to build on the wrong assumption.

**Ships**
- An end-to-end suite driving a real client against the compose harness, not mocks — run twice,
  once per IdP. Entra runs against a real tenant, so its credentials come from `*_FILE` secrets
  and the suite skips with a clear message when they are absent, rather than failing.
- Negative tests as first-class: wrong audience, expired token, missing token, malformed header,
  wrong bearer of equal length, untrusted `Origin`, non-canonical `MCP_PUBLIC_URL`, unknown
  `AUTH_MODE`, `enduser` without an allowlist, `http` with no `AUTH_MODE`, `AUTH_MODE` set
  under `stdio`.
- Log redaction proven by test — no token, key or secret ever reaches a log line.
- `ALLOWED_CIDRS` as a stackable modifier, and per-session rate limiting.
- A README deployment matrix, including the point that a bearer token handed to a multi-user
  client grants that tool surface to everyone holding it.

**Exit criteria**
- All eight combinations start, serve `get_version`, and refuse what they should refuse.
- The negative suite is green, and each failure mode produces a message that names the cause.
- **Phase A is signed off here.** No Ivanti code exists yet, and auth does not get reopened.

---

# Phase B — Ivanti functionality

## Port, do not rebuild

`overlord-service` is a working Ivanti MCP server: **34 tools over ~18,300 lines**, verified
against live tenants. Its Ivanti layer encodes behaviour that exists in no specification and
cannot be derived from the API — it was read out of HAR captures and confirmed by experiment.

Rebuilding it means rediscovering every one of these, each of which is a **silent failure**:

- `$filter` has no functions. `contains()`, `startswith()`, `year()` are **silently dropped** and
  the server returns the **full unfiltered set** — not an error.
- `@odata.count` returns **0 alongside real rows** on some filtered queries, and tracks page size
  rather than a true total.
- An English-plural entity set (`Categories`) answers **empty rather than erroring** — but 400s
  the moment a `select` is added, which is the only way to tell a bad name from no rows.
- Service-request checkboxes store only the exact lowercase string `'true'`; `true`, `'True'`,
  `1` leave the field false **while echoing the sent value back**.
- Service-request datetimes need the **negated** tenant UTC offset; the positive value corrupts
  the field to year 0001.
- Quick actions answer `saved: true` over records that did not change; `UIAction` actions are
  client-side no-ops that answer OK.
- `PreDeleteObject` always answers `status: 'error'`, even for a clean preview.
- Attachment upload never links its parent, and succeeds against a parent that does not exist.
- `$select` on a single-record GET returns **200 with an empty body**.

**So: port `apis/`, `client/core/` and `client/providers/` (~9,256 lines) and restructure as we
go. Rewrite `tools/` (~5,300 lines)**, which is thinner and carries the multi-tenant assumption
we deliberately designed away.

## Five principles this phase is built on

**1. Never report success from a 200.** Ivanti's failure mode is answering OK and doing something
else. Writes are read back (`confirmValidatedWrite`, `verifySubmittedParameters`); reads that
degraded say so through provenance fields — `servedBy`, `filteredBy`, `answeredFor`. A tool that
cannot tell the model *how* it knows should not claim to know.

**2. Refuse unsupported queries before the wire.** A silently-dropped `$filter` function is worse
than an error, because the model believes the result. `assertSupportedFilter` rejects them
client-side.

**3. Capability narrowing happens at registration.** A credential that cannot serve a tool never
sees it in `tools/list` — the same mechanism `MCP_MODE` already uses. An absent capability beats
a runtime failure.

**4. Facts in the client, sentences in the tools.** The client diagnoses (`IvantiHint`, ten
variants, naming fields and values); only the tools layer names tools and parameters. Overlord
learned this the hard way — the text once lived in the transport, so renaming a tool meant
editing the HTTP layer, and a stale placeholder leaked into model output.

**5. Heavy reference lives in MCP resources, not instructions.** `instructions` is injected every
session and costs tokens every session. Overlord exposes four markdown resources
(`ivanti://reference/{entity-naming,field-names,picklists,write-recipes}`) that the model pulls
on demand. **We have no resources tier at all** — adding one is part of this phase.

---

## Stage B1 — Transport foundation ✅ done

**Goal:** every wire convention, with nothing Ivanti-semantic on top.

**Ships**
- `rest_api_key` transport. The header is `Authorization: rest_api_key=<key>` — **equals sign**.
- **Base-path probe.** `/HEAT` is usually present but not always; try both once at startup, keep
  whichever answers, log the result. Not a config field — someone will get it wrong.
- OData URL builders: entity set, record by key, `/$Ref` for relationship link/unlink.
- `assertSupportedFilter` — reject `$filter` functions and OData v2 typed literals before the
  request is made (principle 2).
- The error pipeline: typed `IvantiApiError` carrying status and a **scrubbed, size-capped** body.
- `isIvantiNotFound()` — **Ivanti has no 404.** Get-by-key answers `400 ISM_4000 "Invalid key"`,
  the same code as a bad field name, and `/rest/Attachment` answers 400 `"not found"`.

**Exit criteria:** a real record returns from a staging tenant; a wrong key fails at startup, not
at first tool call; an unsupported `$filter` is refused locally with an explanation.

**Landed as** `src/ivanti/` — `errors`, `odata-filter`, `odata-url`, `odata-response`,
`base-path`, `transport`, `connect` — plus `IVANTI_BASE_URL` / `IVANTI_API_KEY(_FILE)` and the
startup probe in `index.ts`. The tenant stays optional for now: without it the server runs with
the transport-level tools and warns.

**Verified against a live staging tenant (2026-09-11).** Base path `/HEAT` detected on the first
probe; a real incident returned 181 fields; a bogus key answered `400 ISM_4000 "Invalid key"` and
`isIvantiNotFound()` caught it; `contains()` returned three rows for a subject that exists nowhere
— **the silent-drop is real**, and `assertSupportedFilter` refuses it before the request. Three
further conventions were discovered in the process and are now guarded: the `Accept` trap on
`$metadata`, the `$metadata` graph ladder, and the three encodings of an empty collection
(`readCollection`). All are in `docs/notes.md`.

A follow-up audit against this list closed three gaps: the error body was size-capped but never
**scrubbed** (the API key is now redacted by `scrubErrorBody`, verified live); the probe blamed
`IVANTI_BASE_URL` for what a `401 ISM_4001` says is a credential problem; and the CSDL URL the
probe found was discovered and then dropped rather than carried on `IvantiConnection.metadataUrl`
for B2 to reuse.

---

## Stage B2 — Metadata, naming, and reads ✅ done *(no session required)*

**Goal:** a genuinely useful read-only server that works with **any** key role.

This is the milestone worth reaching first: 17 of the 34 tools need no ASMX session at all, so
this tier serves every customer regardless of what their API key can do.

**Ships**
- CSDL `$metadata` parsing and caching, with two guards: a **non-CSDL 200 must never be cached**
  (a WAF or HTML page cached as metadata makes every entity report "not found" for the process
  lifetime — validate the `<Edmx>` root), and **CSDL docs disagree with each other** — an entity
  can carry 113 fields and 0 relationships in a shared graph while its own document has 46, so
  probe the entity's own `$metadata` once when the shared graph came back relationship-less.
- **The three entity-naming dialects** and conversion between them:

  | Form | Example | Used by |
  |---|---|---|
  | AdminUI id | `Incident#`, `CI#Computer` | schema tools |
  | OData entity set | `Incidents`, `CI__Computers` | CRUD tools |
  | CSDL singular | `incident` (lowercase) | what metadata reports back |

  The rule is **not** English pluralisation: replace `#` with `__` (or drop a trailing `#`), then
  append a literal `s` — `IncidentStatus#` → `IncidentStatuss`, `Category#` → `Categorys`.
  Accept the `#` form everywhere and convert, as overlord does. **This settles
  `ENDUSER_BUSINESS_OBJECTS`:** accept either form, normalise on load, store one.
- Client-side projection (principle: `$select` cannot be trusted — empty body on single-record
  GET, and on saved searches it keeps every key and blanks the values, costing a round trip and
  saving nothing).
- Reads: `get_record`, `list_records`, `get_related_records`, `fulltext_search_object`,
  `count_records`, `search`/`fetch`, `list_assigned_work`, `get_object_metadata`,
  `get_service_request_parameters`, `get_service_request_parameter_options`,
  `get_attachment_details`.
- BO catalog from `$metadata` entity-type names — the **wider** of the two sources, since OData
  access is governed by Object Permissions rather than workspace membership.

**Exit criteria:** safe to point at production, because nothing can mutate. A realistic question
is answerable end to end. An English-plural entity name is reported as a naming error with
suggestions rather than as zero rows.

**Landed as** `src/ivanti/metadata/` (`csdl`, `catalog`, `entity-names`, `suggest-names`),
`src/ivanti/odata/` (`query`, `projection` beside the B1 modules),
`src/ivanti/service-request/parameter-shape`, and eleven read tools under `src/tools/` —
`list_business_objects`, `get_object_metadata`, `get_record`, `list_records`, `count_records`,
`get_related_records`, `fulltext_search_object`, `list_assigned_work`,
`get_service_request_parameters`, `get_service_request_parameter_options`,
`get_attachment_details`, plus the retrievable pair `search` / `fetch`. `ENDUSER_BUSINESS_OBJECTS`
now normalises every dialect on load.

**Verified against the live staging tenant (2026-09-11).** All three naming dialects resolve to
one entity; `Categories` answers *"Did you mean: categorys?"*; a mistyped field answers *"incident
has no field named 'Description'"* instead of Ivanti's "No such entry exists";
`list_assigned_work('JSmith')` returns 8 incidents, 1 task and 13 changes with the exclusion filter
echoed; `search('printer')` returns 14 hits across three objects in 218 ms and `fetch` reads one
back; a service-request template returns 7 parameters with `required` decoded, and its Department
parameter 24 options.

**Found in the process** (all in `docs/notes.md`): Ivanti fabricates a field-less entity type for
an unknown entity set, only a graph's root carries relationships, `$top` caps at 100,
`@odata.count` arrives unasked and can contradict its rows, `$search` works where `$expand` is
silently ignored, the validation-list endpoint is a POST, and `/rest/Attachment` streams the file
rather than describing it.

**Not in this stage:** the resources tier (`ivanti://reference/…`), saved searches, quick actions
and pick-list tools — they need either the session or their own design pass.

**Three issues found in a later audit and closed (2026-09-11):**
- **Unbounded row payloads.** `list_records` with no field list returned 187,278 characters for
  its default page. Rows now default to a compact field set, with `fields: "*"` for whole records
  and the response saying which was used — 9,496 characters for the same call.
- **`ENDUSER_BUSINESS_OBJECTS` was documented as validated at startup and was not.** It is now
  resolved against the tenant, and an unknown name exits 78 with suggestions rather than silently
  narrowing what an end user may create on.
- **"Did you mean" only saw the metadata graphs.** With an admin-tier credential it now draws on
  the full 1324-object catalog: `OnboardingReq` answers *"Did you mean: onboardingrequest?"*,
  which no graph fetched so far contained.

---

## Stage B3 — Session bootstrap and the capability profile ✅ done

**Goal:** unlock the ASMX-backed half where the credential allows, and degrade cleanly where it
does not.

**Ships**
- The handshake: `AuthenticateTenantAPIKey` → SID, `InitializeSession` → CSRF,
  `GetUserData` → **effective** role and display name. The `role` argument is a *request* that
  silently downgrades, so step three is not optional; its failure is non-fatal.
- All three CSRF conventions: `.asmx` wants `_csrfToken` in the body; `.ashx` handlers want
  lowercase `_csrftoken` as a **header** with a form-urlencoded body and reply with a JavaScript
  object literal; multipart uploads want `_csrfToken` as a header. One shared 401-clear-and-retry
  lifecycle, one shared handshake promise.
- **Never `/HEAT/AdminUI/`** — admin-console services an analyst key is refused. Carry over
  overlord's guard test that drives every descended tool over a stubbed fetch and asserts no URL
  contains that path.
- **The capability profile** drives registration:

  | Tier | Credential | Tools |
  |---|---|---|
  | `odata` | `rest_api_key` only | 17 fully, 8 degraded |
  | `session` | + handshake succeeds | all |

  Always-session tools: the three quick actions, `list_business_objects`,
  `get_pick_list_values`, `get_pick_list_constraints`, `get_link_fields`, `list_saved_searches`,
  `preview_delete`, `submit_service_request`.
- **Surface the effective identity in `instructions`.** Anything Ivanti resolves "for the current
  user" — a saved search called "My …", an approval vote — answers for the **service account**.
  Told this, the model stops reporting one person's items as another's.
- The richer BO catalog via `GetRoleWorkspaces`, merged with the metadata-derived list.

**Exit criteria:** an analyst-role key starts, logs its tier, and serves the `odata` tool set with
no failures. An admin key serves everything. Neither path requires configuration.

**Landed as** `src/ivanti/session/` — `asmx-session` (handshake, shared promise, 401-retry),
`capability` (a three-tier probe at startup), `workspaces` (the role's own objects) and
`admin-catalog` (the complete catalog when the console answers) — plus
`src/server/instructions.ts` and `src/tools/admin-ui-guard.test.ts`, which drives every registered
tool over a tenant whose admin console refuses and asserts that nothing fails and nothing requests
that path.

**The tier table changed after measuring.** The plan above said "never `/HEAT/AdminUI/`". That is
wrong: an admin key reaches it, and it is the only source for the tenant's whole catalog — 1324
objects against 194 from metadata. The rule is therefore *used when available, never required*,
which is what the original instruction asked for. The path needs the `services/` segment.

| Tier | Credential | Catalog |
|---|---|---|
| `odata` | API key only | ~194 names from metadata graphs |
| `session` | handshake opens | + the role's 24 workspace objects, with display names |
| `admin` | console answers | 1324 objects with display names and descriptions |

**Verified against the live staging tenant (2026-09-11).** Startup — base-path probe, handshake
and the full admin catalog — takes **131 ms** and reports `tier: admin`, role `Admin`, identity
*Tyrunas Jokubauskas*. `list_business_objects` answers with the 24 objects people work in (4.7 KB)
and reaches all 1324 on a search; no log line contains the API key. Handshake timings measured
separately with curl: 18-68 ms per call.

**`list_business_objects` was rebuilt around this.** Without a search it returns only what people
work in — the role's workspaces plus Ivanti's own `commonlyUsed` flag — because 1324 rows is not
an answer. A search reaches the whole catalog, matching display names as well as technical ones.
Validation lists (354 of them) and audit tables are excluded unless asked for, and the response
names its source so the model knows how complete "not found" is.

**Object gating for `enduser` mode landed early** (it belongs to B7, but was needed now): the
allowlist is read from the environment and enforced by `createObjectGate` at every tool that names
an object. Verified live with `ENDUSER_BUSINESS_OBJECTS=Incident,Change,ServiceReq` — the catalog
answers three objects, assigned work reports incidents/servicereqs/changes only, and
`Employees`, `frs_hc_calllog` and `fetch('employees:…')` are all refused with the list of what is
allowed. What B7 still owes: "edit only own records", which needs the customer-scoping design.

**The three open items were investigated and two are closed (2026-09-11):**

- **The `.ashx` convention is in.** The handler path was wrong, not missing:
  `/HEAT/handlers/GridDataHandler/GridDataHandler.ashx`, a folder per handler, found by reading the
  app's own `Default.aspx`. `session.callHandler()` implements it — form-urlencoded body, lowercase
  `_csrftoken` header — and the tenant confirms the mechanics: 551 without the header, 200 with it.
  Only the per-handler payload is unknown, which belongs to whichever stage calls one. The
  multipart convention still waits for its first caller (attachment upload, B6).
- **The tier now narrows something real.** `get_pick_list_values` is the first session-only tool:
  the allowed values of a validated field live on a create form, which OData cannot see. It walks
  workspace → layout → view → form, caches the walk per object, and decodes the column-shaped
  reply. Verified live: Incident Status 7 values, Priority 5, Impact 3, Source 13, Category 5;
  a second call costs 26 ms.
- **The degraded paths are now testable.** `IVANTI_MAX_TIER=odata|session|admin` caps the server
  below what the credential can do. It exists because `AuthenticateTenantAPIKey`'s `role` argument
  is *ignored* — an admin account asked for `SelfService` still answers `Admin` — so nothing else
  can show what a customer without admin rights gets. Verified live: `admin`/`session` serve 15
  tools, `odata` serves 14 and drops `get_pick_list_values`.

---

## Stage B4 — Writes, and the hint system ✅ done

**Ships**
- `create_record`, `update_record`, `delete_record`, `link_records`, `unlink_records`.
- **Link triplets**: a "Customer" is not a column — it is `ProfileLink_RecID` +
  `ProfileLink_Category` naming a target BO. Creating a child under a parent is
  `ParentLink_RecID` + `ParentLink_Category` **inline in the create**, which wires the
  relationship in one call; `link_records` is only for records that already exist.
- The form chain and picklists landed early in B3 (`form-context`, `pick-lists`,
  `get_pick_list_values`) — the write path resolves values against the same lists rather than
  building its own.
- **Validated-field writes**: omitting is not skipping — Ivanti auto-fills an omitted validated
  field and then rejects its own value. Resolve the value against the live cascade-filtered
  option list, attach the identifier, and **read the record back to confirm it stored**. On
  update, merge the record's stored cascade parents first: a `Category` patch alone evaluates
  against an empty `Service` parent.
- The **ten-variant `IvantiHint`** taxonomy and its renderer, split per principle 4.
- Verify-after-write throughout (principle 1).

**Exit criteria:** a ticket can be created, updated, linked and deleted end to end; a write that
did not store is reported as a failure, not a success; a rejected value lists what was allowed.

**Landed as** `src/ivanti/write/validated-write.ts` (resolve → write → confirm),
`src/tools/shared/explain-required-fields.ts`, and five tools: `create_record`, `update_record`,
`delete_record`, `link_records`, `unlink_records`. In `enduser` mode only `create_record` is
registered — editing and deleting wait for B7 to define "own records".

**Verified live against the staging tenant (2026-09-11), every record cleaned up afterwards:**

| Step | Result |
|---|---|
| `create_record` with a link triplet | incident **#11168** / **#11179**, `ProfileLink_RecID` stored |
| create missing required fields | named `Category`, `Symptom` (from *Description*) and the `ProfileLink_RecID` + `_Category` pair |
| `update_record` Status → Active | refused: *"it requires `Category`; `Owner`"* — the conditional rule |
| the same with those fields | stored `Active` + `Status_Valid` + Category + Owner, confirmed by read-back |
| an invalid picklist value | refused with the seven allowed values, nothing written |
| `unlink_records` when not linked | refused, with why it matters |
| `link_records` → `get_related_records` | 1 row (`SQL-Cluster-12`); after `unlink_records`, 0 |
| `delete_record`, then again | deleted; the second answers *"nothing was deleted"* |

**Three things the tenant corrected:**
- Required-field messages name **display names**, and `Customer` is a link, not a field. Both are
  translated through the form.
- Required rules are **conditional** — `Logged` needs nothing, `Active` needs Category and Owner.
- **The form, not `$metadata`, is the authority on what is validated.** Task's CSDL reports zero
  validated fields while its form declares twenty; gating on CSDL sent a value out unresolved and
  Ivanti answered 500. The gate is gone; the form chain is cached per object instead.

**The one apparent limitation turned out to be a naming mistake, and is fixed.** `Tasks` is a
**base type**: Ivanti refuses to create it (500, empty message) and creates its subtypes happily —
`POST /task__assignments` with only a Subject works. `get_object_metadata` now reports `subtypes`
for a base type, and a failed create names them. Detecting them needs the widest catalog the
credential has, since no default metadata graph contains `task__assignment`.

---

## Stage B5 — Workflow surface ⬜ not started

`list_quick_actions`, `preview_quick_action`, `run_quick_action`, `preview_delete`,
`get_pick_list_values`, `get_pick_list_constraints`, `get_link_fields`, `list_saved_searches`,
`saved_search`, `group_count`.

The quirks here are the sharpest in the codebase: preview must always probe fresh because the
commit echoes a token from that probe; probing over the *grid* path ignores `shouldSave:false` and
actually **runs** the action, so only the form path is safe; `UIAction` actions change nothing
while answering OK and are refused client-side rather than reported as success.

`run_quick_action` is the one tool carrying `DESTRUCTIVE_NON_IDEMPOTENT` — it repeats its side
effects on retry.

---

## Stage B6 — Service requests and attachments 🟡 the reads landed in B2

**Already built (in B2):** `get_service_request_parameters`, `get_service_request_parameter_options`
and `get_attachment_details` — all read-only and session-free. **Missing:**
`submit_service_request`, `list_request_offerings`, and every attachment write
(`upload_attachment`, `request_attachment_upload`, `check_attachment_upload`, `delete_attachment`),
which is also where the multipart CSRF convention finally gets a caller.

The quirkiest area, and the one with the most one-way doors.

Attachments must be **staged before the request exists**, and only the ASMX submit binds them —
REST accepts an `attachments` field and silently drops it. A staging token is **one-shot**: a
second submit would *move* the file off the first request rather than copy it. Submission success
says nothing about whether parameters stored, so the request is read back.

---

## Stage B7 — `enduser` mode and the resources tier 🟡 the gate is in

- ✅ `ENDUSER_BUSINESS_OBJECTS` enforced — not in `selectTools()` as planned but in
  `createObjectGate`, which every object-taking tool passes through, because narrowing the tool
  *list* would still have let `list_records` name any object. Validated at startup against the
  tenant (exit 78 with suggestions), keyed on the technical name in either dialect.
- ✅ Writes narrowed: in `enduser` mode only `create_record` is registered; update, delete, link
  and unlink wait for the line below, because without it anyone could change anyone's ticket.
- ⬜ **`Customer` resolution and the session identity pin** — the actual "own records" rule. It
  needs A2's identity seam, which is not built, so this is the one place where skipping A2 has a
  visible cost.
- ⬜ **The resources tier**: port the four reference documents as MCP resources rather than growing
  `instructions`. They cost nothing until the model asks.

Note for this stage: approval voting is a **quick action**, not a field update, and "My Vote"
records the *service account's* decision — so a pending-approval list must never be presented as
the caller's own.

---

## Tool inventory (34 in overlord; we drop `list_tenants`)

| Group | Tools | Session needed |
|---|---|---|
| business-object | list/get/create/update/delete_record, count_records, group_count, list_assigned_work, get_object_metadata, list_business_objects, get_pick_list_values, get_pick_list_constraints, get_link_fields, preview_delete | 6 always, 5 conditional |
| attachment | get_attachment_details, upload_attachment, delete_attachment, request_attachment_upload, check_attachment_upload | 1 conditional |
| quick-action | list/preview/run_quick_action | all |
| relationship | get_related_records, link_records, unlink_records | none |
| retrievable | search, fetch | none |
| search | fulltext_search_object, list_saved_searches, saved_search | 1 always, 1 conditional |
| service-request | list_request_offerings, get_service_request_parameters, get_service_request_parameter_options, submit_service_request | 1 always, 1 conditional |

---

## Ordering rationale

**Why all of auth first:** it is cross-cutting and expensive to retrofit, and it is the only part
where a mistake is a security problem rather than a bug. Proving it with one trivial tool keeps
Ivanti behaviour out of the failure analysis entirely.

**Why the identity seam (A2) before OAuth (A3):** the seam touches every handler. Adding it after
two identity sources already exist means changing both.

**Why reads before the session (B2 before B3):** B2 needs only `rest_api_key`, so it works for
**every** customer regardless of what their key can do — 17 of 34 tools with no ASMX at all. It
can be pointed at production safely, which gets real feedback on naming, projection and paging
before anything can mutate. Reaching a useful server without depending on role is the milestone.

**Why the session before writes (B3 before B4):** validated-field writes need the cascade-filtered
option list, which is an ASMX call. Attempting writes first means either skipping validated
fields — most of the interesting ones — or discovering the dependency mid-stage.

**Why `enduser` last (B7):** it is `full` minus tools plus identity, a narrowing of something that
already works. It also depends on the BO catalog for allowlist validation, and on the session
identity that B3 establishes.

## Standing risks

| Risk | Stage | Mitigation |
|---|---|---|
| ~~Ivanti REST auth header format is a guess~~ | — | **Resolved:** `Authorization: rest_api_key=<key>`, equals sign, confirmed by a test in `overlord-service` |
| Ivanti answers 200 and does something else — silently dropped `$filter` functions, untrustworthy `@odata.count`, `saved:true` over unchanged records | B1–B6 | Principle 1: never report success from a 200. Verify after write, refuse unsupported queries locally, carry provenance on degraded reads |
| A customer's key lacks the role for the ASMX session | B3 | Capability tiers: 17 tools need no session; narrowing happens at registration so a tool that cannot work is never offered |
| Port diverges from `overlord-service` and the two drift | B1 | Decide early whether the Ivanti layer becomes a shared package or an intentional fork — see the open question below |
| SDK protocol version lags the spec (1.30.0 → `2025-11-25`) | A3 | Re-check `LATEST_PROTOCOL_VERSION` before assuming a 2026-07-28 requirement is buildable |
| Real IdPs do not mint `aud` from the `resource` parameter | A3 | `OAUTH_AUDIENCE` configured separately; membership test, not equality |
| **Entra does not advertise `code_challenge_methods_supported`; the spec says clients MUST refuse** | **A4, first** | Verify against a real tenant before building further on OAuth |
| DCR is unsupported by half of surveyed IdPs | A4 | Pre-registration (`--client-id`) is the documented default, not a workaround |
| Entra token v1/v2 changes the issuer string | A3 | Pin `requestedAccessTokenVersion: 2`; validate `iss` exactly |
| Distroless missing CA bundle presents as an auth failure | A1 | Found early, while the surface is one tool |
| TypeScript pinned to 6.x by typescript-eslint | any | Revisit when typescript-eslint supports TS 7 |
| Asserted identity is impersonable | B4 | Accepted; pinning bounds it, OAuth removes it |

---

## Fork, not shared package — decided 2026-09-11

The Ivanti layer is **forked**, not extracted into a package both services consume. The reason is
that this server is expected to **evolve independently**: different audiences, a different
deployment story, and a tool philosophy that has already diverged (one tenant per instance, no
`tenant` parameter, capability tiers).

A shared package would make every such divergence a negotiation with `overlord-service`, and the
coupling would bite hardest exactly where we most want to move — the tool surface.

### What forking costs, and what we do about it

**Ivanti discoveries now have to travel manually.** A quirk found in either codebase is a quirk in
both — Ivanti does not care which of our servers is talking to it. Left alone, the two drift and
the same day gets spent twice.

So, three cheap habits rather than a process:

**1. Record the fork point.** Ported code is taken from `synergy-platform` at:

```
repo   synergy-platform
commit 952ad0c   (2026-09-01, last change to services/overlord-service/src/mcp/servers/ivanti)
```

Noting it makes a later `git log 952ad0c..HEAD -- .../ivanti` a real answer to "what has upstream
learned since we forked", rather than a manual re-read of 18,000 lines.

**2. Keep a provenance comment on ported files.** A one-line header naming the origin path means
the next person can diff a single file instead of hunting for its counterpart.

**3. Offer discoveries back.** Anything we learn about Ivanti's behaviour — a new silent failure,
a corrected recipe — is worth a message to whoever owns overlord. One-way by choice beats one-way
by neglect.

### Where we intend to diverge

Stated now, so drift is deliberate rather than accidental:

- **No `tenant` parameter** on any tool — one tenant per instance removes it from all 33 schemas.
- **Capability tiers** narrow the tool surface at registration; overlord assumes a capable key.
- **Two audiences** (`full` / `enduser`), which overlord does not have.
- **Our own auth layer** — overlord sits behind the platform's; this server is its own OAuth
  resource server.

Everything else — transport conventions, the hint taxonomy, the metadata catalog, the write
recipes — should stay recognisably the same, because any difference there would be accidental
rather than chosen.
