<!-- SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial -->
<!-- Copyright (c) 2026 SYNERGY. All rights reserved. -->

# Impersonation

How `act_as` stops being a preference and becomes an identity Ivanti itself enforces.

## 1. What changed

Today `act_as` decides who "my" *means*. Every call still reaches Ivanti as the service account,
so the server's own guards — `identity-pin.ts`, the own-records filters, the object gate — are
the **only** thing standing between a caller and someone else's records.

CentralConfig can mint a session for a named user, and that session turns out to be a credential
for **every** Ivanti surface, not just the ASMX one:

| Surface | Credential today | With impersonation |
|---|---|---|
| OData / REST | `Authorization: rest_api_key=<key>` | `Cookie: SID=<impersonated>` — **and Ivanti scopes it** |
| `Session.asmx` | service-account SID + CSRF | impersonated SID + its own CSRF |
| `Workspace.asmx` (forms, pick lists, quick actions) | service-account SID + CSRF | **unchanged — the impersonated session is refused** |
| AdminUI (`AppDesign.asmx`) | service-account SID + CSRF | **unchanged — refused** |

**The split is the design.** A CentralConfig-minted session is accepted by OData and
`Session.asmx` and rejected with 551 by the workspace/form layer, whatever role it holds. So
impersonation covers the record surface — where Ivanti applies the person's own access — and the
form surface keeps running as the service account exactly as it does today. That is not a
limitation to work around; it is the boundary, and building anything that tries to cross it
would be building on a 551.

See `docs/notes.md` for the measured mechanics. The one that matters most is that a SID is
`<tenantId>#<sessionId>#<n>` and CentralConfig returns only the middle segment.

## 2. What does not change

**Every existing guard stays exactly where it is.** Impersonation is defence in depth, not a
replacement for the checks already in place, for one concrete reason: it is **not established
that OData scopes to the impersonated user**. An analyst's session returned the same 551 incidents
the admin key sees. That is consistent with "he may read them all" and equally consistent with
"OData ignores role scoping entirely" — and until it is measured, removing a client-side filter on
the strength of it would be trading a check that works for one that might not exist.

Concretely: `own-records-guard.test.ts` keeps forcing every tool to declare itself, the
`enduser` object gate keeps refusing, and `identity-pin.ts` keeps refusing a second, different
person. None of that is relaxed by this feature.

## 3. Configuration

Two new settings, **valid only as a pair** — the same shape as `IVANTI_BASE_URL` /
`IVANTI_API_KEY`:

| Key | Meaning |
|---|---|
| `IVANTI_CONFIG_URL` | the ConfigDB tenant, e.g. `https://config-<tenant>/` |
| `IVANTI_CENTRAL_CONFIG_API_KEY` | the key from Configure → Security Controls → API Keys, `CentralConfigApiKey` group |
| `IVANTI_CENTRAL_CONFIG_API_KEY_FILE` | the same, read from a file, resolved before schema parsing |

Two more govern which role a session opens under (§8):

| Key | Meaning |
|---|---|
| `ENDUSER_ROLE` | `enduser` mode's role, defaulting to `SelfServiceMobile`; checked against `frs_def_role` at startup |
| `IVANTI_IMPERSONATION_ROLE` | `full` mode only — pins a role instead of keeping the one Ivanti made active |

`validateConfig` rejects one without the other, the way it already does for the tenant pair.
Neither set: the server starts exactly as it does today and `act_as` keeps its current meaning.
This is the fallback the feature is specified around — it is never a hard requirement.

## 4. Startup probe

Impersonation is probed once at startup, for the same reason the capability tier is: tools and
their descriptions are selected once, so the answer has to be known before registration.

It follows the AdminUI precedent — **used when available, never required**. `Capability` gains:

```ts
/** Whether CentralConfig will mint sessions for named users. */
canImpersonate: boolean;
/** Why not, when it cannot. */
impersonationReason?: string;
```

Log lines, at startup:

- configured and working → `info` — `impersonation available`, with the ConfigDB host
- configured and refused → `warn` — `impersonation configured but unavailable`, with the reason,
  and the server continues on the existing behaviour
- not configured → `info` — `impersonation not configured; act_as decides scope only`

A failing probe **must not** fail the startup. A tenant whose ConfigDB is briefly unreachable
should serve the tool set it can serve.

## 5. Behaviour at `act_as`

When `canImpersonate` is true, `act_as` does what it does today — resolve the person against
`employee` and `externalcontact`, apply the `identity-pin.ts` rules — and then, additionally,
opens a session for the resolved `LoginID`:

