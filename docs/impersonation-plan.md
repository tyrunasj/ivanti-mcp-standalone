<!-- SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial -->
<!-- Copyright (c) 2026 SYNERGY. All rights reserved. -->

# Impersonation

How `act_as` becomes an identity Ivanti itself enforces. Built and shipped; optional, and off
unless configured. Measurements behind it are in [`notes.md`](./notes.md) →
*Impersonation via CentralConfig*.

## 1. What it does

Without impersonation, `act_as` decides who "my" *means*, and every call reaches Ivanti as the
service account — so the server's own guards are the only thing between a caller and someone
else's records. With it, `act_as` also opens a CentralConfig session for the person, and that
session is a credential for every surface, which Ivanti then scopes to the person's role:

| Surface | Without impersonation | With it |
|---|---|---|
| OData / REST | `rest_api_key` | `Cookie: SID=<person>` — Ivanti applies their role |
| `Session.asmx` | service-account SID + CSRF | the person's SID + its own CSRF |
| `Workspace.asmx` — forms, pick lists, quick actions | service account | the person, **once `SelectRole` has run** |
| Service catalog and `.ashx` uploads | service account | the person — the request and its file carry their name |
| Admin console (`AppDesign.asmx`) | service account | unchanged: a tenant catalog, not a person's view |

