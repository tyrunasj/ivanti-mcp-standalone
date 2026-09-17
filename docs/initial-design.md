# Ivanti MCP (standalone) — Initial Design

**Status:** design settled, no code yet · **Date:** 2026-09-10

A new standalone MCP server for Ivanti Neurons for ITSM, shipped as a Docker image and
also runnable locally. Separate from the existing Overlord-hosted Ivanti MCP.

This document records what was decided, *why*, and what is still open — including the
alternatives that were considered and rejected, so they don't get re-litigated later.

---

## Decisions at a glance

| # | Topic | Decision |
|---|---|---|
| 1 | Transport + auth | `STDIO_TRANSPORT_ON` / `HTTP_TRANSPORT_ON` (either, or both) and `AUTH_MODE` (none/bearer/oauth) are **separate axes**, chosen at startup, fail closed |
| 2 | Tenancy | One instance = one Ivanti tenant. Always. |
| 3 | Ivanti credential | A single API key / single Ivanti "MCP user" — the call-centre operator model |
| 4 | Audiences | Two startup modes: `full` (IT staff) and `enduser` |
| 5 | End-user identity | The LLM asks who the user is; OAuth skips the question |
| 6 | Permissions | No role system in the server — MCP tool annotations + the client harness |

---

## 1. Authentication modes

**Transport and authentication are two axes, not one.** The transport toggles say how the server
is reached; `AUTH_MODE` says who may connect. Conflating them (an early version had `stdio` as an
auth mode) made `stdio` and `none` two spellings of "no authentication" and left no way to name
the transport at all.

Transports are **independent booleans, not a single choice** — a process can serve both at once,
and a deployment can flip one without restating the other, which is how layered env config
actually gets edited.

| Toggle | Default | Auth applies? | Fits |
|---|---|---|---|
| `STDIO_TRANSPORT_ON` | `true` | **No** — the credential is the ability to run the process | Local/desktop clients, `docker run -i` |
| `HTTP_TRANSPORT_ON` | `false` | **Yes, required** | Everything remote |

Both off is refused: the server would serve nobody. Both on is supported — each transport gets
its own `McpServer` instance, since `connect()` binds one transport at a time.

The spec agrees on the first row: *"Implementations using an STDIO transport **SHOULD NOT**
follow this specification, and instead retrieve credentials from the environment."*

| `AUTH_MODE` (http only) | Caller proves identity by | Fits |
|---|---|---|
| `none` | nothing — the network is the boundary | Trusted corporate network / VPN, internal-only |
| `bearer` | static token in `Authorization` | CI, scripts, self-hosted, enterprise workspace connectors |
| `oauth` | OAuth 2.1 access token from the org's IdP | Claude, spec-compliant clients, enterprise SSO |
| `ip-allow` | source IP | A *modifier* stacked on any of the above, never a mode on its own |

Fail-closed in both directions: `HTTP_TRANSPORT_ON=true` with no `AUTH_MODE` **refuses to start**,
and an `AUTH_MODE` set while HTTP is off is **also** an error — it would otherwise read as
protection that is not there.

Notes:

- `none` is the stdio bargain over HTTP, with the corporate network as the fence. See §1.1.
- `bearer` is not spec-blessed, but it is what most non-Claude clients can actually do.
- `oauth` is the only mode carrying a **user** identity; the others authenticate a client.
- **mTLS was dropped** (2026-09-10). It identifies a machine rather than a person, and since
  the container does not terminate TLS (§7), the certificate check belongs to the proxy —
  which then forwards a verified identity header. It stacks on any mode, like `ip-allow`,
  rather than being one.
- In `oauth` mode the server is a **resource server only** — it never mints tokens.
  401 + `WWW-Authenticate` → `/.well-known/oauth-protected-resource` (RFC 9728), strict
  audience validation, PKCE. Issuance is delegated to Keycloak / Entra / Auth0.

### 1.1 `none` — open mode inside a trusted network

A first-class mode for internal deployments where the network boundary *is* the security
boundary and nobody wants to run an IdP for an internal tool. It must never happen by
accident, so it costs two deliberate keys rather than one:

- **`AUTH_MODE=none` is explicit only** — never a fallback, never inferred.
- **Bind defaults to `127.0.0.1` in this mode.** Exposing it to the network requires
  setting `MCP_BIND=0.0.0.0` as well. One key says "no auth", the other says "and reachable".
- **Loud startup banner** stating that auth is disabled, plus the effective bind address and
  IP allowlist, so it is obvious in logs when someone ships it this way by mistake.

**`Origin` validation is mandatory here — and it is a spec MUST in every HTTP mode.** The
Streamable HTTP transport requires servers to validate the `Origin` header on all incoming
connections and respond **403 Forbidden** when it is present and invalid, specifically to
prevent DNS rebinding. That matters most in `none` mode: "inside the corporate network"
includes every employee's browser, and without Origin checks a page an employee merely
visits can drive an unauthenticated MCP server on their machine or LAN. Configure via
`TRUSTED_ORIGINS`; reject anything else.

Pair it with the `ip-allow` modifier (`ALLOWED_CIDRS`) wherever the subnet is known — that
is what turns "the network is the fence" from an assumption into a control.

`none` composes with either operating mode. With `full` it is the IT-staff-on-the-LAN case.
With `enduser` it is consistent with §5, where identity is asserted rather than verified
regardless of transport auth.

---

## 2. One instance, one tenant

Whether in Docker or run locally, an instance serves exactly one Ivanti tenant.

A typical Ivanti deployment is three **environments** — staging, UAT, prod — so that is
three containers, not three tenants in one process. Slim/distroless images make the
per-instance overhead negligible.

**What this removes:** no `tenants.yaml`, no path-based `/{tenant}/mcp` routing, no
`tenant` parameter on any tool, no `list_tenants` tool, one connection pool, and **one
issuer** rather than a trusted-issuer list (the image is *configurable* for Keycloak or
Entra; any given instance trusts exactly one).

**Accepted cost:** registering all three environments in one client triples the tool list
the model sees. Mitigate by registering prod deliberately rather than by default, and by
naming the servers distinctly.

