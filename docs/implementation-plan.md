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

## Stage A1 — Transport correctness and the test harness 🟡 session routing done

**Goal:** a server that can hold several clients at once, and a way to stand up a real identity
provider beside it.

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

## Stage A2 — The identity seam

**Goal:** one request-scoped representation of "who is this call for", before there are two
sources feeding it.

**Ships**
- `CallerIdentity` — a request-scoped value threaded into handlers as an explicit argument,
  never read from a global or from `process.env`.
- Three provenances, distinguishable at the type level: `anonymous`, `asserted`, `verified`.
- `get_version` extended to report the caller's provenance (not their identity) so the harness
  can see which path executed.
- The audit-log skeleton: every call records tool, session, and identity provenance.

**Deliberately stubbed:** resolving an identity to an Ivanti Employee record. That join needs
Ivanti and lands in Phase B. What matters now is that the seam exists, because it touches every
handler and is the one thing that is expensive to add later.

**Exit criteria**
- A handler cannot obtain identity except through its argument — enforced by lint or review.
- `get_version` reports `anonymous` under `none`, and the harness can tell the paths apart.

---

## Stage A3 — OAuth resource server 🟡 mostly built

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

**Still to do:** live verification against Zitadel and Entra, which needs the A1 harness.
- `OAUTH_AUDIENCE` as **its own setting**, defaulting to `MCP_PUBLIC_URL` but independently
  configurable — `api://…` for Entra, a project ID for Zitadel. Validation is **membership in
  the `aud` claim**, which both IdPs may emit as an array, not string equality.
- `OAUTH_ISSUER` validated exactly. Entra differs by token version: v1 issues
  `https://sts.windows.net/{tid}/`, v2 `https://login.microsoftonline.com/{tid}/v2.0`. Pin
  `requestedAccessTokenVersion: 2` in the app registration so this is not ambiguous.