1. `AuthenticateAPI?userName=<LoginID>&tenantId=<tenant>` with the `ApiKey` header
2. compose the SID as `<tenantId>#<SessionId>#1`
3. `InitializeSession` to obtain the CSRF token and read back the **actual** role
4. establish a role if none is active, and the one the mode wants if it differs (§8)
5. bind the pair to the conversation, beside the existing pin

**Only the OData/REST calls for that conversation use it.** The form and admin surfaces keep the
service-account session, because the impersonated one is refused there (§1). The session is
released on conversation end (`CentralConfig.asmx/RemoveSession`), and `SessionKeyExpire` is
honoured by re-running the handshake rather than by letting a call fail.

**A session that never got a role is never used.** It reads zero of everything, which would
otherwise surface as "you have no incidents" — a confident, wrong answer. If no role can be
established the call is refused instead, under the same rule as the next paragraph.

**On failure, the call is refused and says why** — the server does not silently fall back to the
service account, because a caller who asked to act as someone and was quietly answered as the
service account has been told something false about whose data they are reading. The refusal
distinguishes the cases that are actionable: a disabled account, an unknown login, ConfigDB
unreachable.

Both `full` and `enduser` modes use it.

### Attribution changes, and the explicit override goes away

Ivanti fills `CreatedBy`, `LastModBy` **and `Owner`** from the session. Measured on a real create
through an impersonated session: all three came back as the impersonated person. So the
`CreatedBy` override `enduser` writes currently carry is redundant — it is not sent when
impersonating, rather than sent and agreed with. One mechanism, not two racing.

**`LastModBy` proves nothing, with or without impersonation.** The same record read back seconds
later said `InternalServices`: a workflow (`TSS Incident Trigger WF`) had already touched it. The
existing design treats the mixed pair — `CreatedBy` overridden to the person, `LastModBy`
recording the account that wrote — as saying *their decision, this server's hands*. That holds
only until the first workflow fires, which on this tenant is immediately. **`CreatedBy` is the
only durable attribution field**, and this is true of today's code as much as of this feature.

So impersonation is strictly better as a record of who asked for the work, and it loses something
worth naming: **nothing in the record shows that an MCP server was involved at all**.

That matters most where the identity is weakest. Under `AUTH_MODE=oauth` the person is proven by
a token and full attribution is simply correct. Under `bearer` or `none` the identity is
`asserted` — a name someone typed — and the tenant's audit trail will nonetheless read as though
that person sat down and did it themselves. The trust decision in §6 (impersonate whenever
configured, under any auth mode) was taken before this was measured, and it carries more weight
now than it did then: the mitigation is still that `identity-pin.ts` refuses a second, different
person per conversation, so the exposure is an injection landing on the **first** `act_as`.

The audit log is where the distinction survives: every impersonated write is logged with the
subject **and its provenance**, so `verified` and `asserted` are distinguishable in this server's
own records even when they are not in Ivanti's.

## 6. Trust

Impersonation is attempted **whenever it is configured**, under every `AUTH_MODE` — `oauth`,
`bearer` and `none` alike, not only for a verified subject.

That is a deliberate widening, and the reasoning is that the mitigation is already in place:
`identity-pin.ts` refuses a *second, different* person for the life of a conversation, so a
prompt injection arriving in ticket text cannot re-point an established session. The exposure it
leaves is an injection that lands on the **first** `act_as` of a conversation, before anything is
pinned. Deployments that cannot accept that should run `AUTH_MODE=oauth`, where the claim is the
token's and a caller's argument may only choose between records the token already matched.

**Every impersonation is logged at `info`** — the subject and its provenance (`verified` vs
`asserted`), never the arguments. An asserted subject is never logged as though it were a fact.

## 7. Secrets

`AuthenticateAPI` returns the tenant's **SQL connection string, password included**, beside the
session fields. It is destructured at the transport boundary — `SessionId`, `SessionKey`,
`SessionKeyExpire`, `LoginId`, `AuthenticationStatus` — and the response is never stored,
logged or echoed whole. `scrubErrorBody` gains the CentralConfig key, the same way it already
holds the tenant API key.

## 8. Role selection

**Selecting a role is mandatory, not a refinement.** An impersonated session can arrive with an
empty `ActiveRole`, and such a session reads **nothing** — 0 incidents, 0 employees, 0 roles. It
is a broken session, not a restricted one, so a role is always established before the session is
used.

### The flag decides — there is no ranking