**Seam worth keeping:** request-scoped **caller identity** threaded through handlers as an
explicit argument. It is what end-user scoping needs, and it is the one thing that is
expensive to retrofit because it touches every handler.

---

## 3. Ivanti credential: the call-centre operator model

The MCP holds **one Ivanti API key** belonging to **one Ivanti "MCP user"**. Every
operation executes as that user. The person an operation is *for* is recorded in the
record's **Customer** field — exactly how a call-centre operator registers a caller.

Per-user Ivanti keys were ruled out: an enterprise has ~40k employees and they are not
provisionable.

This is complete and correct for `full` mode — the IT-staff human is the authenticated
party and `Customer` is just data they set.

The asymmetry to respect in `enduser` mode: a real operator is a trusted, accountable
human who verifies who is calling. The MCP holds the same privileged position with no
judgement and an attacker-influenced input channel. So **`Customer` is data, not
authorization** — it cannot be both the value and the fence.

### One key, but four wire surfaces (corrected 2026-09-11)

This section originally assumed one credential meant one REST client. Measured against the
working `overlord-service` implementation, the single API key is used across **four distinct
surfaces with three calling conventions**:

| Surface | Auth | Wire |
|---|---|---|
| **OData** `…/api/odata/businessobject/…` | `Authorization: rest_api_key=<key>` | JSON |
| **REST** `…/rest/…` — attachments, full-text search, service requests, templates | same header | JSON |
| **ASMX** `…/HEAT/Services/…asmx/<Method>` | **SID cookie + CSRF**, obtained by a handshake *using* the API key | JSON POST, `{d:…}` envelope |
| **`$metadata`** CSDL | `rest_api_key` | XML |

Note the header form: **`rest_api_key=<key>`**, with an equals sign, not a space.

The ASMX session carries **three sub-conventions** distinguished only by the placement and
casing of the CSRF token — `.asmx` wants `_csrfToken` in the body, `.ashx` handlers want
lowercase `_csrftoken` as a header with a form-urlencoded body and reply as a JavaScript object
literal, and multipart uploads want `_csrfToken` as a header. That detail exists only because
someone read HAR captures; it is not documented anywhere else.

**Why the split matters:** OData and REST return *records*. ASMX returns everything that makes
records comprehensible — the business-object catalog, form definitions, field display names,
legal values for a field, available quick actions, what a delete would cascade to. A REST-only
implementation can read and write but cannot tell the model what a field means or which values
are valid, which is the half that makes the other half safe.

### The session bootstrap yields a capability profile

```
1. FRSHEATIntegration.asmx/AuthenticateTenantAPIKey  { tenantId: <host>, apiKey, role:'Admin' } → SID
2. Session.asmx/InitializeSession                     { _csrfToken: null } + Cookie SID          → SessionCsrfToken
3. Session.asmx/GetUserData                           { _csrfToken, tzoffset:0 }                 → UserRole, DisplayName
4. Workspace.asmx/GetRoleWorkspaces                                                              → role-scoped objects
```

Step 1 **requests** `role: 'Admin'` and Ivanti silently downgrades to whatever the key actually
holds, so step 3 is not optional — `GetUserData` reports the *effective* role. Its failure is
non-fatal; fall back to the requested value.

Two consequences:

- **Never call `/HEAT/AdminUI/`.** Those are admin-console services and a tenant API key may
  carry any role; an analyst key is refused. Not every customer will issue an admin-rights key
  to this application. `overlord-service` removed its two AdminUI call sites and keeps a test
  asserting no request URL ever contains that path — worth carrying over verbatim.
- **The BO catalog therefore has two sources**, differently shaped rather than better and worse:
  `GetRoleWorkspaces` is role-scoped and rich (display names, layouts) but needs the session;
  `$metadata` `entityTypeNames()` needs only `rest_api_key` and is **wider**, because OData
  access is governed by Object Permissions rather than workspace membership.

### Two startup probes, both fail-soft

- **Base path** — the `/HEAT` prefix is usually present but not always. Probe both forms once at
  startup and keep whichever answers.
- **Capability profile** — attempt the session handshake. Success registers the ASMX-backed
  tools; failure registers only the OData/REST set. Narrowing happens at **registration**, the
  same mechanism `MCP_MODE` uses, so a credential that cannot serve a tool never sees it in
  `tools/list` — an absent capability rather than a runtime error.

Refuse to start only if *nothing* works.

### Surface the effective identity to the model

The bootstrap knows `DisplayName` and `UserRole`. Put them in the server `instructions`, because
anything Ivanti resolves "for the current user" — a saved search called "My …" — answers for the
**service account**, never the human asking. Without being told, the model will confidently
report one person's items as another's. This matters most in `enduser` mode, which is exactly
where it is least acceptable.

---

## 4. Operating modes: `full` and `enduser`

Ivanti ITSM is a service desk with two audiences, so the server picks one at startup.

| | `full` | `enduser` |
|---|---|---|
| Audience | IT staff | Employees |
| Business Objects | all | allowlisted only |
| Operations | everything, including prod writes and deletes | create + attach; read/edit own |
| Ivanti credential | the one MCP user | the one MCP user |
| Identity needed | no | asserted, or from OAuth |

Configuration keys on the **technical** Business Object name — what `list_business_objects`
returns and what the REST API accepts — never the display name, which is customizable and
localizable per tenant:

```
MCP_MODE=enduser
ENDUSER_BUSINESS_OBJECTS=Incident,ChangeRequest,ServiceReq
```

Validate these against `list_business_objects` at startup and refuse to start on an unknown
name, rather than surfacing the typo when a user's first `create_record` fails.

> A blanket production `READ_ONLY` gate was proposed and **rejected**: production is where
> the work happens, and an ITSM MCP that cannot resolve an incident in prod is useless.
> The tool surface narrows by *audience*, not by environment.

---

## 5. Identity (`enduser` first; since 2026-09-17, both modes)

When the user asks to see their tickets, the LLM **asks who they are** and reads/edits are
filtered by that Customer. Under `oauth` the question is skipped and identity comes from
the token.

**Accepted risk:** an employee can claim to be a colleague. This is the same exposure the
phone line already has — service desks live with it, and the MCP is no weaker than the
channel it replaces.

