# 2026-09-14 review — what was done

All **38 findings** from [`2026-09-14-full-review.md`](./2026-09-14-full-review.md) are addressed,
across fifteen commits on `review/findings-2026-09-14`. Nothing is pushed or merged.

The report itself is deliberately unedited. A findings list rewritten to match its fixes stops
being evidence of what was wrong, and the reasoning in it is what makes the fixes reviewable.

## The rule every fix was held to

**Each change had to be caught by a test that fails against the old code.** Where a test passed
both ways it was rewritten or thrown away. The counts are in each commit message; in total the
suite went from **767 tests in 93 files to 885 in 95**, and every new test was run against the
reverted implementation before being kept.

Three of them earned their place immediately:

- The catalog caching test caught a **regression in my own first fix** — collapsing fetch and
  parse failures into one "retryable" test silently broke the property that a mistyped object name
  costs one round trip rather than one per call.
- A test written to the review's own proposed wording for finding 9 **failed**, which is how the
  display-name gap in that fix surfaced.
- The widened credential guard flagged four files on its first run, three of them **false
  positives** — which is what narrowed it to the two forms that were really the hole.

## Where each finding landed

| | Finding | Commit |
|---|---|---|
| 1 | credential guard defeated by destructuring; three tools on the service account | `98ce8d6` |
| 2 | `group_count` ORed the own-records scope away | `7ac40bb` |
| 3 | body-read failure + permanent schema-cache poisoning | `8b211a3` |
| 4 | cross-subject session check on POST only | `8b211a3` |
| 5 | `assertRecordWritable` failed open in `full` | `959926b` |
| 6 | impersonated writes validated on the service account | `98ce8d6` |
| 7 | `submit_service_request` never consulted the gate | `61af7f1` |
| 8 | `act_as` pinned the wrong person for 3+ token names | `9c2b092` |
| 9 | verified confirmation silenced by any `person` argument | `9c2b092` |
| 10 | `vote_on_approval` refused the person's own approvals | `c054081` |
| 11 | `switch_role` left the form cache on the old role | `1d55077` |
| 12 | concurrent `act_as` shared a handshake and mislabelled the slot | `1d55077` |
| 13 | CentralConfig sessions leaked on failure and on shutdown | `1d55077` |
| 14 | `answersVerified: true` when the read-back threw | `61af7f1` |
| 15 | files uploaded before the later ones were validated | `39bace8` |
| 16 | datetime verified in the server's timezone | `842c46c` |
| 17 | mis-cased field dropped *and* reported as not dropped | `61af7f1` |
| 18 | attachment existence oracle, reachable with no pin | `842c46c` |
| 19 | `personObjects()` memoised a transport failure as absence | `842c46c` |
| 20 | `scrubErrorBody` defeated by a backslash in the value | `842c46c` |
| 21 | allowlist mangled objects whose name ends in `s` | `46bd999` |
| 22 | `*_FILE` secrets skipped the empty-is-unset rule | `959926b` |
| 23 | empty sort clause; `list_approvals`' unchecked sort | `7ac40bb` |
| 24 | budget guard measured the narrower manifest | `602261d` |
| 25 | descriptions naming unregistered tools | `c10b24b` |
| 26 | `saved_search` denied the records were theirs | `c10b24b` |
| 27 | Handbook's disproved impersonation limitation | `fa698ff` |
| 28 | raw interpolation into the `$metadata` URL | `46bd999` |
| 29 | OAuth discovery with no timeout | `959926b` |
| 30 | three guard tests asserting less than they claimed | `602261d` |
| 31 | `requestBinary` sent the API key while impersonating | `46bd999` |
| 32 | licence prune deleted four packages' only licence text | `fa698ff` |
| 33 | IdP outage reported as an invalid token | `39bace8` |
| 34 | `exp` not a required claim | `39bace8` |
| 35 | `ENDUSER_ROLE` documented as startup-validated | `fa698ff` |
| 36 | blind-role note advised a setting `enduser` rejects | `992439f` |
| 37 | CLAUDE.md's manifest figures wrong and self-contradictory | `fa698ff` |
| 38 | cached person-link guess from a failed sample | `992439f` |

## Two of the review's open questions are now closed

The report ended by naming four claims it could not settle without a live tenant. Two were
settled against `stg-ivanti254`:

- **`/api/rest/Attachment?ID=` accepts a SID cookie.** `act_as` followed by `download_attachment`
  returns the file on `Cookie: SID=<person>` with no `Authorization` header — so routing
  `requestBinary` onto the person's credential costs nothing. Recorded in `docs/notes.md`, with
  its limit: both sides were measured as the same Admin account, so a role that can read the row
  but not the file would still be invisible.
- **The manifest figures**, measured across mode × impersonation rather than restated: 37,902
  without impersonation against 37,693 with, so the widest is the one WITHOUT, and the headroom is
  98 characters rather than 307.

Two remain open, both needing a write against the tenant:

- what becomes of an **abandoned staging record** (finding 15 now reports the files that reached
  Ivanti rather than claiming none did, which is what is actually known);
- whether **`RemoveSession`** wants the composed SID or the bare middle segment — if the bare id,
  every release is a silent no-op, which would compound finding 13.

## What was decided differently from the report

- **Finding 35** could have been fixed either by adding the startup check the docs promise or by
  correcting the docs. The docs were corrected: the per-call behaviour is reasonable, and the
  asymmetry with `ENDUSER_BUSINESS_OBJECTS` has a reason worth stating. Adding the check is still
  open if you would rather have it.
- **Finding 9** is stricter than the report proposed. It suggested accepting a display name as
  confirmation; on the deployment this matters for, the display name IS the ambiguous claim, so
  only a login, email or RecId counts.
- **Finding 25's** guard found **eight** dangling pointers, not the six the report counted.
- **Finding 1's** guard deliberately does NOT flag a positional `deps.connection` hand-off.
  `knownObjectNames(deps.connection)` and `findPerson(deps.connection, …)` read only tenant facts,
  and flagging them would need a nine-entry exemption list that would cost the guard its signal.

## Still to do

- Nothing is pushed. No PR.
- The **manifest-driving exercise** CLAUDE.md describes has not been re-run, and 20 of these
  changes touched tool descriptions or refusal text. That exercise is the only thing that finds
  what is wrong with a manifest from outside, and it is the natural next step.
- `docs/notes.md` gained two measured entries (the computed `Priority` field, and the attachment
  SID measurement); `docs/initial-design.md` was not touched.