`Session.asmx/GetUserData` returns `userRoleList` (lower-case `u`, unlike its siblings), and each
entry carries **`SelfServiceRole`** beside `Name` and `DisplayName`. Ivanti labels its own portal
roles, so nothing has to be inferred from names or measured from workspace counts:

- **`enduser`** takes a role with `SelfServiceRole: true` — `ENDUSER_ROLE` (default
  `SelfServiceMobile`) when the person holds it, otherwise any self-service role they hold.
- **`full`** takes a role with `SelfServiceRole: false`, preferring the one Ivanti already made
  active, or `IVANTI_IMPERSONATION_ROLE` when set.

**This is why the server does not rank roles.** An earlier draft ranked them by object-workspace
count. That was wrong twice: the counts do not separate the classes (`SelfServiceMobile` carries 1
object workspace, `SelfService` carries 0, and both are self-service), and `GetRoleWorkspaces`
answers 551 on every impersonated session anyway — the measurement is unavailable exactly where it
would be used. The flag is authoritative, survives a tenant renaming its roles, and costs nothing.

**When the person holds no role of the wanted class**, the role Ivanti made active is used and a
`warn` names both what was wanted and what was opened. Nobody is locked out because an account was
never assigned a portal role, and `ENDUSER_BUSINESS_OBJECTS` still gates every object regardless.

### Two sources, because one has a hole

| Call | Returns | Works when |
|---|---|---|
| `Session.asmx/GetUserData` | `Name`, `DisplayName`, **`SelfServiceRole`** | the session has an active role |
| `FRSHEATIntegration.asmx/GetRolesForUser` | `Name`, `DisplayName` only | always, including an **empty** active role |

`GetUserData` takes `{_csrfToken, tzoffset: 0}` — without `tzoffset` it answers 500 — and it also
answers 500 when the active role is empty, which is precisely the case that needs a role chosen.
`GetRolesForUser` is the way out of that, at the cost of the flag: with no flag to read, the
configured role name is used, and failing that the first role returned.

### Selecting

**`Session.asmx/SelectRole`, taking `sRole`.** It re-points the established session — no
re-authentication, no credentials — and it is on the one ASMX service an impersonated session may
use. `FRSHEATIntegration.asmx/SetRoleForUserSession` is the wrong lever, and `Account/SelectRole`
is the signed-out MVC form needing an anti-forgery token. The role is read back from
`InitializeSession` afterwards rather than assumed.

## 9. `switch_role` — full mode only

The mode picks a role (§8), and in `full` mode the conversation may then change it.

**It is registered in `full` mode and nowhere else.** `enduser` opens the self-service role
`ENDUSER_ROLE` names and offers no way out of it — a tool that could change the role would undo
the only thing that makes that mode end-user. `selectTools()` decides this at registration, so in `enduser` the tool does not appear
in `tools/list` and cannot be called at all, which is the same shape every other narrowed tool has.

**It is bounded by Ivanti's own grant.** `SelectRole` only accepts a role the person actually
holds, and OData then applies that role's access — so the tool cannot reach anything the person
could not reach by signing in themselves. That is the whole safety argument, and it is why
a role switch needs no further gate than `act_as` already applies.

**`role` is required, and there is no listing mode.** The roles a person holds are reported in
the *responses* of `act_as` and of `switch_role` itself — "acting as Allen Cope under Admin; also
holds ServiceOwner, SelfService" — so nothing has to go and ask for them. Three reasons, and the
last is the one that decides it:

- There is no gap to fill. Impersonation only exists after `act_as` succeeds, so no state exists
  in which a caller wants the list but has not already been handed it.
- A response field costs **nothing** against the manifest budget, where a third tool does not fit
  at all and a no-argument mode still costs the sentences explaining it.
- **A dual-mode tool cannot be annotated honestly.** Listing when bare and mutating when given an
  argument forces the worse annotation — `readOnlyHint: false` — so merely *looking* at the roles
  would read as a state change to any client that gates on annotations. A required argument keeps
  this tool unambiguously a mutation. This is the same reasoning that keeps material out of
  resources: a pull nobody makes is worse than an answer that arrives when it is relevant.

So:

- selects the named role, reads it back rather than assuming it, and reports what the person holds
- a role the person does not hold is **refused and named**, never silently ignored

`act_as` must have succeeded first; without a pinned person there is no session to re-role, and
the refusal says so — which is also why `act_as` carries the role list: it is always the call that
comes first. Annotations: `readOnlyHint: false` (it changes session state),
`destructiveHint: false`, `idempotentHint: true`. It declares itself in
`own-records-guard.test.ts` as a tool that may **not** answer without an identity — there is
nothing it can usefully do before `act_as`.