**The one genuinely new risk** versus the phone is that Ivanti ticket text is written by
whoever filed the ticket, so injected content could change the identity mid-conversation
without anyone asserting anything. Mitigations, all cheap:

- **Pin the identity once per session, server-side.** The first assertion resolves to an
  Ivanti Employee RecId and is stored. Later calls use the pinned value; a tool argument
  that disagrees is **rejected, not honoured**.
- **Resolve name → Employee record**, with disambiguation (three Johns ⇒ the model asks).
  Better UX, and it makes identity a real record rather than a matched string.
- **Audit-log the identity and how it was established** (`asserted` vs `oauth-verified`)
  on every call — the equivalent of call recordings.
- **When a token is present, user-asserted identity is ignored entirely** — not merged,
  not preferred. Otherwise the strong path has a bypass around it.

**Trap:** do not expose `get_record` by IncidentNumber in `enduser` mode. Incident numbers
are sequential, so a status lookup by number is ticket enumeration across the whole
company — the model would happily walk #11160, #11161, #11162.

**Smallest useful `enduser` mode, needing zero authorization code:** create on the
allowlisted BOs, attach files, and read back only the RecIds created in the current
session. OAuth then upgrades it to "show me my tickets from last month".

---

### Resolving the person: `act_as`

Identity arrives through **one tool, called once per session**, not through an argument on every
tool. An argument repeated across fifteen tools fails silently the first time the model forgets
it — the call then answers for the service account, which is exactly the class of quiet wrong
answer this server exists to refuse. A single `act_as` fails loudly instead: nothing person-scoped
works until it has been called.

`act_as` does two different jobs, and the mode decides which:

| Mode | What `act_as` is | If it was never called |
|---|---|---|
| `enduser` | a **gate**, and whose records these are | every tool but `act_as` refuses |
| `full` | a **gate**, and who "my" means | every tool but `act_as` refuses |

**Revised 2026-09-17: `full` is gated too.** This table read "a preference" for `full`, on the
reasoning that an IT agent legitimately works other people's tickets. That is still true, and the
pin still allows it: the gate decides **whether this conversation may answer at all**, not **whose
records it may read**. An agent calls `act_as` for themselves and then works the queue exactly as
before. What the gate ends is the *unattributed* conversation — a `full` deployment that answered
before anyone said who was asking put the service account on every line of the audit log and on
every write in Ivanti, and there was no later point at which that could be corrected.

The gate lives in `registerTools`, the one place every call passes through. Tool by tool it would
be forgettable, and a tool that forgot would not fail — it would answer, for nobody. `get_version`
is gated with the rest: a version is an answer. Two things are outside it, and only two: `act_as`
itself, and a deployment with no tenant configured, where `act_as` is not registered and the gate
would refuse what nothing could ever satisfy.

**A signed-in conversation pins itself (2026-09-17).** Where the identity is `verified`, the token
already names the person, so requiring the model to call `act_as` and repeat what the issuer said
is a round trip that can only go wrong. The gate attempts it once, on the first call that needs it,
by running `act_as`'s own handler — never a second copy of rules about what a token may match, what
it must confirm and what it refuses, because the two would differ and the weaker one would be the
copy. An **asserted** session is untouched: there is nothing to pin from but a claim, and a claim
has to be made deliberately.

Lazily, and not at `initialize`, for two reasons. Pinning does real work against Ivanti — a
directory lookup, and an impersonation handshake where that is configured — so a slow or
unreachable tenant would fail the *connection* rather than one call. And a token that matched only
on a name has to ask for confirmation, which needs somewhere to ask. One attempt per conversation,
shared by concurrent callers, so a cold conversation that fires three calls runs one lookup and
refuses none of them for losing the race.

**Resources answer the same gate.** `ivanti://reference/…` carries no tenant data — six static
documents — so gating them is consistency rather than containment, and it is done by passing the
tools' own `mayAnswer` to `registerResources` rather than by a second copy of the condition. The
refusal is returned *as the document* rather than thrown: clients routinely read every resource at
connect time to display them, and a protocol error there would paint a fresh conversation with
failures for documents that could leak nothing if they were served.

### The conversation ends, and a stdio process has to be told (2026-09-17)

The pin is per connection, which over HTTP is per conversation: the session store sweeps an idle
session and the server goes with it, pin and all. A stdio process has no session — it is one
connection for the life of the process — so a client that keeps the server running across
conversations, which is the ordinary shape for an editor or a CLI, carried the first person's pin
into every conversation that followed. The person outlived the conversation that named them, and
under `enduser` the next conversation was answered with the first person's records.

There is no protocol signal for "the user cleared the context", so two stand in for it. Neither is
reachable by the model — a tool that could end a conversation could shed the pin, which is the one
thing the pin exists to prevent:

- **Silence.** No tool call for `MCP_IDENTITY_IDLE_TTL_SECONDS` (default 1800) ends it. Its own
  setting rather than the session sweep's, which it borrowed for one release: that one bounds
  memory held by a dead HTTP session and wants to be short, this one decides how long a person's
  records stay reachable to whoever is at the keyboard. Bias it short — expiring too eagerly costs
  one more `act_as`, expiring too late answers the next conversation with the last person's records.
- **A fresh `initialize`** on a live connection — the client saying so itself. Exact, but only some
  clients re-initialize rather than reconnect, so silence is the one that always arrives.

Ending a conversation throws the pin away and hands back any impersonated Ivanti session, so the
next one starts with nobody and is free to pin somebody else. Time is the one thing injected record
text cannot forge, which is why this is safe where a model-callable `reset` would not be.

**The three keys.** A person is matched on `LoginID`, on `PrimaryEmail`, or on
`FirstName` + `LastName` — never on `DisplayName`, which is assembled and carries the middle name
("John M Doe", "Katherine M Joseph"), so the full name a person types for themselves frequently
does not equal it. Match on the parts; *display* `DisplayName`.

Measured on the staging tenant (2026-09-12):