**Every surface follows the person; only tenant facts stay behind**, each for a stated reason: the
metadata catalog (a schema, cached once), the admin catalog, the person directory (`act_as`
resolves through it — using the person's session would be circular) and the tenant UTC offset.
A SID is `<tenantId>#<sessionId>#<n>`, and CentralConfig returns only the middle segment.

## 2. What does not change

**Every existing guard stays**: `own-records-guard.test.ts`, the `enduser` object gate,
`identity-pin.ts`. Ivanti's scoping is by *role*, not by *owner* — a `SelfService` session reads
0 incidents but still reads all 628 employees and 51 roles — so the row-level "own records" guard
remains the only one of its kind. And the guards must hold regardless, because impersonation is
optional.

## 3. Configuration

| Key | Meaning |
|---|---|
| `IVANTI_CONFIG_URL` | the ConfigDB tenant, e.g. `https://config-<tenant>/` |
| `IVANTI_CENTRAL_CONFIG_API_KEY` (`_FILE`) | from Configure → Security Controls → API Keys, `CentralConfigApiKey` group |
| `ENDUSER_ROLE` | `enduser`'s role, default `SelfServiceMobile` |
| `IVANTI_IMPERSONATION_ROLE` | `full` only — pins a role instead of keeping the one Ivanti made active; refused in `enduser` |

The first two are **valid only as a pair**; `validateConfig` refuses one without the other.
With neither, the server behaves exactly as without the feature.

## 4. Startup probe

Probed once at startup, like the capability tier — tools and descriptions are selected once — and
**used when available, never required**: `Capability.canImpersonate`, with `impersonationReason`
when false. A failing probe never fails the startup. It logs `impersonation available` (info),
`… configured but unavailable` with the reason (warn), or `… not configured` (info).
`GetTenantTimeout` proves the key and reachability, not the tenant — a wrong tenant host passes
and fails at the first `act_as` (see notes).

## 5. Behaviour at `act_as`

`act_as` resolves and pins the person as always, then:

1. `AuthenticateAPI?userName=<LoginID>&tenantId=<tenant>`, with the `ApiKey` header
2. composes the SID `<tenantId>#<SessionId>#1`
3. `InitializeSession` for the CSRF token and the **actual** role
4. establishes a role — always, even the one already reported (§8)
5. binds the session to the conversation beside the pin

Every call in the conversation then uses it, through `connectionFor`. It is released when the
conversation ends — best effort: `RemoveSession` answers 200 and ends nothing, so a session lives
to the tenant timeout (18,000 s). `SessionKeyExpire` re-runs the handshake.

- **A session without a role is never used** — it reads zero of everything, which would surface as
  a confident "you have no incidents".
- **Failure is refused, with the reason** — disabled account, unknown login, ConfigDB
  unreachable. Never a silent fallback to the service account, which would misstate whose data is
  being read.

**Attribution.** Ivanti fills `CreatedBy`, `LastModBy` and `Owner` from the session, so the
`CreatedBy` override `enduser` writes carry is not sent. Two consequences: a create is owned by the
person who raised it (see `architecture.md` → *Writes*), and `LastModBy` proves nothing — a
workflow overwrites it within seconds, so **`CreatedBy` is the only durable attribution field**.
Nothing in Ivanti's record shows an MCP server was involved; this server's audit log keeps the
subject *and its provenance*, so `verified` and `asserted` stay distinguishable there.

## 6. Trust

Impersonation is attempted **whenever configured, under every `AUTH_MODE`**. Under `bearer` or
`none` the identity is an asserted name, yet Ivanti's audit trail will read as though the person
acted themselves. The mitigation is `identity-pin.ts`: a second, different person is refused for
the life of the conversation, so ticket text cannot re-point an established session. The exposure
left is an injection landing on the *first* `act_as`. Deployments that cannot accept it run
`AUTH_MODE=oauth`, where the lookup term is the token's claim. Every impersonation is logged at
info with its provenance; arguments never.

## 7. Secrets

`AuthenticateAPI` returns the tenant's SQL connection string, password included. The reply is
destructured at the transport boundary — `SessionId`, `SessionKey`, `SessionKeyExpire`, `LoginId`,
`AuthenticationStatus` — and never stored, logged or echoed. `scrubErrorBody` redacts the
CentralConfig key and both spellings, `ConnectionString` and `DBConnectionString`.

## 8. Role selection

**Mandatory, not a refinement.** A session with an empty `ActiveRole` reads nothing; a role is
always selected before use.

**Ivanti's `SelfServiceRole` flag decides; roles are never ranked** (design §10). It arrives on
`GetUserData.userRoleList`:

- **`enduser`** takes a self-service role — `ENDUSER_ROLE` if held, else any self-service role.
- **`full`** takes a non-self-service role — the one Ivanti made active, or
  `IVANTI_IMPERSONATION_ROLE`.

With no role of the wanted class, the active role is used and a warning names both.

| Source | Returns | Works when |
|---|---|---|
| `Session.asmx/GetUserData` (`{_csrfToken, tzoffset: 0}`) | names **and** `SelfServiceRole` | the session has an active role |
| `FRSHEATIntegration.asmx/GetRolesForUser` | names only | always |

`GetUserData` answers 500 without `tzoffset`, with no active role, and permanently for some
accounts. Without the flag, the configured role is used, else the first `GetRolesForUser` lists —
alphabetical, so `Admin` wins by accident, not policy. The `act_as` reply says so, and
`IVANTI_IMPERSONATION_ROLE` decides it explicitly.

**Selecting is `Session.asmx/SelectRole` (`sRole`)** — no re-authentication; the role is read back
from `InitializeSession` afterwards. Not `SetRoleForUserSession`, and not `Account/SelectRole`
(the signed-out MVC form).

## 9. `switch_role` — `full` mode only

- **Registered only in `full`.** `enduser` keeps the self-service role; a tool that changed it would
  undo what makes the mode end-user.
- **Bounded by Ivanti's own grant.** `SelectRole` accepts only a role the person holds and OData
  applies that role, so nothing is reachable that the person could not reach signing in. That is
  the whole safety argument.
- **`role` is required; there is no listing mode.** `act_as` and `switch_role` report the roles held
  in their replies, a response field costs no manifest budget, and a list-or-mutate tool could not
  be annotated honestly — merely looking would read as a state change.
- A role not held is refused and named. `act_as` must have succeeded first. Annotations:
  `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`.
