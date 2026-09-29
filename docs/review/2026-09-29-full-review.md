# Full code review — 29 September 2026

Against `4807b1d` (v0.2.5). The previous review was against `b17be17` (v0.2.0); about 6,300 lines of
`src/` changed between them, mostly in `register-tools.ts`, the impersonated session, `exchange()`
and the metadata tools.

> **Status:** see [`STATUS-2026-09-29.md`](./STATUS-2026-09-29.md) for what was fixed and where.
> The findings below are left as they were written.

## What was run

Seven reviewers, one per area — the HTTP and auth surface; configuration and operations; the
Ivanti HTTP, OData and metadata layer; identity and Ivanti sessions; every write path; the tool
framework and its gates; every read tool. Each read the source rather than the docs' account of it,
was briefed on the 2026-09-14 review's refuted findings and on `docs/notes.md` so as not to re-file
a documented decision, and was told to try to **refute** each of its own findings before reporting
it. Several reproduced their findings with throwaway scripts against the real modules.

The highest-severity claims were then checked by hand against the source. One — the own-records
filter escape, filed as a blocker by two reviewers independently — was **measured against the live
tenant**, and the measurement moved it from blocker to medium (finding 9). That is recorded rather
than quietly corrected, because the reasoning that made it look like a blocker is the same
reasoning the 2026-09-14 review used for its finding 2, and it is wrong about Ivanti.

Where two or three reviewers found the same defect from different directions it is merged and
counted once; the corroboration is noted.

**Baseline.** `pnpm lint`, `pnpm typecheck`, **1,035 tests in 105 files** and `pnpm build` all
pass; `pnpm audit --prod` reports nothing; coverage is 90.1 % of lines and 78.9 % of branches.
Everything below is something a green build does not catch.

## How to read it

The same scale as the previous review — severity is what a user or operator actually experiences:

| | |
|---|---|
| **high** | wrong data, or a silently failed write, that someone would act on; or a stated control that does not hold |
| **medium** | a real defect with a narrow trigger, or a loud failure in a case that should have been quiet |
| **low** | hygiene, a misleading message, a test that does not test what it says |

Three shapes recur:

1. **Two checks that disagree about the same name.** The field guard is case-insensitive and the
   pick-list resolver is not (5); the approval listing and the vote trust different identifiers (1);
   the own-records scope is checked on the record you start from and not on the rows you are handed
   (3).
2. **"No answer" reported as "no".** A timeout on a write is called a refusal (4); a failed journal
   count is called "no other activity" (18); an outage during an ownership check is called "not
   yours" (29).
3. **A default that is safe in one place and not in the next.** `AUTH_MODE=none` is safe on
   loopback, and the compose file publishes it on every interface (2); the chart's replica guard
   assumes an affinity that cannot route (14).

---

## High

### 1. Two people with the same display name can vote on each other's approvals

`src/tools/approvals/vote-on-approval.ts:124-128`, `src/tools/approvals/list-approvals.ts:128-130`.
**Confirmed by hand.**

The ownership check is an OR of four comparisons — `Owner_Valid` against the person's RecId, and
`Owner` against their login, email and display name. The comment above it calls `Owner_Valid` "the
one to trust", but it is not treated that way: when `Owner_Valid` names somebody else, a matching
display name still passes. `notes.md` records a live row whose `Owner` held a display name.
`list_approvals` ORs `Owner eq '<displayName>'` into its filter the same way, so the other person's
approval is also *listed* as theirs one call earlier.

The tool is registered in `enduser`. The vote is recorded as the other person's decision.

**Fix:** when `Owner_Valid` is present it decides alone; the `Owner` spellings apply only to a row
without one. Filter the listing the same way.

### 2. The compose file publishes an unauthenticated server on every host interface

`docker/compose.yaml:24-28`, the configurator in `docs/handbook.html`, `examples/env/local-http.env`.
**Confirmed by hand.**