| | |
|---|---|
| Person objects | `employee` (628) and `externalcontact` (2) — both carry all three keys, and both populate them |
| `eq` comparison | **case-insensitive**: `FirstName eq 'harold' and LastName eq 'SANDERS'` matches Harold Sanders |
| Keyword `search` | substring, and it **over-matches**: `"John"` returns John Smith, John Davis, John M Doe — and **Scott Johnson** |
| `Employee.Status` | `Active`, `New`, `On Leave`, `Terminated` |
| The link | `ProfileLink_RecID` **+** `ProfileLink_Category` (`"Employee"`) — a pin is the **pair**, never the id alone |

`$filter` has no string functions and drops them silently, so partial-name resolution has to go
through Ivanti's keyword search and then be **re-filtered client-side against the three keys**.
Presenting the raw search result would ask someone to choose between themselves and a stranger
whose surname merely contains their first name.

**The ladder:**

1. Exact `eq` on `LoginID`, on `PrimaryEmail`, or on `FirstName`+`LastName` → one row: resolved.
2. Otherwise keyword search, re-filtered client-side, capped → candidates.
3. Nothing survives → **refused**.

**How each entry point uses it:**

| Provenance | Behaviour |
|---|---|
| `anonymous` | The model asks who the user is and runs the ladder on the answer. One candidate → confirm, then pin. Several → present them and let the user choose. None → refuse. |
| `verified` | An **exact** match on the configured claim pins silently. Anything less pins only after the user confirms — and the confirmation must **show what was matched against what**. |

The second row is the load-bearing one. The token proves **who the person is**; it does not prove
**which record is theirs**. Accepting a near-match silently because the token validated is how this
feature would hand someone a colleague's tickets.

**A candidate list is not a claim.** Only the user's choice pins — otherwise offering three
candidates would read as three assertions and trip the "a later, different claim is refused" rule
in `identity-pin.ts`. Once pinned, the pin is final for the session: a wrong choice is corrected by
starting a new session, and the refusal has to say so or it is not actionable.

**A confident match is still `asserted`.** Resolving a claimed name to a real Employee record does
not make the claim true — it makes it well-formed. Provenance stays `asserted`, and the audit log
keeps reading as a claim rather than a fact.

**Refusals, all failing closed:**

| Case | Answer |
|---|---|
| No match | Refuse — *"could not find you in Ivanti"*, **never** an empty result, which a model reports as "you have no tickets" |
| Too many matches | Cap the list, ask for something narrower; never dump the directory |
| `Status` is `Terminated` | Refuse |
| `Status` is `New` or `On Leave` | Pin, flagged |
| Verified token, no Ivanti record | Refuse — and say they cannot file one either, since Ivanti requires a Customer |
| The same person in both objects | **Open** — see below |

**`act_as` is a directory search, and has to be bounded like one.** Free-text name lookup is
available to anyone who can reach the server, and in `bearer` mode the token is shared, so one
holder could otherwise walk the entire employee directory. Minimum query length, a capped candidate
list, only the fields that disambiguate (the name, and an email only when the email is what
separates two candidates), and an attempt limit per session. `IPCM_SearchableByName` looks like the
tenant's own answer to this question and **is not**: it belongs to Ivanti Voice, and most tenants
never populate it.

**The pin comes before any ticket text.** Rule 3 already refuses a *later*, different claim, which
covers re-pinning by injection — but not the **first** claim, if the model read a record before the
user introduced themselves. So in `enduser` mode every record-returning tool requires the pin. No
untrusted content can then reach the model before the pin exists, and the window closes entirely
instead of narrowing.

**Two knock-on effects.** The claim to match on varies by provider — Entra sends
`preferred_username` or `upn`, others `email`, and `sub` is opaque and pairwise — so it needs
configuring the way `OAUTH_AUDIENCE` turned out to. And `list_saved_searches` today flags 13 of 25
searches as answering for the service account; once a pin exists, that flag means **"answers for
someone other than you"**, which is a sharper warning and should read as one.

**Caching, asymmetrically.** A verified session may cache `subject → {recId, category}` and skip the
confirmation next time — the token subject is a strong key. An asserted session must never cache,
because that only makes an unverified claim sticky.

**A person is in one object or the other, not both — decided 2026-09-12.** Ivanti does not keep
the same human as an Employee *and* an External Contact, and the staging tenant agrees: neither
external contact's login or email appears among the 628 employees. So the pin is one record, and
"my tickets" is complete. If a tenant ever does produce both, nothing merges them silently — the
directory searches both objects, so the caller is shown two candidates and picks one, which is a
visible choice rather than a quiet half-answer.

**One person per MCP session — and the multi-person gateway is deferred, not solved.** The pin
lives on the session, and a session is whatever the client opened. One person per client — Claude
Code, Claude Desktop, an IDE — is one session each, which is the normal case and is safe.

A **gateway** is the case that is not: a Slack or Teams bot, or a web chat front end, connecting
once at start-up and multiplexing everybody's conversations over one session. The first person to
call `act_as` pins it; the second is either shown the first person's records or refused with a
conflict. Under `oauth` this cannot arise — every request carries its own token, and
`sameSubject()` already answers 403 when a second verified subject uses a session it did not open.
Under `none` and `bearer` there is no per-request principal at all: a shared token is the same
credential for everyone holding it, so there is nothing to compare.

