# Reviews

Findings from full-codebase reviews. **A review is a snapshot, not a task list** — nothing here is
fixed by being written down, and nothing here is authoritative once the code moves. Each report
states the commit it was run against.

| | Against | Raised | Refuted | Distinct defects |
|---|---|---|---|---|
| [`2026-09-14-full-review.md`](./2026-09-14-full-review.md) | `b17be17` (v0.2.0) | 86 | 24 | 38 — 9 high, 23 medium, 6 low |

## How these are produced

Sixteen reviewers, one per dimension, reading the source rather than this repo's account of it.
Every finding then goes to an independent skeptic briefed to **refute** it — find the guard, the
caller that does not exist, the test that already covers it, the documented reason — and to default
to refuted when it cannot build the failure from a real entry point. Survivors claiming to be
serious get three more passes: exploitability, blast radius, and whether the proposed fix is itself
correct. A final pass asks only *what did nobody look at*.

The refutation step is the part that matters. A plausible-sounding finding that ships into a report
and turns out to be wrong costs more than a missed one, because it spends the reader's trust in
everything beside it. 24 of 86 did not survive, and the reasons are recorded alongside the findings
rather than discarded — a refuted finding is a note about why the code is right, which is worth
keeping so nobody re-files it.

Each report also ends with what **nobody** looked at. A review that does not state its own limits
reads as though it covered everything.

## Keeping one honest

- Re-run after any significant change to the tool surface. The manifest-driving exercise CLAUDE.md
  describes is the complement to this: it finds what is wrong with the *descriptions*, which is not
  visible from inside the code.
- A finding that contradicts `docs/initial-design.md` §10 or `docs/notes.md` has to engage with the
  stated reason. Several obvious-looking defects here are decisions, and are listed as refuted.
- When a finding is fixed, fix the **class**, not the instance. Most of the 2026-09-14 list is three
  shapes: a catch that turns a failure into a success shape, a surface impersonation did not reach,
  and a guard that matches a literal spelling.