- **One verifier: JWT over JWKS.** Fetch and cache the key set, refetch on an unknown `kid`
  (Entra rotates signing keys), tolerate clock skew. Both target IdPs issue JWTs — Entra
  always, and the Zitadel app is already configured for JWT access tokens.

  *Out of scope, deliberately:* RFC 7662 introspection. It would only be needed for an IdP
  issuing **opaque** tokens (Zitadel's default, were the app not configured otherwise). Add it
  if such an IdP ever appears; building it now buys nothing and doubles the verifier surface.
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

## Stage A4 — Prove the matrix

**Goal:** every access mode exercised deliberately, against the same one tool. This is the
"check it" stage — its output is evidence, not features.

**The matrix.** Transport × door × surface (design §1). `stdio` has exactly one door, so the
combinations are 1 + 3 transports-and-doors, each against two surfaces:

| Transport | Door | `full` | `enduser` |
|---|---|---|---|
| `stdio` | n/a — process trust | ✓ | ✓ |
| `http` | `none` | loopback default; `MCP_BIND` is the second explicit key | ✓ |
| `http` | `bearer` | constant-time compare, 401 on mismatch | ✓ |
| `http` | `oauth` | verified identity, audience-bound | ✓ |

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

## Stage B1 — Ivanti client and the first real read

**Goal:** prove the Ivanti REST assumptions with the smallest possible surface. Highest
uncertainty in Phase B; everything after depends on being right here.

**Ships:** `ivanti/ivanti-client.ts` (injectable `fetch`, timeouts, one retry on connection
errors only, typed error mapping), `ivanti/errors.ts` (failures translated into tool results a
model can act on), `list_business_objects`, `get_object_metadata`, `get_record`, and a startup
reachability check so a wrong credential fails at boot rather than mid-conversation.

**Open before starting:** the exact Ivanti REST authentication header format. The current
placeholder is a guess and is commented as such.

**Exit criteria:** a real record returns from a staging tenant; a wrong key fails at startup;
the technical names from `list_business_objects` are confirmed to be what the API accepts.

---

## Stage B2 — Read breadth

`list_records`, `search`, `fulltext_search_object`, `count_records`, `group_count`,
`get_related_records`, `get_link_fields`, pick lists, saved searches, `list_assigned_work`.

Two cross-cutting concerns appear only at breadth and are settled once, here:
- **Pagination** — one convention across every list tool.
- **Response shaping** — Ivanti records are wide. Return requested fields plus a sensible
  default; dumping every field burns context and buries the answer.

**Exit criteria:** everything annotated `readOnlyHint`/`idempotentHint`; safe to point at
production because nothing can mutate; a realistic question is answerable end to end.

---

## Stage B3 — Writes, `full` mode

`create_record`, `update_record`, `link_records`, `unlink_records`, `delete_record`,
`preview_delete`, attachments, `submit_service_request`, quick actions.

**Annotations are easy to get wrong here:** creates and links set `destructiveHint: false`
**explicitly** (the default is `true`); `update_record` is destructive but idempotent; deletes
and `run_quick_action` are destructive.

**Ships alongside:** the audit log completed — every mutating call records tool, target record
and the `Customer` it was for. Every operation executes as the single Ivanti MCP user, so
without this Ivanti attributes the whole system's changes to one account. It cannot be
retrofitted onto records that already exist.

---

## Stage B4 — `enduser` mode

- `ENDUSER_BUSINESS_OBJECTS` enforced in `selectTools()` — narrowing at **registration**, so
  absent tools never appear in `tools/list`.
- Startup validation of the allowlist against `list_business_objects`.
- `Customer` resolution: name → Ivanti Employee, with disambiguation when several match. This
  is the join stubbed back in A2.
- **Session identity pin**: first assertion resolves and is stored; later tool arguments that
  disagree are **rejected, not honoured**. This is what stops injected ticket text from changing
  identity mid-conversation.
- Session-scoped read-back: only RecIds created in this session are readable.

**Explicitly not shipped:** `get_record` by IncidentNumber in `enduser` mode — numbers are
sequential, so a status lookup by number is ticket enumeration across the company.

**Accepted risk, already decided:** an employee can claim to be a colleague. Same exposure as the
phone line, now scriptable. The pin bounds it within a conversation; OAuth removes it.

---

## Ordering rationale

**Why all of auth first:** it is cross-cutting and expensive to retrofit, and it is the only part
where a mistake is a security problem rather than a bug. Proving it with one trivial tool keeps
Ivanti behaviour out of the failure analysis entirely.

**Why the identity seam (A2) before OAuth (A3):** the seam touches every handler. Adding it after
two identity sources already exist means changing both.

**Why reads before writes (B2 before B3):** B2 can be pointed at production safely, which gets
real feedback on shaping and pagination before anything can do damage.

**Why `full` before `enduser` (B3 before B4):** `enduser` is `full` minus tools plus identity — a
narrowing of something that already works, not a parallel implementation.

## Standing risks

| Risk | Stage | Mitigation |
|---|---|---|
| Ivanti REST auth header format is a guess | B1 | Verify against the tenant before building on it |
| SDK protocol version lags the spec (1.30.0 → `2025-11-25`) | A3 | Re-check `LATEST_PROTOCOL_VERSION` before assuming a 2026-07-28 requirement is buildable |
| Real IdPs do not mint `aud` from the `resource` parameter | A3 | `OAUTH_AUDIENCE` configured separately; membership test, not equality |
| Entra token v1/v2 changes the issuer string | A3 | Pin `requestedAccessTokenVersion: 2`; validate `iss` exactly |
| Distroless missing CA bundle presents as an auth failure | A1 | Found early, while the surface is one tool |
| TypeScript pinned to 6.x by typescript-eslint | any | Revisit when typescript-eslint supports TS 7 |
| Asserted identity is impersonable | B4 | Accepted; pinning bounds it, OAuth removes it |