**Deferred deliberately, because the eventual answer is a better one than a session rule.** A Slack
or Teams user is *already authenticated* — by Slack, by Teams, by Entra behind it — and the gateway
knows exactly who sent each message. So the shape of the real solution is not "make the gateway
open more sessions", it is **let the gateway carry the identity it already has**, per request: the
gateway authenticates as itself, and asserts a subject on behalf of the person. That is a third
provenance between the two we have — stronger than `asserted` (a platform authenticated them,
not the person claiming) and weaker than `verified` (we are trusting the gateway's word, not an
issuer's signature to us) — and it needs a trust relationship with the gateway that nothing in the
config expresses yet. Designing it against a real Slack or Teams deployment will produce a better
answer than designing it now against an imagined one.

Until then the interim position is disclosure, not enforcement: `MCP_MODE=enduser` over HTTP
without `oauth` logs a startup warning that each person must get their own session. A hard refusal
was considered and rejected — `bearer` with one session per user is a legitimate deployment, and
the setting cannot tell the two shapes apart, so refusing would break the good case to stop the
bad one.

---

### Attachments: bytes in a tool call, not a hosted upload page

`overlord-service` attaches a file by handing the user a browser URL: it hosts an upload page,
keeps a token store with a fifteen-minute TTL, and sweeps what expires. That is the right design
for a web service that is already serving pages, and the wrong one here — this server may be
running over **stdio with no HTTP listener at all**, and the transport it serves MCP on is an
independent axis from whether it hosts anything (design §1).

So `upload_attachment` takes the file as base64 in the tool call, capped at **2 MB**. The cap is
the honest consequence rather than a tunable: base64 is four characters per three bytes and
crosses the model's context twice, once written and once in the transcript. A deployment that
wants the hosted flow should build it *around* this server — mint its own token, collect the file,
and call `upload_attachment` server-side — rather than have the MCP process grow an HTTP surface
it otherwise does not need.

`request_attachment_upload` and `check_attachment_upload` are therefore **not ported**, and
`src/resources/resources.test.ts` fails if a reference document starts promising them.

---

## 6. Permissions: annotations, not roles

The server implements **no** role/permission system. Auth modes differ in what identity
they can carry — JWT claims can bring roles, a static bearer token cannot — so rather than
build a claim→permission mapping that only one mode could feed, tools are annotated and
the client harness applies its own permission mechanism.

Verified against the 2026-07-28 spec — `ToolAnnotations` is unchanged:

```typescript
interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;    // default: false
  destructiveHint?: boolean; // default: true
  idempotentHint?: boolean;  // default: false
  openWorldHint?: boolean;   // default: true
}
```

The defaults matter: an unannotated tool reads as destructive and open-world, so silence is
safe but useless. Every tool gets explicit values.

| Tools | Annotations |
|---|---|
| `get_record`, `list_records`, `search`, `count_records`, metadata / pick-list / `preview_*` | `readOnlyHint: true`, `idempotentHint: true` |
| `create_record`, `link_records`, `upload_attachment`, `submit_service_request` | `destructiveHint: false` — **must be explicit**, the default is `true` |
| `update_record` | `destructiveHint: true` (overwrites), `idempotentHint: true` |
| `delete_record`, `delete_attachment`, `unlink_records`, `run_quick_action` | `destructiveHint: true` |

`openWorldHint: true` everywhere. That is not just "Ivanti is remote" — it tells the client
that returned content was written by whoever filed the ticket. In an ITSM system the **read**
tools are the prompt-injection surface, not the write tools.

Annotations are hints and bind only clients that have a harness; the spec is explicit that
clients must not make tool-use decisions on annotations from *untrusted* servers. That is
fine here — the operator deploys this server themselves.

---

## 7. Container and deployment

- **`MCP_PUBLIC_URL` is required and never derived from the request.** Behind Traefik or
  nginx the Host header and scheme don't reflect reality, but the RFC 9728 metadata
  document and the resource identifier in token audiences must match the externally visible
  URL *exactly*, or audience validation fails in ways that look like client bugs.
- **Secrets via the `*_FILE` convention** (`IVANTI_API_KEY_FILE=/run/secrets/...`) so
  Docker/K8s secrets work without leaking into `docker inspect`. Inline secrets in config
  are rejected.
- **No TLS termination in the container** — plain HTTP inside, TLS at the proxy. Trust
  `X-Forwarded-*` only from a configured proxy CIDR, or client IP becomes spoofable.
- **`/health` unauthenticated**, everything else behind the mode.

### Distroless gotchas

The image is intended to be very slim, possibly distroless. These break silently there and
surface as confusing *auth* failures rather than clear container errors:

- **No shell → no entrypoint wrapper.** The application must read `*_FILE` secrets itself,
  not via a `sh -c` that exports env vars.
- **`HEALTHCHECK` needs an executable** (no curl/wget): give the binary a `--health`
  subcommand, or use a k8s `httpGet` probe and skip Docker healthchecks.
- **CA certificates**: `distroless/static` ships them, `scratch` does not. Needed for TLS
  to Ivanti *and* for fetching the IdP's JWKS — a missing trust store looks like a token
  validation failure, not a TLS error.
- **`:nonroot` runs as uid 65532** — mounted secret files must be readable by it.
- **tzdata** is absent, if Ivanti dates are ever formatted in a local zone.

---

## 8. Configuration (draft)

| Variable | Notes |
|---|---|
| `STDIO_TRANSPORT_ON` | Default `true` — it listens on no socket. |
| `HTTP_TRANSPORT_ON` | Default `false`. Both may be on; both off is refused. |
| `AUTH_MODE` | `none` \| `bearer` \| `oauth`. Required when HTTP is on, rejected when off. |
| `MCP_BIND` | Defaults to `127.0.0.1` in `none` mode; `0.0.0.0` must be set explicitly |
| `TRUSTED_ORIGINS` | Allowed `Origin` values. Invalid → 403. Required in all HTTP modes. |
| `ALLOWED_CIDRS` | Optional `ip-allow` modifier, stacked on any HTTP mode |
| `MCP_MODE` | `full` \| `enduser` |
| `MCP_PUBLIC_URL` | Required for HTTP modes. Externally visible URL, never derived. |
| `IVANTI_BASE_URL` | The tenant's Ivanti endpoint |
| `IVANTI_API_KEY_FILE` | Preferred over `IVANTI_API_KEY` |
| `ENDUSER_BUSINESS_OBJECTS` | Technical BO names, validated at startup |
| `OAUTH_ISSUER` | One issuer per instance; validated exactly (Entra v1 and v2 differ) |
| `OAUTH_AUDIENCE` | Expected `aud`; defaults to `MCP_PUBLIC_URL` but set independently for real IdPs |
| `BEARER_TOKEN_FILE` | `bearer` mode |
| `MCP_SESSION_IDLE_TTL_SECONDS` | Default `1800`. Idle sessions are swept — `onsessionclosed` fires only on an explicit DELETE |
| `MCP_IDENTITY_IDLE_TTL_SECONDS` | Default `1800`. A conversation quiet this long is over: the pinned person is forgotten. On stdio this is the only thing that ends one |
| `MCP_MAX_SESSIONS` | Default `100`. Beyond it `initialize` gets 503; unbounded growth is a DoS surface under `none` |
| `TRUSTED_PROXY_CIDR` | Required before `X-Forwarded-*` is honoured |

---

## 9. Implementation stack

**Language: TypeScript** (decided 2026-09-10). Base image `gcr.io/distroless/nodejs22-debian12`.

**Package manager: pnpm.** Chosen mainly for its strict, non-hoisted `node_modules`: it fails
the build when we import something we did not declare, which is exactly the transitive-express
trap noted below. It also gives smaller installs and a clean `--prod` tree to copy into the
distroless stage. Commit the lockfile, pin the version with the `packageManager` field, and
install pnpm explicitly in the builder stage rather than relying on corepack. If corporate CI
or a proxied registry makes an extra tool awkward, `npm ci --omit=dev` is an acceptable
fallback — at the cost of losing phantom-dependency detection.

**SDK: `@modelcontextprotocol/sdk`** — latest `1.30.0`, published 2026-07-27 (79 versions
released). Requires Node >= 18.

**Zod: v4** (`zod@^4`, latest `4.6.1`). The declared peer range is `^3.25 || ^4.0`, but the
SDK is **v4-first internally** — 15 imports from `zod/v4`, plus `zod/v4-mini` and
`zod/v4/core`, and its public types are expressed in v4 core types (`z.core.$strip`,
`z.core.$loose`). It carries a shim, `server/zod-json-schema-compat.js`, that branches on
`isZ4Schema()`: v4 schemas use `zod/v4-mini`'s native `toJSONSchema`, v3 schemas fall back to
the vendored `zod-to-json-schema`.

So install v4 and import from the `zod` root. The `^3.25` half of the range exists only
because zod 3.25 ships `zod/v4` as a migration subpath — no reason to take it on a new
project. **Do not import `zod/v3` anywhere**: it drops you into the vendored converter branch
and the types stop lining up with the SDK's own. v4 is also markedly faster and smaller than
v3, which matters both for the slim image and for generating `tools/list` over a wide Ivanti
Business Object surface.

**Protocol version — important:** SDK 1.30.0 reports

```
LATEST_PROTOCOL_VERSION   = '2025-11-25'
SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
```

It does **not** yet implement `2026-07-28` — it shipped one day before that revision landed.
So build against **2025-11-25** and treat the 2026-07-28 requirements in §11 as forward-looking.
Pin the SDK exactly and watch for the release that bumps `LATEST_PROTOCOL_VERSION`.

**Auth is in the box — use it, don't reimplement the RFCs.** `server/auth/` splits cleanly
into the half we want and the half we must not mount:

| Use | What it gives us |
|---|---|
| `mcpAuthMetadataRouter(options)` | Serves `/.well-known/oauth-protected-resource` with `resource`, `authorization_servers: [issuer]`, `scopes_supported`, `resource_name` — RFC 9728, done |
| `requireBearerAuth({ verifier, requiredScopes, resourceMetadataUrl })` | 401/403 semantics and the `WWW-Authenticate` header with the `resource_metadata` pointer |
| `getOAuthProtectedResourceMetadataUrl(serverUrl)` | Builds that pointer URL — `serverUrl` **must** be `MCP_PUBLIC_URL`, per §7 |

| Do **not** use | Why |
|---|---|
| `mcpAuthRouter(options)` | The full **authorization server** — `authorize`, `token`, `register`, `revoke`. Mounting it makes us an IdP; per §1 we never mint tokens. |
| `proxyProvider` | Same reason |

**The one piece that stays ours** is the verifier — a single method:

```ts
verifier.verifyAccessToken(token) => Promise<AuthInfo>
```

That is where `jose` validates the JWT against the IdP's JWKS and we check `iss`, `aud`
(must equal our resource URL), and `exp`, then map claims to the Ivanti Employee identity
for §5. It has to be ours because it is IdP- and tenant-specific — but it is a claim mapping,
not an RFC reimplementation.

**Transports:** `server/stdio`, `server/streamableHttp`, `server/webStandardStreamableHttp`
(web-standard/Hono variant), plus legacy `server/sse`.

**No web framework of our own is needed** — no Fastify, no NestJS. The dependency tree already
carries `express@^5`, `hono@^4` + `@hono/node-server`, `jose@^6` (JWT verification) and
`pkce-challenge@^5`. But the split is worth knowing:

- The **transport core is web-standard, not express.** `webStandardStreamableHttp` exposes
  `handleRequest(request: Request): Promise<Response>`, and the Node `streamableHttp` wrapper
  uses `@hono/node-server`'s `getRequestListener` to accept plain `(req, res)`. Neither
  imports express.
- **Express shows up in the OAuth pieces**: `auth/handlers/metadata` builds an express
  Router, `auth/middleware/bearerAuth` is express-shaped `(req, res, next)` middleware, and
  `server/express.js` offers a batteries-included `createMcpExpressApp()`.

So `stdio` / `none` / `bearer` modes need essentially no framework — `node:http` plus
`transport.handleRequest(req, res)` covers `/mcp`, and `/health` is a few lines. Express earns
its place only when `oauth` mode is built, where it gets the RFC 9728 metadata router for free.

> **Caveat: declare what you import.** Express arrives *transitively*. Importing it without
> listing it in our own `package.json` works only through hoisting — it breaks under pnpm's
> strict layout, breaks if the SDK drops or bumps express, and gives us no semver protection.
> If we use express, it goes in our dependencies explicitly.

---

## 9b. Open questions

1. Whether `enduser` reads ship as session-scoped read-back first, with OAuth-backed
   "my tickets" as a follow-up.

---

## 9c. Identity provider survey (measured 2026-09-10)

Live discovery documents, fetched directly. This is the evidence behind the JWKS-only decision
and behind treating pre-registration as the default path.

| IdP | `jwks_uri` | introspection | DCR | PKCE advertised |
|---|---|---|---|---|
| **Entra ID** | ✓ | ✗ | ✗ | **ABSENT** |
| Okta | ✓ | ✓ | ✓ | ✓ |
| Auth0 | ✓ | ✗ | ✓ | ✓ |
| Keycloak | ✓ | ✓ | ✓ | ✓ |
| Zitadel | ✓ | ✓ | ✓ | ✓ |
| Google | ✓ | ✗ | ✗ | ✓ |
| JumpCloud | ✓ | ✗ | ✗ | ✓ |
| Duende IdentityServer | ✓ | ✓ | ✗ | ✓ |
| Salesforce | ✓ | ✓ | ✓ | ✓ |
| GitLab | ✓ | ✓ | ✗ | ✓ |

Four things follow:

1. **`jwks_uri` is universal (10/10); introspection is not (6/10).** JWKS is the only validation
   mechanism that works everywhere, so it is the primary path.
2. **DCR is missing on half.** Pre-registering a client is the *common* case, not an Entra
   quirk — Entra, Google, JumpCloud, Duende and GitLab all require it. Client pre-registration
   (`--client-id`) belongs in the onboarding instructions, not in a troubleshooting note.
3. **Entra is the sole provider not advertising `code_challenge_methods_supported`.** The spec
   says a conformant client **MUST refuse to proceed** when it is absent. Entra supports PKCE
   S256 in practice but does not say so, and nothing server-side can fix another party's
   metadata document. See §12.
4. **JWT is reachable on every IdP, but often by configuration.** Opaque is the default on
   Zitadel (per app), Okta (org authorization server), Auth0 (unless `audience` is passed) and
   Google. The onboarding document therefore needs a per-IdP "make it issue JWTs" step:

   | IdP | Lever |
   |---|---|
   | Entra | none needed; pin `requestedAccessTokenVersion: 2` |
   | Okta | use a **custom** authorization server, not the org one |
   | Auth0 | pass the `audience` parameter |
   | Zitadel | set the app's Auth Token Type to **JWT** |
   | Keycloak | default is already JWT |

---

## 10. Rejected alternatives

| Rejected | Why |
|---|---|
| Multi-tenant single container with `tenants.yaml` | Overcomplicated for 3 environments; process boundary is a better fence than code, and it puts a `tenant` param on every tool |
| Per-user Ivanti API keys | ~40k employees; not provisionable |
| Production `READ_ONLY` gate | Prod is where the work happens |
| Roles/permissions system in the server | Only `oauth` could feed it; annotations + harness cover it |
| Server-side re-implementation of Ivanti authz (injected `Owner` filters, fetch-then-check) | Superseded by the single-operator + `Customer` field model |
| ~~Ivanti impersonation / on-behalf-of~~ | **Reversed 2026-09-14.** Held while it was believed unavailable; CentralConfig does mint a session for a named person, and OData applies that person's access to it. Now optional and off by default — see below, and `docs/impersonation-plan.md` |
| **RFC 7662 token introspection** | **Deferred, not abandoned — see below** |
| Sharing the Ivanti layer as a package with `overlord-service` | Forked instead (2026-09-11): this server is expected to evolve independently, and shared code would make every divergence a negotiation. Cost — Ivanti discoveries travel manually — is accepted; see plan, "Fork, not shared package" |
| Trimming `search_knowledge` from `full` mode, where the gate is open and `fulltext_search_object` reaches the same object | Kept (2026-09-12). Its job in `full` is not gating: `Details` is rich-text HTML — one published article is ~2,600 characters of `<FONT>` tags around 400 words — and the generic read returns it raw. The tool strips it to text, truncates with the cut stated, and surfaces `Status` so a Draft is visibly internal. One interface across both modes beats a tool that exists in one of them |
| Exposing service-request staging ids to the caller, as `overlord-service` does | Staging happens **inside** `submit_service_request` (2026-09-12). A staging id is one-shot and a second submit *moves* the file off the first request rather than copying it; an id that never leaves the server cannot be reused, which designs the footgun out instead of documenting it |
| Casting an approval through "Approve My Vote" on the approval record | Refused. Ivanti resolves "my" from the signed-in session, so it records **this server's service account** as the decision-maker, and on an admin key the override sibling bypasses the real approver. `vote_on_approval` acts on the `frs_approvalvotetracking` row instead, which already belongs to a named approver, and refuses any row whose `Owner` is not the pinned person |
| Voting by setting the vote row's `Status` directly | Measured and rejected (2026-09-12): it stores the status, overwrites `VotedBy` with the session account, and leaves the approval `Pending` — the workflow never fires, so it is a vote that counts for nothing |
| ~~Impersonating **every** surface, not only records~~ | **Reversed the same day (2026-09-14).** The 551s that made the form surface look unreachable were a CentralConfig session that had never been *activated*: `Session.asmx/SelectRole` must be called after `InitializeSession`, even naming the role already reported, and the server had optimised that call away when the role matched. Controlled on a live tenant — same role, same CSRF — two `InitializeSession` calls stayed at 551; one plus `SelectRole` answered 200. Every surface is now impersonated; only tenant facts (schema, admin catalog, person directory, UTC offset) stay on the service account, for a stated reason rather than a measured refusal |
| Ranking roles by object-workspace count to find the least-privileged one | Built, then deleted (2026-09-14). Wrong twice: the counts do not separate the classes — `SelfServiceMobile` carries 1 object workspace and `SelfService` carries 0, and both are self-service — and `GetRoleWorkspaces` answers 551 on every impersonated session, so the measurement is unavailable exactly where it would be used. Ivanti already labels them: `SelfServiceRole` on `GetUserData.userRoleList` |
| `FRSHEATIntegration.asmx/SetRoleForUserSession` for selecting a role | Wrong lever. `Session.asmx/SelectRole` re-points the established session with no re-authentication, and is on the one ASMX service an impersonated session may use. (`Account/SelectRole` is a third thing: the signed-out MVC form, needing an anti-forgery token only available while signed out) |
| `FindActiveTenantRecord` as the startup probe | Rejected 2026-09-14 despite being the *better* probe — it is the only one that catches a wrong tenant, answering an empty body for an unknown one. It returns the tenant's `DBConnectionString` and `PrimaryEncryptionKey`, and pulling the database credentials across the wire on every boot is not worth catching a typo. `GetTenantTimeout` returns one integer, 401s on a wrong key, and cannot detect a wrong tenant — a limit the probe's own documentation states |
| A `list_roles` tool beside `switch_role` | Rejected 2026-09-14. The roles ride along in the `act_as` and `switch_role` responses, which costs nothing against the manifest. Decisive argument: a tool that listed when called bare and mutated when given an argument must carry the worse annotation, so *looking* at roles would read as a state change to any client that gates on them |

### Introspection — deferred

Measured against the survey above: introspection is **absent on 4 of 10 providers, including
Entra**, so it cannot be the universal path and cannot rescue the majority. It would serve only
customers on the other six who additionally refuse to configure JWT tokens — while costing a
network round-trip to the IdP on **every** request and a hard runtime dependency on the IdP
being reachable for every tool call. Caching fixes the latency but trades away instant
revocation, which is introspection's main advantage over JWTs in the first place.

**Revisit if any of these becomes true:**
- a customer's IdP issues opaque tokens and their policy forbids switching to JWT;
- an IdP appears with no `jwks_uri` at all;
- instant revocation becomes a stated requirement rather than a nice-to-have.

**It is cheap to add when needed.** Everything downstream depends on one type —
`TokenVerifier = (token: string) => Promise<TokenVerification>` — so a second implementation is
purely additive. `looksLikeJwt()` already exists and would do the routing; introspection would
enable itself by the presence of `OAUTH_INTROSPECTION_CLIENT_ID`/`_SECRET`, needing no new mode
flag, with the endpoint taken from the authorization-server metadata we already fetch at
startup. Roughly 80-100 lines plus tests.

---

## 11. Spec conformance (verified 2026-09-10)

Checked directly against `modelcontextprotocol.io/specification/2026-07-28/basic/authorization/*`
and cross-checked via context7. The earlier "to verify" list is resolved.

### Confirmed

- The **2026-07-28** revision is real and published.
- *"MCP servers **MUST** implement OAuth 2.0 Protected Resource Metadata ([RFC9728])."*
- The PRM document *"**MUST** include the `authorization_servers` field containing at least
  one authorization server."*
- *"MCP clients **MUST** implement Resource Indicators for OAuth 2.0 as defined in RFC 8707."*
- Dynamic Client Registration is deprecated in favour of Client ID Metadata Documents.

### Corrected

1. **Client registration is not our concern at all.** CIMD and DCR obligations fall on *MCP
   clients and authorization servers*. A resource server serves **no `/register` endpoint and
   hosts no client ID metadata document**. The earlier plan to ship "CIMD default-on, `/register`
   opt-in" was simply misassigned — that workstream does not exist for us.
2. **There is no 12-month DCR deprecation window.** The spec states deprecation with no
   timeline. That claim was unsubstantiated.
3. **stdio should not do OAuth, by the spec's own words:** *"Implementations using an STDIO
   transport **SHOULD NOT** follow this specification, and instead retrieve credentials from
   the environment."* Our stdio mode is exactly the recommended behaviour.

### What we MUST do when `oauth` mode is built

- **Serve PRM.** Implement at least one discovery mechanism; do both, since clients must
  support both: the `WWW-Authenticate: Bearer resource_metadata="..."` header on 401, and the
  well-known URI. Path insertion applies — an endpoint at `https://example.com/public/mcp`
  hosts metadata at `https://example.com/.well-known/oauth-protected-resource/public/mcp`.
- **Validate every token.** Per OAuth 2.1 §5.2, and *"**MUST** reject tokens that do not
  include them in the audience claim."* Invalid or expired → **401**. Note the expected
  audience is **configured separately** from `MCP_PUBLIC_URL`: neither Zitadel nor Entra mints
  `aud` from the client's `resource` parameter (Zitadel emits a project ID, Entra an App ID
  URI), and `aud` may be an array — so this is a membership test against `OAUTH_AUDIENCE`.