### Budget

`full` measured **37,625 characters across 40 tools** against a `MANIFEST_BUDGET` of 38,000 —
**375 characters of headroom** — before this work. It now measures 37,991 across 41, leaving **9**.

The description is therefore written to roughly 350 characters and the tool fits without touching
anything else. Two notes on why nothing is being cannibalised to pay for it:

- The obvious donors are not donors. `get_service_request_parameters` (1,460) is entirely
  expression semantics, hidden parameters and section headings — material whose *absence would
  mislead*, which §"What must not move there" keeps out of resources on purpose. Resources carry
  what is expensive to repeat, not what is dangerous not to know.
- The two budgets are different kinds of thing. `DESCRIPTION_BUDGET` (2,000) tracks **real client
  truncation** — text past it never reaches the model, so raising it buys nothing. `MANIFEST_BUDGET`
  is a **self-imposed cost ceiling** ("room to say more, not room to stop thinking about it"). If
  a future tool genuinely needs more, raising that number is a decision to be argued on cost, not
  a workaround. It is not needed here.

## 10. Documentation

Impersonation changes what the product *is* for a reader, not just what it does, so several
documents carry claims that become conditionally false. They are listed here because "update the
docs" is not actionable and these are.

**`docs/handbook.html`** — the customer-facing document, generated from the guide fragment through
`wrap.py`. Edit the fragment, re-wrap, commit the output.

- §06 *The only door that carries a verified identity* and the `act_as` material: "it **only**
  decides who 'my tickets' … mean, which otherwise answer for the service account" is true
  without impersonation and false with it. Both readings have to survive, because both ship.
- §07 *What the credential can reach*: the tier table describes what the **service account**
  reaches. Impersonation adds a second axis — what the *person* reaches — and the two are not the
  same question.
- §13 *Deferred, with the condition that would change it* already carries **"How `enduser`
  answers 'my records'"**, which says the choice between a read-back scope and "a fully
  identity-backed query" is open. **This feature closes it.** That entry moves out of Deferred and
  becomes a described capability; leaving it under Deferred would say the opposite of what shipped.
- §13 roadmap chart: a bar for this work, dated like the rest.
- §05 *Environment reference* and §04 the configurator: the four new settings.
- §14 *Symptom to cause*: "can't find user name X" means **no enabled user** by that name —
  `Disabled`, which is a different field from `Status` and contradicts it.

**What must NOT change in the handbook.** "A QUICK ACTION IS RECORDED AS THE SERVICE ACCOUNT" and
the approval-voting rows stay exactly as they are. Those run through `Save.asmx`, which an
impersonated session cannot reach, so they remain service-account writes — and a reader who
concluded otherwise would be wrong in the direction that matters.

**`docs/configuration.md`** — the provider rows and the symptom→cause entry above.

**`docs/initial-design.md` §10** — the rejected-alternatives register: why role ranking was
dropped in favour of the `SelfServiceRole` flag, and why impersonation is scoped to the record
surface rather than made general.

**`README.md`** — the new example env file in the examples table.

**Tool descriptions** are documentation too, and they are budgeted: `act_as` must say what it now
does when impersonation is on, within the 375 characters `full` has spare (§9 *Budget*).

## 11. Order of work

1. Config pair, `validateConfig` rule, `.env.example`, an `examples/env` file
2. `src/ivanti/session/central-config.ts` — the client, with the SID composition and the scrub
3. Startup probe and `canImpersonate`, with the three log lines
4. `roles.ts` — the role list (`GetUserData.userRoleList`, falling back to `GetRolesForUser`),
   selection by `SelfServiceRole`, and `Session.asmx/SelectRole`
5. Per-conversation impersonated session, bound beside the pin; role always established; release on close
6. Route **OData/REST only** through it; the form and admin surfaces keep the service account
7. `switch_role`, registered in `full` only; `act_as` refusal paths, with the distinguishable reasons
   - **Double-check here:** step 5 left release-on-close proven only for the *never-opened* case.
     Opening a session needs `act_as`, so once it exists, assert end-to-end that a conversation
     which opened one has it released when the connection closes. The hook and its chaining are
     already covered; what is missing is the path that actually holds a session.
8. Tests: a tenant that refuses impersonation must leave every tool working, mirroring
   `admin-ui-guard.test.ts`; and a session that never got a role must never be used
9. Documentation (§10) — handbook fragment + re-wrap, `configuration.md`, design §10, README,
   and the `act_as` description
