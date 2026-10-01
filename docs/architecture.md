# Architecture — how the server works, and why

The reasoning behind the rules in `CLAUDE.md`, grouped by topic. Decisions and rejected
alternatives are in [`initial-design.md`](./initial-design.md); traps, with their measurements,
are in [`notes.md`](./notes.md). The directory map is in `CLAUDE.md`.

1. [Layout and composition](#layout-and-composition)
2. [Scope](#scope)
3. [The Ivanti session and capability tiers](#the-ivanti-session-and-capability-tiers)
4. [Reading from Ivanti](#reading-from-ivanti)
5. [Identity and the gate](#identity-and-the-gate)
6. [Audience modes and allowlists](#audience-modes-and-allowlists)
7. [Writes](#writes)
8. [Service requests and approvals](#service-requests-and-approvals)
9. [Transports and auth](#transports-and-auth)
10. [The manifest, resources and instructions](#the-manifest-resources-and-instructions)
11. [Server lifecycle](#server-lifecycle)
12. [Invariants, in full](#invariants-in-full)

## Layout and composition

- **Composition runs one way:** `index.ts` loads config, builds the server, picks a transport.
  Nothing below it reads `process.env`.
- **`tools/` is the tuned surface** — descriptions, arguments, annotations — so it sits at the top
  of `src/`. It never builds a URL or parses a response; that is `ivanti/`, which knows nothing
  about MCP.
- **One reason to change per file**, tests beside it (`foo.ts` / `foo.test.ts`).
- **Config loads in three phases, in this order:** secrets (`*_FILE` → value), then shape
  (`env-schema.ts`, *what a setting is*), then rules (`validate-config.ts`, *which combinations
  are allowed*). "Bearer mode needs a token" cannot be judged before the secret file is read. The
  rules also get the names the environment actually set, because a setting the mode ignores
  (`ENDUSER_*` under `full`) cannot otherwise be told from a default — and "set, but ignored" is
  the mistake worth refusing.

## Scope

41 tools in `full`, 34 in `enduser`, and six reference documents served as MCP resources.
`switch_role` registers in `full` regardless of tier, with a refusal that tells "this deployment
opens no Ivanti sessions" apart from "nobody is acted for yet". What remains is A4's Entra row — a
deployment prerequisite, not code.

## The Ivanti session and capability tiers

**Two authentication protocols, not one header.** OData and REST take
`Authorization: rest_api_key=<key>` (equals sign). The ASMX services take a SID cookie plus a CSRF
token from a three-step handshake — `AuthenticateTenantAPIKey` → SID, `InitializeSession` → CSRF
and active role, `GetUserData` → display name. It lives in `src/ivanti/session/`, never sends the
key as a header, is shared by concurrent callers, and re-runs once on a 401.

**The capability tier decides what the credential reaches**, probed once at startup because tools
are selected once:

| Tier | The credential | Adds |
|---|---|---|
| `odata` | the API key alone | every read tool; ~194 objects from metadata graphs |
| `session` | the ASMX handshake opens | the identity, and the role's own workspaces |
| `admin` | the admin console answers too | the complete catalog — 1,324 objects with descriptions |

Higher tiers only add. A lower tier is not a failure — refusing to start would punish exactly the
customers who cannot issue an admin key. `get_pick_list_values` is the first tool the tier gates:
it needs a create form, which OData cannot see.

- **`IVANTI_MAX_TIER` caps the server below the credential**, because the degraded paths cannot
  otherwise be exercised: `AuthenticateTenantAPIKey`'s `role` argument is a *request* that
  silently downgrades — an admin asked for `SelfService` still answers `Admin`. The effective role
  is always read back from `InitializeSession`, refined by `GetUserData`.
- **`/HEAT/AdminUI/` is used when available, never required.** The path needs `services/`
  (`/HEAT/AdminUI/services/AppDesign.asmx/…`) — without it Ivanti answers 404, which reads as
  "no admin console". `admin-ui-guard.test.ts` drives every tool over a tenant whose console
  refuses and asserts none fails or requests that path.
- **The base path is probed, not configured.** `connectIvanti()` walks `/HEAT` or root ×
  `incidents/$metadata`, service root, `businessobject/$metadata`, keeping the first that answers
  with CSDL — on a live tenant only the entity-scoped graph exists. A 200 carrying a login page is
  rejected, or the wrong base path reads as an auth failure forever. Ask for XML:
  `Accept: application/json` on `$metadata` answers 500.
- **`IVANTI_BASE_URL` and `IVANTI_API_KEY(_FILE)` are optional, but only together.** With neither,
  the server starts and warns; a configured tenant that cannot be reached fails the startup.

## Reading from Ivanti

- **`src/ivanti/http/transport.ts` is the `rest_api_key` surface** — OData, REST, `$metadata`. The
  ASMX surface has its own credential and lifecycle; keeping them apart stops a caller reaching
  for the wrong one. Both send through `exchange()`, which is what they share: the timeout, the
  error shape, the scrubbing and the request log. The timeout is chosen by method —
  `IVANTI_TIMEOUT_MS` for a GET, `IVANTI_WRITE_TIMEOUT_MS` for anything else, ASMX and the
  impersonation handshake included, because both are POSTs end to end. A write that gets no answer
  — status 0, or a gateway's 502 or 504 — is told to the model as *possibly applied*, never as
  refused: a timeout on a create is the commonest way to file a ticket twice. A request Ivanti never
  answered carries the code from undici's `cause` chain (`ENOTFOUND`, `ECONNRESET`, a certificate
  error), since `fetch failed` alone makes a DNS typo, a firewall and a proxy's certificate read
  alike.
- **Downloads are capped before and during the fetch.** Ivanti serves a file whole or not at all,
  so `download_attachment` judges the row's name and `AttachmentSize` before asking for any bytes,
  and `requestBinary` stops reading at a byte cap (`Content-Length` first, then the stream) with a
  `ResponseTooLargeError` — Ivanti answered, so it is not an `IvantiApiError`.
- **Every collection read goes through `readCollection()`.** "No rows" has three encodings: a
  filter matching nothing answers 200 with an empty body, an empty navigation property answers
  `{"value": "No instances found."}` — a string with `.length === 19` — and only rows arrive as an
  array. Any other prose in `value` is an error, not an empty result.
- **Objects resolve through the metadata catalog, never by string conversion.** `resolveObject()`
  turns a wrong name into an error with suggestions, where Ivanti answers an empty result. An
  unknown entity set makes Ivanti *fabricate* a field-less entity type, so a schema with no fields
  is a typo. Each graph is cached for the life of the process, and only that fabricated CSDL is
  cached as an answer: a timeout, a 5xx, or a page that is not CSDL at all (a WAF, a login) is asked
  again, or one bad moment makes `Incidents` unknown until a restart.
- **A refusal is where a name is taught.** `suggestNames` ranks a name that contains the guess,
  then one the guess contains (at least half of it), then a typo — one slip under five letters,
  two above — so `Incidnet` reaches `incident` and `Stauts` reaches `Status`. The short `object`
  description (`OBJECT_ARGUMENT`) leans on this: it says which spellings work, and the refusal
  says the rest at the moment it is needed.
- **Rows default to a compact field set, and it is a preference.** A default page of whole records
  measured 187,278 characters. Tenants rename fields, so `compactFieldsFor` falls back to the row's
  own leading fields and says so; CSDL cannot help (it marks almost nothing required) and grid
  columns are unreachable.
- **Projection is client-side.** `$select` on a single-record GET returns no fields at all and
  blanks saved-search values; `$expand` is silently ignored under API-key auth. So `buildQuery` has
  neither — use `get_related_records`.
- **Ivanti answers errors as successes, so some requests are refused locally.** Get-by-key answers
  `400 ISM_4000 "Invalid key"` for a missing record (`isIvantiNotFound()` owns that dialect);
  `contains()` and friends are silently dropped and the whole set returned
  (`assertSupportedFilter`, which also refuses unbalanced parentheses and an unterminated string,
  in every mode — Ivanti's `$filter` does not follow OData's `and`-before-`or`, and answered some
  unbalanced shapes with wrong counts); a bad `$orderby` answers 204, reading as "no rows"
  (`assertOrderBy`).

## Identity and the gate

- **`act_as` says who the conversation is helping; nothing else answers until it has.** One call
  per conversation, not an argument on every tool — which would fail silently the first time the
  model forgot it. It matches `LoginID`, `PrimaryEmail`, and `FirstName` + `LastName` across
  `employee` and `externalcontact`, never the assembled `DisplayName` ("John M Doe"). Ivanti's
  keyword search over-matches (`"John"` returns Scott Johnson), so candidates are re-filtered on
  whole tokens. `Terminated` is refused; `New` and `On Leave` pin with a flag. The provenance stays
  `asserted` — resolving a claim does not verify it.
- **The gate is in `registerTools` and covers every tool but `act_as`, in both modes.** It decides
  *whether the conversation may answer*, not whose records it may read: an IT agent pins
  themselves and works the whole queue. `get_version` is gated too. The only exception is a
  deployment with no tenant, where `act_as` is not registered. One place, because a tool that
  forgot would not fail — it would answer.
- **A signed-in conversation pins itself lazily**, on the first call that needs it, by running
  `act_as`'s own handler with the token's claim — not at `initialize`, where a slow tenant would
  fail the connection. A verified claim matching nobody is logged at warn; an unverified one never.
  A failed attempt is not remembered — a transient 5xx cached there was replayed on every call —
  while a question (which of these records is yours) stands until it is answered.
- **A conversation ends on silence or a fresh `initialize`** — `MCP_IDENTITY_IDLE_TTL_SECONDS`,
  default 1800. A stdio process otherwise carried one person's pin into every later conversation.
  Neither signal is reachable by the model: a tool that ended a conversation could shed the pin,
  and time is the one thing injected ticket text cannot forge. Ending one always releases the
  impersonation slot, even with nobody pinned, and the slot carries a generation, so a handshake
  still in flight lands nowhere. A call running at that moment keeps the Ivanti session it started
  on — the emptied slot would have sent its remaining requests, writes included, as the service
  account — and its result is discarded; a write's discard says the change may already be made.
- **Identity is threaded, never reached for.** `CallerIdentity` carries a provenance —
  `anonymous`, `asserted`, `verified` — and arrives as a handler's second argument, bound per
  session. `get_version` reports the provenance, never the person: that would be an identity oracle.
- **`identity-pin.ts` holds design §5's rules.** A verified session refuses any claim. An
  unverified one pins the first person it resolves and refuses a later, different one — ticket text
  can tell a conversation to become someone else. Another verified subject on the same HTTP session
  gets 403. The pin is a per-connection object, so stdio is covered by the same mechanism.
- **On a verified session the lookup term is the token's claim** (`OAUTH_IDENTITY_CLAIM`, default
  a probe order: Entra sends `preferred_username` or `upn`, most others `email`). `email` counts
  only with `email_verified` — some IdPs let a user set their own address, and the exact match
  would pin them as the colleague they typed. An exact match pins silently; anything less asks for
  confirmation and shows what matched what.
- **The field tying a record to a person is discovered.** Incidents use `ProfileLink`, service
  requests add `AlternateContactLink`, changes use `RequestorLink`. `customer-link.ts` samples rows
  to see which `*_Category` holds a person, and reads its spelling there (`Employee`, where CSDL
  says `employee`).
- **Own records: three shapes, one guard.** A filtering tool gets the constraint folded in — the
  caller's filter parenthesised first, and checked for balance *before* it is wrapped, because
  `A) or (B` wrapped is `(A) or (B) and mine`, which balances. A tool naming one record reads it and
  refuses. Related rows are checked twice: the parent, then each row — the caller's own where the
  target has a person link, else only rows whose `ParentLink_RecID` is the parent, else refused;
  the journal is refused in `enduser` in favour of `list_notes`. The refusal
  — *"No such record is available to you."* — is the same for missing and someone else's, or
  sequential numbers become an enumeration oracle. `own-records-guard.test.ts` makes every tool
  declare whether it may answer without an identity.
- **Every call is audited in `registerTools`:** tool, session, provenance, and the subject only
  when an issuer vouched for it. Argument values are never logged, bar a write's `targets` — the
  object, the relationship and every `…Id` argument, identifiers rather than ticket text — so "who
  deleted incident X" has an answer.

## Audience modes and allowlists

| | `full` | `enduser` |
|---|---|---|
| Audience | IT staff | employees |
| Business Objects | all the credential can see | `ENDUSER_BUSINESS_OBJECTS` — a gate; empty means none |
| `act_as` | required; decides who "my" means | required; decides whose records these are |
| Records | anyone's | own records only |
| Quick actions | everything the role offers | `ENDUSER_QUICK_ACTIONS`, by name, on own open records |
| Ivanti role, when impersonating | the active one or `IVANTI_IMPERSONATION_ROLE`; `switch_role` changes it | `ENDUSER_ROLE` (default `SelfServiceMobile`), fixed |

- **Two modes, fixed at startup.** `MCP_MODE=full` (IT staff) or `enduser`. `selectTools()` narrows
  at registration, so an unregistered tool is not in `tools/list` at all. `full` is the default and
  ignores every `ENDUSER_*` setting, so one set under `full` refuses to start: an employee
  deployment that forgot the mode would otherwise serve the IT-staff surface.
- **`ENDUSER_BUSINESS_OBJECTS` is a gate, not a hint.** `createObjectGate` is built once; every
  object-taking tool passes through it, and `resolveObject` refuses before resolving, so a gated
  object is not even confirmed to exist. It narrows the catalog, cross-object search, assigned
  work, `fetch` ids, attachments by parent category, and the service-request tools (`ServiceReq`).
  Refusals name what *is* allowed, or a model retries with a synonym. `full` gets `OPEN_GATE`.
- **The gate checks what a relationship reaches.** `get_related_records` once gated only its
  source, so an allowed incident led to the owning analyst's employee record.
- **Quick actions are gated by name.** `ENDUSER_QUICK_ACTIONS` lists the tenant's own action names
  ("Close From Self Service"), runnable only on the caller's own open record; empty means none.
  The server never pattern-matches names — dedicated `close_ticket` / `reopen_ticket` tools had to
  guess among 104 actions and were removed.
- **Row-level audiences need their own tool.** A knowledge article is internal unless `Published`;
  a note is internal unless `PublishToWeb`. `search_knowledge` and `list_notes` own those filters,
  and neither object is allowlisted, so no other path reaches them.
- **A note is `journal__notes`, the extension of the group object `Journal`.** The extension sets
  `JournalType` itself and has a real `NotesBody`; reading through the group returns Ivanti's own
  email traffic instead.

## Writes

- **Every write resolves, then verifies.** `resolveValidatedWrite` turns a picklist value into the
  value *plus its option's RecId* — a value written alone can be stored as nothing — and refuses
  one that is not on the list. `confirmWrite` reads the record back before success is reported —
  every written scalar, not only the validated ones, compared after normalising dates, numbers,
  booleans, case, spacing and HTML entities. A free field that did not take fails the write like a
  validated one. Ivanti's own stamps (`LastModBy`, `CreatedBy` and their times) go in
  `ignoredByIvanti`; rich text and anything the read does not return go in `notConfirmed`.
  The form, not `$metadata`, is the authority on what is validated (Task's CSDL declares none; its
  form declares twenty).
- **Field names are checked before the write** by `knownFields`, against the schema already
  fetched, and every written name is settled to the schema's spelling before anything else reads
  it — the pick-list resolver is case-sensitive, so `status` once skipped it and the read-back
  both. Two spellings of one field are refused. In `enduser`, the customer-link pair, the bare
  link and `CreatedBy` are never a write's to set. A tenant *label* gets the field it labels (`Description` → write `Symptom`); anything
  else gets the nearest fields, by containment then edit distance (`Sympton`). It never refuses on
  an empty schema — the object name is the real error there.
- **A field has three names**, resolved in order: the form's label, the object's display name, the
  technical name (`fieldLabels` in `form-context.ts`). All per object and per form: `ProfileLink` is
  "Customer" on an incident and "Contact Link" on a service request.
- **The form's required and read-only rules are conditional.** `BusObjectRequiredRules` and
  `BusObjectReadOnlyRules` list the fields a rule *governs*, never the condition, so
  `get_object_metadata` flags both with a `?` (`required?`, `readOnly?`); the schema's own
  `nullable: false` stays a plain `required`. Never refuse on them: a guard built on the read-only list refused a correct
  create (a problem's `Category`, which is mandatory). An incident reaches `Logged` with nothing and
  `Active` only with Category, Owner and Team — and a refusal names only what Ivanti checked before
  stopping, so it carries the rest of the governed list.
- **Ivanti fills the assignment from the signed-in session.** Impersonated, a create comes back
  owned by the person it was raised for, in their team; `create_record` names every field stamped
  this way (`session-stamp.ts`) but does not correct it. `CreatedBy` accepts an override and keeps
  it; `LastModBy` does not. With the ConfigDB pair, `act_as` opens Ivanti's own session and every
  write carries the person's name because Ivanti filled it. That session is re-opened once for the
  same person on a 401 **on the person's own credential** or past its `SessionKeyExpire` — a read
  is retried, a write is reported as not repeated — and never falls back to the service account.
  Every `IvantiApiError` carries the `credential` its request was sent with (`service`, or `person`
  for a SID transport and the person's ASMX session), so a 401 on the service account's own calls —
  schema, directory, the tenant's offset — leaves the person's session alone. `IVANTI_IMPERSONATION_REQUIRED`
  makes a failed startup probe fatal instead of a warning.
- **A closed record is read-only, and only this server enforces it.** Ivanti sets `ReadOnly: true`
  and then accepts a PATCH. `assertRecordWritable` guards every write to an existing record.
  `IsInFinalState` does not work — it is false on closed records.
- **Refusals speak display names.** `Incident.Description` means `Symptom`; `Incident.Customer` is
  the link pair `ProfileLink_RecID` + `ProfileLink_Category`. `explain-required-fields.ts`
  translates both through the form.
- **Quick actions preview through the form path only.** `SaveDataExecuteAction` ignores
  `shouldSave: false` on `GridParams` — a "preview" there runs the action. `execute.ts` never builds
  `GridParams`; `preview_quick_action` refuses where the role has no form. `run_quick_action`
  probes again itself and is the one tool both destructive and non-idempotent. Failure is in
  `validationErrors[recId].fieldErrors[field].fieldMessages[]`, not `status`.
- **Linking and unlinking check the link first.** Ivanti accepts an unlink of nothing and, on a
  Contains relationship, severs the target from its real parent. `link_records` reads the target's
  `ParentLink_RecID` on a Contains relationship and refuses to move a child off another parent,
  answers `alreadyLinked` for a no-op, and reads the child back after linking.
- **An attachment contains the pointer to its ticket.** `IncidentContainsAttachment` is a view over
  the attachment's `ParentLink` pair, so unlinking one orphans the file. Attach with the upload;
  detach with `delete_attachment`. Uploading is two halves and Ivanti does one — the bytes land with
  a null parent, and a nonexistent parent is accepted — so the parent is read first, linked after
  (`ParentLink_Category` as the AdminUI id, `Incident#`), and the row read back. A delete answers 204 for an id that never existed, so existence is checked on both sides.
  `upload_attachment` takes base64 capped at 2 MB, because the bytes cross the context twice.
  `add_note` reads its parent first on the same reasoning, and reads the note back.
- **A validated field's values live on a create form**, reached workspace → layout → view → form
  (cached per object), then `GetFormValidationListData`. Rows arrive as columns: the value is at the
  lowest `FieldMap` index. Some lists cascade; a parent under a name the form lacks filters nothing,
  and the tool says so.

## Service requests and approvals

- **A submit is refused inside a 200** — `{IsSuccess: false, ErrorText}` — naming one missing
  parameter at a time. A combo needs its option's RecId as a sibling key (`par-<id>-recId`); a
  checkbox stores only `'true'`. An offering has two ids — `subscriptionId` submits, `templateId`
  reads parameters — and mixing two offerings' ids files a request with no answers, reported as
  success. Every submit is read back and compared.
- **Dates need the tenant's UTC offset negated, and the sign is destructive.** On UTC+2, `-120`
  stored the value, `0` the previous day, and `+120` year 0001 — while reporting success. The
  offset comes from the newest rendered record; an old one is a daylight-saving change behind. Both
  submit paths send it (`localOffset` on the ASMX one). A `time` answer is stored as an instant on
  the day of submission, so it is compared as the wall clock that instant shows in the tenant's
  frame — compared as a date, a correct submit read as `storedDifferently`.
- **Files are staged before the request exists, inside the submit.** `GetPackageDataSDA` →
  `GetUploadTicket` → multipart `UploadAttachmentHandler.ashx`, then an ASMX submit — the only path
  that binds them (REST drops an `attachments` field). A staging id is one-shot, so nothing reuses it.
- **Approvals are read by `list_approvals` and cast by `vote_on_approval`, only on the vote row.**
  `list_approvals` reads `frs_approvalvotetracking` rows whose `Owner` is the pinned person's login
  or display name, or whose `Owner_Valid` is their RecId.
  `vote_on_approval` runs `Approve Vote` / `Deny Vote` on such a row and refuses any row the pinned
  person does not own — that check is the whole safety argument. `Owner_Valid`, when present, alone
  decides whose row it is (`vote-owner.ts`): `Owner` holds a display name on some rows, and two
  people share one. `list_approvals` drops the other person's rows the same way. A vote is read
  back against the decision made, and a failed vote takes its `Reason` off again. Never "Approve My Vote" on the
  approval: "my" is the session, and an admin key's override sibling bypasses the real approver.
  Without impersonation `VotedBy` records the service account; with it, the person. A raw status
  update is not a vote — the workflow never runs.

## Transports and auth

- **Transport and auth are separate axes, and every mismatch fails closed.** `STDIO_TRANSPORT_ON`
  (default on) and `HTTP_TRANSPORT_ON` (default off) are independent; both on gives each its own
  `McpServer`. `AUTH_MODE` applies only to HTTP: HTTP without it refuses to start, it without HTTP
  is an error, and both transports off is refused. mTLS belongs at the TLS-terminating proxy.
- **OAuth is `src/auth/oauth/`, on `node:http`** — token verification (jose, JWKS), AS discovery,
  the RFC 9728 document, the `WWW-Authenticate` challenge. `express` is not a dependency.
- **JWKS only; introspection is deferred** (design §9c, §10): `jwks_uri` is universal, introspection
  absent on 4 of 10 IdPs including Entra. Adding it is additive behind `TokenVerifier`. jose's
  cache refetches on an unknown `kid`, but past ten minutes a failed reload throws although the
  keys in hand still verify, so `createRemoteKeyResolver` falls back to the last good set and backs
  off between attempts: an IdP outage is a warn line, not a 503 on every request.
- **A URL that carries a credential or decides trust is https**, a loopback host excepted —
  `IVANTI_BASE_URL`, `IVANTI_CONFIG_URL`, `OAUTH_ISSUER` and `OAUTH_JWKS_URI` in `validateConfig`, a
  discovered `jwks_uri` where it is discovered, because no operator ever looked at that one.
- **`AUTH_MODE=none` on a non-loopback bind is warned, not refused.** Inside a container `0.0.0.0`
  is the ordinary bind, and whether that reaches a network is decided by how the port is published,
  which this process cannot see. A bearer token under 32 characters *is* refused: it is the whole
  door.
- **Assume no Dynamic Client Registration** — half the surveyed IdPs lack it, so a pre-registered
  client is the default path.
- **`OAUTH_AUDIENCE` defaults to `MCP_PUBLIC_URL` but is not it.** No mainstream IdP mints `aud`
  from RFC 8707's `resource` (Zitadel: a project id; Entra: an App ID URI); validation is membership
  in `aud`. This server never mints tokens, serves no `/register`, and never mounts the SDK's
  `mcpAuthRouter` or `proxyProvider` — that is the authorization-server half (design §11).

## The manifest, resources and instructions

- **Clients truncate a tool description silently, from the end, at ~2 KiB** — where the warnings
  sit. `description-budget.test.ts` caps each description at 2,000, the manifest at 38,000 and the
  instructions at 2,000. `pnpm budget` prints the current figures. The widest manifest is the one
  *without* impersonation (`act_as` and `run_quick_action` say less when Ivanti stamps the person);
  the widest instructions are `full` / `odata`, because that tier adds a sentence.
- **Descriptions carry what is dangerous not to know; resources carry what is expensive to
  repeat.** Six documents under `ivanti://reference/` — `entity-naming`, `field-names`, `queries`,
  `write-recipes`, `picklists` (session tier) and `workflow` (full + session) — are built once and
  cost nothing until read. A resource is a pull many clients never make, so anything whose absence
  would *mislead* stays in the description.
- **Resources answer the same identity gate** — `registerTools` publishes `mayAnswer` and
  `registerResources` uses it. The refusal is served *as the document*, because clients read every
  resource at connect time. **They narrow like tools**: `resources.test.ts` fails if a document
  names a tool its deployment does not register.
- **The manifest is tested by driving it, not reading it.** Six agents with no access to the source
  found two access holes, a wrong error gloss, a verifier calling a correct write a mismatch, and
  the sentence "an empty result genuinely means no match" (a keyword search finds none of 344 PNGs).
  Re-run the exercise after any significant change to the tool surface.
- **The server's `instructions` carry the identity and the one narration rule**
  (`src/server/instructions.ts`). The identity: this process signs in as one account, so "for the
  current user" means that account. Under `oauth` the model is not told to ask who it is helping —
  the gate pins from the token, and asking cost a turn of every conversation — only to ask when a
  tool does. `instructions.test.ts` keeps that text no longer than the default, which is the one
  the budget measures. The rule: answer in the tenant's words — a record by number and
  title, a field by the ladder form label → display name → key (the key is the last rung, not a
  forbidden one; at `odata` tier it is the only one), a person by display name (login or email only
  to tell two apart), and never a tool name. It is said once because the manifest has no room to
  say it 41 times.
- **`get_object_metadata` makes the rule followable.** It returns each field's `label` (when it
  differs from the name) and searches on it, so "Customer" finds `ProfileLink`, plus the rule
  flags. Resolved on the caller's connection — a form belongs to the role — and it never throws:
  the fields are the answer.
- **Its fields are table rows, `name|type|label|flags`**, with a one-line legend beside them, and
  each link — `X`, `X_RecID`, `X_Category`, recognised by shape — folded into one `link` row that
  keeps the label and flags of all three and answers a search for any of them. It was the dearest
  result the server returned, and a result rides along on every later request; the same keys on
  every field, and every link three times over, were most of it (`field-table.ts`).
- **Every JSON result is compact** (`jsonResult`). Indentation was a third of every result's
  characters, and the reader is a model.

## Server lifecycle

- **The version comes from `package.json`.** `src/version.ts` resolves `../package.json`, so it
  stays at the root of `src/`; the image copies `package.json` next to `dist/`. A missing manifest
  fails the startup rather than reporting a placeholder.
- **Tool definitions are built once; servers are per connection.** `createServerFactory` calls
  `selectTools()` at startup and hands out an `McpServer` per connection — the SDK refuses to
  connect one to two transports — while `registerTool` stores config by reference, so every zod
  schema exists once.
- **HTTP sessions are per client and in memory.** Each `initialize` gets its own transport and
  server. `SessionStore` caps them (`MCP_MAX_SESSIONS`) and sweeps idle ones
  (`MCP_SESSION_IDLE_TTL_SECONDS`) — required, because `onsessionclosed` fires only on an explicit
  DELETE, which clients rarely send. At the cap, `initialize` closes the least recently used
  session that has been quiet for 60 s with nothing in flight (an open SSE stream counts); 503 only
  when none qualifies, with a `Retry-After` saying when one could. Slots are reserved at admission,
  so concurrent initializes cannot overshoot. Under oauth, `MCP_MAX_SESSIONS_PER_SUBJECT` closes
  the subject's own least recently used session. **One replica**: `initialize` carries no session
  id, so no hash can route a session back to the pod that minted it.
- **`/health` is alive; `/ready` is able to serve.** `/health` answers 200 while the process runs —
  a liveness probe that restarted the pod over a tenant outage would fix nothing. `/ready`
  (`server/http/readiness.ts`) answers from the last background check of the tenant: the
  `$metadata` document startup settled on, through the transport, every 60 s
  (`ivanti/check-tenant.ts`). 503 after two failures in a row, 200 on the first success; checked in
  the background because a probe gets seconds and an Ivanti request can take longer. Both answer
  anyone; the reason and time only to an authorized caller. No Ivanti configured, always ready.
- **The tenant is the ceiling, so it is what is protected.** Every exchange context — the
  transport, the ASMX session, CentralConfig and each person's session — shares one
  `RequestLimiter` (`IVANTI_MAX_CONCURRENT_REQUESTS`, default 16), inside `exchange()` so nothing
  can go around it. Past the cap a request waits its turn, for as long as its own timeout, and one
  still waiting fails as `IvantiBusyError` — never sent, so `runTool` says nothing changed, where a
  status-0 `IvantiApiError` on a write would have said it may have been applied. Separately, each
  conversation may make `MCP_MAX_CALLS_PER_MINUTE` tool calls (default 120); the next is refused
  in `registerTools`, before the gate, with how long to wait.
- **Shutdown hands every Ivanti session back before exiting.** SIGTERM and SIGINT close every
  conversation on both transports, and so does stdin ending when HTTP is off — a container's stdin
  ends at once, so there it means nothing. Closing is what releases the person's session, and the
  SDK's `close()` resolves before that release does, so the factory's `close` returns the release
  and shutdown awaits it (and any eviction still closing), bounded at 8 s — under Docker's 10 s
  grace. `listening on http` is logged once the port is bound, and a bind failure names the
  setting that fixes it.
- **Node's HTTP timeouts are set for a proxy in front.** `keepAliveTimeout` 65 s outlasts the 60 s
  an ALB or nginx keeps an idle upstream connection (Node's 5 s default meant sporadic 502s);
  `headersTimeout` sits above it; `requestTimeout` bounds receiving a request, never the answer.

## Logging

- **Every Ivanti request goes through `exchange()`** (`src/ivanti/http/exchange.ts`) — OData, REST,
  ASMX, the `.ashx` handlers and CentralConfig alike — and is one debug line: method, path, the
  decoded query, a write's field names (never its values), status and duration. A failure adds the
  scrubbed error body; a request Ivanti never answered is `status: 0` with the reason. Every failure
  it throws is an `IvantiApiError`, so an Ivanti outage is never reported as a bug in this server.
- **Every line a tool call causes carries `tool`, `sessionId` and `rpcId`** — `registerTools` runs
  each call inside `withLogContext`, and the async context reaches the Ivanti layer without anything
  threading it through.
- **Each level has one job:**

  | Level | Carries |
  |---|---|
  | `debug` | every Ivanti request with its query, Ivanti error bodies, refusals, MCP request lines |
  | `info` | lifecycle, the `tool called` audit line, the `tool finished` usage line, writes, identity changes |
  | `warn` | running degraded — a lower tier, an unreachable tenant (status 0, 5xx) or a refused credential (401), IdP keys that could not be refreshed, a person's session that could not be re-opened, a full session cap, a rejected origin or token, an MCP protocol error |
  | `error` | faults in this server, with the stack — an unexpected exception, an unhandled rejection, a write that did not store, an orphaned attachment |

  An Ivanti 4xx other than 401 is debug: the model already has the explanation, and the mistake
  was its own. A protocol error is warn rather than error because clients cause most of them.
- **Every call ends in one `tool finished` line** — `outcome` (the refusal's class, `ivanti <status>`,
  `fault`, or `ok`), sizes, a salted `argsHash`, `rowsRead`, `ivantiRequests`, `ms`, and the
  `conversation`, `client` and `manifest` fingerprint it belongs to. Sizes and markers, never
  content. The tally reaches `exchange()`, `readRows()` and `runTool` through `withCallUsage`, the
  same async-context route the log fields take. [`usage.md`](./usage.md) is how to read it.
- **Errors are passed as fields, not flattened into strings.** The logger writes an `Error` with its
  name, message and stack, and an `IvantiApiError` by its `toJSON` — path, never URL.

## Invariants, in full

- **Never write to stdout.** Under stdio it is the JSON-RPC stream; log to stderr via `createLogger`.
- **Never report success from a 200.** See *Reading from Ivanti*, *Writes* and *Service requests*:
  every write is read back.
- **`MCP_PUBLIC_URL` is required and never derived from the request.** A reverse proxy rewrites Host
  and scheme, but RFC 9728 metadata and token audiences must match the external URL exactly.
- **Origin validation on every HTTP mode** — invalid Origin answers 403. It is what stops DNS
  rebinding from a page the user merely visits.
- **New config keys fail closed.** A mode that needs a setting gets a rule in `validateConfig`.
  Settings naming tenant things are also resolved at startup — a misspelled
  `ENDUSER_BUSINESS_OBJECTS` entry exits 78 with suggestions rather than silently narrowing.
- **Annotate every tool explicitly.** Unannotated means destructive and open-world. Reads get
  `readOnlyHint` / `idempotentHint`; additive writes set `destructiveHint: false`; tools returning
  ticket text keep `openWorldHint: true` — it is untrusted content.
- **Scrub Ivanti error bodies** (`scrubErrorBody`, in `exchange()` — the one place that knows every
  credential a request carries: the key, or a person's SID). Ivanti echoes submitted values and the
  ASMX session sends the key in the body, so the credentials and named session fields (`SessionId`,
  `TenantId`, `LoginId`, `ConnectionString`…) are redacted however their quotes arrived — escaped
  at any depth, as an HTML entity (Ivanti's OData 500s are entity-encoded) or a unicode escape — and
  as XML elements for CentralConfig. The delimiter is a class, not a list of spellings. Never a
  generic "key-shaped" pass — it would eat the RecIds the model needs.
- **Only debug carries the query** — a `$filter` routinely holds a person's name, so `debug` is
  personal data and every level above it logs the path alone. A write's values (ticket text) are
  logged at no level; its field names are.
- **Allowlists key on the technical Business Object name**; display names are per tenant.
- **Nothing may depend on the Business Objects Ivanti ships.** Tenants add, rename and remove
  fields and write their own quick actions, so a fixed name list is a preference with a fallback:
  `record-identity` reads the row when its lists miss, `list_notes` finds the journal relationship
  in metadata, `get_link_fields` reports the `_Category` observed on real rows. A name in a
  description is an illustration, and says so.
- **Refuse locally where Ivanti would answer wrongly with success** — `assertSupportedFilter`,
  `assertOrderBy`, `knownFields`, `assertRecordWritable`, and closed tool arguments.
- **A write's field names are checked and settled to the schema's spelling before it is sent**
  (`knownFields`). Everything after — the form's validated fields, the pick-list resolver, the
  read-back — looks names up exactly, so a name that passed a case-insensitive check in the
  caller's spelling skipped all three and reported success. See *Writes*.
- **Tool arguments are closed.** Zod strips unknown keys and the SDK hands the handler the parsed
  value, so `orderby` for `orderBy` silently returned unsorted rows. `strictInput` in `defineTool`
  closes every shape (`z.strictObject(shape, { error })` — `.strict()` ignores its parameters) and
  names the near miss. `get_version` stays open: clients send a dummy property to a tool that takes
  nothing. Read arguments with `declaredArguments`, never by enumerating `inputSchema` — a guard
  that did measured zero parameters and passed.