- **Never relay a token.** *"MCP servers **MUST NOT** accept or transit any other tokens"*, and
  *"The MCP server **MUST NOT** pass through the token it received from the MCP client."*
  → This **settles the open token-propagation question** (§9b): passing a caller's token to
  Ivanti is forbidden outright. The single-Ivanti-key operator model in §3 is not merely
  simpler, it is the conforming design. Acting as our own OAuth client to an upstream API is
  still permitted, so token *exchange* remains open if ever needed.
- **Include `scope` in the `WWW-Authenticate` challenge** (SHOULD), and account for scope
  hierarchies where a broader scope implies narrower ones.
- **Use the right status codes**: 401 unauthorized/invalid token, 403 invalid scope or
  insufficient permission, 400 malformed. Insufficient scope answers 403 with
  `error="insufficient_scope"`, `scope="..."` and `resource_metadata="..."`.
- **Do not advertise `offline_access`** in `scopes_supported` or the challenge — refresh
  tokens are not a resource requirement.
- **`MCP_PUBLIC_URL` must be a canonical resource URI**: absolute, no fragment, no trailing
  slash. Enforced at startup in `canonicalUriProblems()`.

---

## 12. Known interoperability risk: Entra and PKCE metadata

The spec is explicit:

> If the field is absent, MCP clients **MUST** refuse to proceed.
> Authorization servers providing OpenID Connect Discovery 1.0 **MUST** include
> `code_challenge_methods_supported` in their metadata to ensure MCP compatibility.

**Entra does not publish it** — verified across the `common`, `organizations`, `consumers` and a
real tenant document. It supports PKCE S256 in practice; it simply does not advertise it. Nine
of the other ten providers surveyed do publish it.

So by the letter of the spec Entra is non-conformant, and whether OAuth works against it depends
entirely on how strictly a given client reads that rule. A lenient client proceeds; a strict one
refuses. **We cannot fix this from the resource server** — it is another party's metadata
document.

This must be verified empirically against a real Entra tenant **early**, because if strict
clients refuse, it reshapes the auth story for the majority of deployments, and everything else
in Phase A is cheaper to redo than to build on the wrong assumption.

---