Compose sets `MCP_BIND: 0.0.0.0` (correctly — inside a container, loopback is the container's own)
and publishes `'${MCP_PORT:-3000}:${MCP_PORT:-3000}'`, which Docker binds on `0.0.0.0` on the host
and which bypasses `ufw`. With `local-http.env` (`AUTH_MODE=none`) — or the configurator's
"Not published" choice, which it labels "loopback only" and then renders as `-p 3000:3000 -e
MCP_BIND=0.0.0.0` — the full tool surface on the service-account key is reachable from the LAN.
`validate-config` cannot catch it: from inside the container, `0.0.0.0` is the expected bind.

**Fix:** publish on `127.0.0.1` by default; the configurator generates `-p 127.0.0.1:…` for the
loopback choice; the server warns at startup when `none` meets a non-loopback bind.

### 3. `get_related_records` returns other people's records in `enduser`

`src/tools/records/get-related-records.ts:92-99`. **Confirmed by hand; not measured live.** Found by
two reviewers.

The own-records gate is applied to the record the call starts from. The rows returned are not
checked. With a relationship whose target is itself a person's record — the guard test's own
example is `IncidentAssociatedServiceReq` — the caller's own incident leads to somebody else's
service request, whole, with `fields:"*"`. The comment ("the gate is the parent") is right for
children such as tasks and attachments and wrong for associations. A second route: where `journal`
is allowlisted, `get_related_records` returns the internal notes `list_notes` deliberately filters
out.

**Fix:** on a target with a customer link, keep only the caller's rows; allow targets without one
only as children of the parent; refuse journals in `enduser` and point at `list_notes`.

### 4. A write that times out is reported as "Ivanti refused the request (0)", and the model retries

`src/tools/shared/run-tool.ts:211`, `src/ivanti/http/exchange.ts:82-100`,
`src/ivanti/http/transport.ts:11`. **Confirmed by hand.** Found by three reviewers.

The timeout is a hard-coded 10 s for every surface (15 s for ASMX) and is not configurable. A
`create_record`, `submit_service_request` or `add_note` that runs tenant workflow for longer is
aborted on this side while Ivanti commits it. Status 0 falls through to the generic "refused"
wording, and a model reads "refused" as "did not happen". It files the ticket again — approvals and
notification emails included. With workflow-heavy creates this is the likeliest production incident
in the list.

**Fix:** on a non-GET with no answer (status 0, 502, 504), say the write may have been applied and
to check before retrying; make the timeouts configurable, longer for writes.

### 5. A field name in the wrong case skips pick-list validation and the read-back

`src/tools/shared/known-fields.ts:38` against `src/ivanti/write/validated-write.ts:177,181`.
**Confirmed by hand**; a reviewer reproduced it (`Status:'Bogus'` throws `ValidatedValueError`,
`status:'Bogus'` returns nothing to resolve).

`assertKnownFields` compares names case-insensitively, so `status` passes. `resolveValidatedWrite`
looks names up case-sensitively, so nothing is resolved, no `Status_Valid` is sent, `confirm` is
empty, and success is reported. Ivanti then either drops the unknown key or stores the text without
its identifier — the failure this module exists to prevent, reported as success.

**Fix:** rewrite each key to the schema's spelling before resolution and before sending; refuse two
keys that differ only by case.

---

## Medium

### 6. `update_record` lets an end user hand their ticket to someone else

`src/tools/records/update-record.ts:112`. **Confirmed by hand.** The pre-write check is that the
record is the caller's; the body is unrestricted, so `ProfileLink_RecID`, `ProfileLink_Category`
and `CreatedBy` can be rewritten, undoing the stamp `create_record` applies. Without impersonation
the PATCH runs on the admin key. `create_record` has the mirror: `profilelink_recid` in any other
case passes the field guard and is sent beside the stamp.

### 7. Under OAuth the person is looked up by an unverified `email` claim

`src/auth/identity.ts:54-62`. **Confirmed by hand.** Found by two reviewers. The default claim order
is `email`, `preferred_username`, `upn`; `email_verified` is read nowhere. On an IdP that lets a
user set their own email unverified (Keycloak's account console, Auth0 with self-signup, Entra
optional claims for guests — the "nOAuth" class), a user sets a colleague's address, the exact
`PrimaryEmail` match pins as `verified`, and with impersonation Ivanti opens a session as the
colleague. Harmless on a locked-down Entra or Okta; nothing in the docs says it depends on that.

### 8. A conversation that ends during `act_as` jams impersonation until restart

`src/tools/register-tools.ts:292`, `src/auth/impersonation.ts:62-98`. **Confirmed by hand**;
reproduced by two reviewers. `endConversation` returns early when nobody is pinned yet, so a
re-initialize (stdio) or idle end during the handshake never releases; the handshake then stores
person A's session, and every later `act_as` is refused with a message naming A's login. Separately,
`release()` clears `current` and `openedFor` but not `pending`, so a later `open(B)` can join A's
handshake and be handed A's session — unreachable today, but it is what the obvious fix to the
first half would expose.

### 9. The own-records filter can close its own parenthesis — but Ivanti does not honour the escape

`src/tools/shared/own-records.ts:96`, `src/ivanti/odata/filter.ts:59`. **Confirmed in the source,
measured live, downgraded.** Found by two reviewers, each filing it as a blocker.

The filter guard never checks that parentheses balance, so `Status eq 'Active') or (Status ne 'x'`
is sent as `(Status eq 'Active') or (Status ne 'x') and ProfileLink_RecID eq '<me>'`. Under standard
OData precedence that returns every active incident in the tenant.

Measured on 2026-09-29 against the dev tenant, `enduser`, no impersonation, driving `count_records`
through the working tree:

| filter | count |
|---|---|
| (none) — the person's own | 8 |
| `Status eq 'Active'` | 2 |
| `Status eq 'Active') or (Status ne 'zzz'` | 2 |
| `Status eq 'Active') or Status ne 'zzz' or (Status eq 'x'` | 0 |
| `Status eq 'Active') or (Status eq 'Closed'` | 0 |
| `Status eq 'Active'` in `full` — the whole tenant | 66 |

No shape leaked. Ivanti does **not** apply OData's `and`-before-`or`: it kept the trailing `and
<mine>` in every case, and answered some shapes with counts that are simply wrong (0). The same
unbalanced filters in `full` mode, unwrapped, are refused with a 400. So this is not a data leak on
this Ivanti version — it is a filter that silently yields a wrong answer, and a scope whose safety
rests on an Ivanti parser quirk nobody documented. Both are reasons to refuse it. The previous
review's finding 2 reasoned from standard precedence too; its fix is still right, for the same
reason.

### 10. One non-schema 200 on the seed `$metadata` URL makes Incidents unknown until restart

`src/ivanti/metadata/catalog.ts:138-151`. **Confirmed by hand**; reproduced by a reviewer. A parse
failure is cached forever — deliberately, so a mistyped object costs one round trip. But a WAF or
maintenance page answering 200 HTML takes the same branch, and `routes.metadata('incidents')` is
the seed URL, so every later `list_records {object:"Incidents"}` says "Ivanti has no Business
Object named 'Incidents'" without asking. The module's own doc and `notes.md` both say a non-CSDL
200 must never be cached; the test proves only that a *different* graph still resolves.

### 11. Fields that are not pick lists are never read back

`src/ivanti/write/validated-write.ts:186`, `create-record.ts` / `update-record.ts` (~141).
`confirm` holds validated fields only, and the returned `record` is the POST/PATCH reply rather than
a read. Both descriptions promise "read back … not stored is reported as a failure". `notes.md`
measured Ivanti storing the session account over a written `LastModBy`, which is reported as
`changed`.

### 12. `add_note` in `full` mode files a note on a record that does not exist

`src/tools/notes/add-note.ts:67`. `assertRecordWritable` returns `undefined` for a missing record in
`full`, the note is POSTed with a parent that points at nothing, and it is never read back.
`upload_attachment` guards the same case with `ParentNotFoundError`. `add_note` has no test file.

### 13. A session Ivanti has ended is never re-opened

`src/auth/impersonation.ts:67`, `src/ivanti/session/central-config.ts:172`. After a tenant timeout
or an admin killing the session, every call fails; there is no 401 retry on the person's
transport, and a repeated `act_as` hands back the cached dead session while saying Ivanti is
applying their access. `expiresAt` is parsed and never read. `impersonation-plan.md` §5 says
`SessionKeyExpire` re-runs the handshake.

### 14. The chart's scale-out affinity cannot work

`charts/ivanti-mcp/values.yaml:17-21`, `_helpers.tpl:78-82`, `docs/deployment.md:139-144`.
`initialize` carries no `Mcp-Session-Id`, the pod that answers it mints one, and later requests are
hashed on that id — which reaches the minting pod 1/N of the time. With three replicas about two
thirds of sessions 404, and the client's re-initialize loses the `act_as` pin. The guard also
accepts `sessionAffinity.enabled` with ingress off, which renders no affinity at all; Traefik (the
k3s default) ignores the nginx annotation anyway.

### 15. At the session cap, new sessions are refused rather than idle ones evicted

`src/server/http/session-manager.ts:66-78`, `session-store.ts:49-52`, `mcp-handler.ts:176-188`.
`notes.md` records that clients routinely abandon sessions without a DELETE. Around 3.4 abandoned
sessions a minute fill the default 100, and every new conversation then gets 503 for up to 30
minutes; `Retry-After: 30` is wrong because nothing frees before the TTL. One client that
re-initializes on every call can do it alone. Separately, `admit()` counts only registered sessions,
so concurrent initializes near the cap overshoot and get a 404 "Session not found".

### 16. The release workflow runs from any branch, with tag-pinned actions holding write tokens

`.github/workflows/release.yml:49-76,122-126,154,243`. It is `workflow_dispatch` with no ref guard,
so an unreviewed branch can publish a signed `latest`, the chart and a tag, around `main`'s
protection. The documented `cosign verify` identity regexp accepts any workflow on any ref. Lint,
test and build run every devDependency in the job that holds `contents`/`packages: write` and
`id-token: write`, with the checkout token persisted; third-party actions are pinned by mutable
tag.

### 17. `download_attachment` reads the whole file before checking its size

`src/ivanti/http/transport.ts:177-199`, `src/tools/attachments/download-attachment.ts:108-131`.
`requestBinary` has no byte cap and reads no `Content-Length`; the tool decodes the whole buffer and
then slices 20 k characters. `AttachmentSize` is on the row the tool already read. A 200 MB
attachment on someone's own ticket, in a pod limited to 512 Mi, is an OOM kill that takes every
in-memory session with it.

### 18. `list_notes` truncates silently, miscounts, and turns a failed count into a claim

`src/tools/notes/list-notes.ts:66-79,109-112`. Notes are capped at 20 with the total discarded;
`otherEntries` subtracts the page size rather than the notes total, so 45 notes and 5 emails report
"30 … Ivanti's own emails"; a failed journal count is caught as 0 and then described as "genuinely
has no other activity logged, rather than the count being unavailable".

### 19. `search` hides truncation

`src/tools/search/search.ts:98,129`. Three objects × 10 hits are cut to 25 by `slice`; the last
object's hits vanish while `searched` still lists it. No count, no `truncated`.

### 20. `fulltext_search_object` with `fields:"*"` returns only the RecId

`src/tools/search/fulltext-search-object.ts:99`. `"*"` projects to `{RecId}` with no note; on a
tenant's own object the fixed list gives RecId and two timestamps. `saved_search` has the same
fallback gap. `list_records` already does this right with `resolveRowFields` / `compactFieldsFor`.

### 21. Write audit lines never say which record was written

`src/tools/records/delete-record.ts:86` (and update, quick actions, attachments, unlink, vote),
`register-tools.ts:380`. At `info` a `delete_record` leaves the tool, session, `identity: asserted`
and the object type — no record id, and on an asserted pin no person. "Who deleted incident X"
cannot be answered, though `notes.md` calls this log "where provenance survives". A RecId is
neither ticket text nor personal data, which is the stated reason arguments are not logged.

---

## Low

| # | Finding | Where |
|---|---|---|
| 22 | Shutdown does not await the session release: `Session.close` returns `void`, `releaseOnClose` does `void slot.release()`, so `process.exit` races it. Capped by `RemoveSession` ending nothing. stdio has no signal handler and no stdin-end teardown. | `start-http.ts:114`, `create-server.ts:67`, `index.ts:96,154` |
| 23 | Once jose's JWKS cache is 10 min old, every request awaits a reload; during an IdP outage every request waits 5 s and 503s although the cached keys still verify. | `oauth/verify-token.ts:79` |
| 24 | A failed automatic sign-in (a transient 5xx) is cached in `signingIn` and replayed on every call; only an explicit `act_as` recovers, and the refusal does not say so. | `register-tools.ts:334-343` |
| 25 | The instructions tell an OAuth session to ask the person's name, though the gate pins from the token — a wasted turn per conversation. | `server/instructions.ts:52` |
| 26 | An empty `ActiveRole` from `SelectRole` is taken as success; the opening path never compares the applied role with the requested one. | `session/roles.ts:142`, `impersonated-session.ts:243` |
| 27 | `link_records` on a containment relationship silently moves a target off its existing parent, while annotated non-destructive; a re-link that changed nothing answers `linked`. | `relationships/link-records.ts:56` |
| 28 | `upload_attachment` does not read back the link it says it verifies; on a PATCH timeout it declares the file orphaned without checking; in `enduser` it advises `delete_attachment`, which refuses unlinked files; `lastModBy` is hard-coded "service account". | `attachments/upload.ts:204`, `upload-attachment.ts:133` |
| 29 | `assertOwnRecordById` catches every error, so an outage reads as "No such record is available to you". `assertRecordWritable` was fixed for exactly this. | `shared/own-records.ts:242` |
| 30 | `submit_service_request` lists staged files as attached without checking; the ASMX path drops `subject` and never sends `localOffset`, while answers are verified with that offset. | `submit-service-request.ts:315`, `submit.ts:363` |
| 31 | `vote_on_approval` success means "no longer Pending", not "stored as the decision made"; a failed parent read becomes `approval: null` silently; a `Reason` written before a failed vote stays. | `vote-on-approval.ts:192,195` |
| 32 | `WriteNotStoredError` advises refreshing the option list even for computed fields like Priority, inviting another retry. | `validated-write.ts` |
| 33 | `scrubErrorBody` misses `&quot;`-encoded bodies and doubly nested escapes; `notes.md` records Ivanti's OData 500s are entity-encoded. Same class as the previous review's 20. | `http/errors.ts:123` |
| 34 | Network failures lose their cause (`fetch failed`, with ENOTFOUND/TLS/ECONNRESET in `.cause`); the base-path probe bypasses `exchange()` and records only `"error"`. | `exchange.ts:83`, `base-path.ts:86` |
| 35 | `referencedFieldNames` reads `T00` and `Z` out of a date literal as field names, and the error then tells the model to fix them. | `odata/filter.ts:119` |
| 36 | `list_assigned_work` fetches two people and silently uses the first; the shared `findPerson` refuses ambiguity. | `list-assigned-work.ts:64` |
| 37 | `fetch` puts the caller's raw id into the URL before resolving the object (`../../rest/X:1`); `full` mode only. | `search/fetch.ts:60` |
| 38 | `get_link_fields` presents the first sampled `_Category` as "use it verbatim" on a link that can point at several objects. | `get-link-fields.ts:82` |
| 39 | `get_object_metadata` computes `labelsNote` after the search filter, so a one-row match can claim no field carries a label. | `get-object-metadata.ts:131` |
| 40 | `group_count` adds −1 to the bucket total for an errored bucket and blames the difference on unlisted values. | `group-count.ts:30,164` |
| 41 | `http://` is accepted for `OAUTH_ISSUER`, `OAUTH_JWKS_URI`, a discovered `jwks_uri`, `IVANTI_BASE_URL` and `IVANTI_CONFIG_URL`. | `env-schema.ts`, `create-verifier.ts` |
| 42 | `ENDUSER_*` set while `MCP_MODE=full` is silently ignored — the reverse mismatch is refused. | `validate-config.ts:176` |
| 43 | `BEARER_TOKEN` accepts one character; the configurator's own `change-me` placeholder passes. | `env-schema.ts` |
| 44 | Secret rotation does not roll pods: with `existingSecret` the checksum annotation is constant, and there is no rotation runbook. | `templates/deployment.yaml:15` |
| 45 | The chart's `authMode=none` guard covers ingress only; `LoadBalancer`/`NodePort` render. NOTES recommends a NetworkPolicy the chart does not ship. | `_helpers.tpl:102` |
| 46 | `healthcheck.mjs` parses booleans differently from `z.stringbool`, so `HTTP_TRANSPORT_ON=y` starts HTTP and the health check always passes. | `docker/healthcheck.mjs:12` |
| 47 | Base images are not digest-pinned, pnpm is installed unpinned, there is no Dependabot, and the chart is never linted or rendered in CI. | `Dockerfile`, `.github/` |
| 48 | Node's HTTP defaults are untouched (`keepAliveTimeout` 5 s) — sporadic 502s behind a load balancer with a 60 s idle timeout. "listening" is logged before the port is bound. | `start-http.ts` |
| 49 | A tool result discarded because the conversation ended tells the model to "retry", including for writes that went through. | `register-tools.ts:413` |
| 50 | Doc drift: `licenses=UNLICENSED` label against the Dockerfile's licence; `deployment.md:47` on stdio under systemd; a systemd "note below" that does not exist; per-session memory figures that disagree between `values.yaml` and `.env.example`. | various |

---

## Refuted — do not re-file

- **JWT algorithm confusion.** 21 crafted headers (`none`, HS256, `crit`, `b64`, embedded `jwk`,
  junk) against jose 6.2.12 all end as 401.
- **Bearer comparison timing.** `timingSafeEqual` after a length check; only the length leaks.
- **DNS rebinding without a Host check.** Browsers send Origin on POST; GET and DELETE need an
  unguessable session id.
- **Cross-subject session reuse.** `ownsSession` gates GET, DELETE and POST alike since the last
  review.
- **Unbounded session map or per-session timers.** Capped and swept; no per-session timers.
- **JWKS refetch storm from random `kid`s.** jose's 30 s cooldown.
- **Request body.** Capped at 4 MiB, read only after Origin and auth.
- **Parameter smuggling through `$filter`/`$orderby`/`$search`.** Each value is
  `encodeURIComponent`'d whole.
- **XXE or entity expansion.** fast-xml-parser 5.11.1 has no external entities and caps expansion.
- **Retrying non-idempotent writes.** There is no retry anywhere.
- **Credentials on a redirect.** undici strips `Authorization` and `Cookie` cross-origin.
- **Falling back to the service account when the person's session fails.** No path does it.
- **Caches not keyed by person.** Keyed by the session object, or by session and role.
- **`__proto__` / `constructor` arguments.** Refused by `strictObject`; inside `fields`, dropped by
  zod.
- **A tool reachable without the identity gate.** Every tool registers through `registerTools`; no
  prompts or completions are registered; resources are gated by `mayAnswer`.
- **Typo suggestions substituting.** `suggestNames` only feeds "did you mean".
- **Liveness depending on Ivanti; the container running as root; secrets in layers or logs.** None
  of them: distroless `nonroot`, read-only root, capabilities dropped, `.dockerignore` covers
  `.env*`; the image is signed with SBOM and provenance.
- **Enduser notes, attachments and quick actions on other people's records.** All go through
  `assertRecordWritable` or `assertOwnRecordById` plus the parent gate.
- **`delete_record` failing after the commit.** A retry says "nothing was deleted".
- **Upload memory.** Body capped at 4 MB and each file at 2 MB before sending.

## What nobody looked at

- **Load.** No reviewer ran the server under concurrent sessions; the session-cap and memory figures
  are arithmetic, not measurement.
- **The reference documents' content** under `src/resources/` was read only for contradictions with
  the tools, not for correctness about Ivanti.
- **The handbook generator and `scripts/`** beyond the release and licence checks.
- **Whether Ivanti sessions held for 18,000 s consume analyst licences** — which would make finding
  13 and the unreleased sessions a lock-out risk for real staff.
- **Whether a quick-action probe with `shouldSave:false` fires `SendEmail`.** An unchanged
  `LastModDateTime` does not prove no mail left.
- Of the live-tenant questions, only finding 9's was measured.

## Readiness

| Deployment | At `4807b1d` |
|---|---|
| `full`, one replica, bearer or OAuth, IT staff | Pilot. Production after 1, 4 and 5. |
| `enduser` with the impersonation pair | Not yet — 1, 3 and 6 are controls that do not hold; Ivanti's Self Service role is a second layer only where impersonation is on. |
| `enduser` without impersonation | No — 3 and 6 rest entirely on this server, over the admin key. |
| More than one replica | Not supported (14). |
| Local compose or `docker run` with `AUTH_MODE=none` | No until 2. |
