---
name: ship
description: Ship the current working-tree changes — run every check, branch, commit, push, open a PR, merge it, and return to the base branch. Use when the user says "ship it", "ship this", or invokes /ship. Accepts an optional branch/topic name and the flags --no-merge, --local, --no-delete-branch.
---

# Ship

Takes uncommitted work from the working tree to merged, in one pass, refusing to proceed at the
first sign that it should not.

**Invoking this skill is the explicit authorization to commit, push, and merge.** The standing
"never commit unless asked" rule is satisfied by the user running `/ship`. Do not ask again for
each step — but do stop and report at any guard below rather than working around it.

## Arguments

| | |
|---|---|
| `<topic>` | Optional. Branch becomes `ship/<topic-slug>`. Otherwise derive a slug from the diff. |
| `--no-merge` | Open the PR and stop. For work that needs review. |
| `--local` | No push, no PR: branch, commit, merge back to base with `--no-ff`. Use when there is no remote. |
| `--no-delete-branch` | Keep the branch after merging. |

## 1. Preconditions — check all of these before touching anything

Stop and report if any fails. Do **not** create a branch first: a failure must leave the repo
exactly as it was found.

1. **`git rev-parse --git-dir`** succeeds — otherwise there is no repo to ship from.
2. **The working tree has changes.** `git status --porcelain` non-empty. A clean tree means there
   is nothing to ship; say so rather than opening an empty PR.
3. **HEAD is not detached.** `git branch --show-current` is non-empty.
4. **Record the base branch now** — it is the PR target and where you return at the end. Never
   assume `main`; read it.
5. **The target branch does not already exist**, locally or on the remote. If it does, pick a
   suffixed name rather than clobbering someone's branch.
6. **A remote exists** unless `--local`. If `git remote` is empty, say so and continue as
   `--local` rather than failing outright.
7. **`gh` is installed and authenticated** unless `--local` (`gh auth status`). If not, fall back
   to `--local` behaviour and tell the user why.

## 2. Run every check — before committing anything

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run **all four even if an early one fails**, then report every failure together. One round trip
beats four. Ship nothing if any check fails, and leave the working tree untouched — no branch, no
commit, no stash.

`typecheck` is not redundant with `build`: the build config excludes tests and fixtures, so
`typecheck` is the only thing that type-checks the test suite.

Adapt the commands if the repo's `package.json` does not define these scripts, but never silently
skip a check that exists.

## 3. Branch and commit

```bash
git switch -c ship/<slug>
git add -A
git commit
```

- Write the commit message from **what the diff actually does**, not from the conversation. Read
  `git diff --stat` and the diff itself.
- Follow the repo's existing commit style — read `git log` first.
- End the message with whatever attribution trailer the current session's instructions specify.
  Do not invent one, and do not carry over an example from this file.
- Review what `git add -A` would stage before running it. If it would include something that
  should not be committed — a stray secret, a build artefact, a scratch file — stop and report
  instead of committing it. `.gitignore` is not a substitute for looking.

## 4. Push and open the PR

```bash
git push -u origin ship/<slug>
gh pr create --base <base> --head ship/<slug> --title "…" --body "…"
```

- **Never `--force`.** A rejected push means something unexpected is on the remote; report it.
- PR title: the commit subject. Body: what changed and why, plus anything a reviewer needs to
  know — and the PR attribution the session's instructions specify.
- With `--no-merge`, print the PR URL and stop here.

## 5. Merge

```bash
gh pr merge <url> --squash --delete-branch
```

- **Squash by default.** One reviewable commit per shipped change keeps the base branch readable.
- If the merge is refused — branch protection, required reviews, failing required checks — **stop
  and report the reason. Leave the PR open.** Never bypass a protection rule, never
  `--admin`, never retry with force.
- If the repo runs CI that must pass first, prefer `--auto` so the merge happens when CI goes
  green, and tell the user it is queued rather than done.

## 6. Return to a usable state

```bash
git switch <base>
git pull --ff-only
```

Leaving the user on a deleted branch is the most common way this kind of automation annoys people.

## 7. Report

State plainly: the branch, the PR URL, the merge result, and the check results. If anything was
skipped or fell back (no remote, `gh` missing, merge queued behind CI), say so explicitly — a
half-completed ship reported as success is worse than a clear failure.

## Guard rails

- **Never force-push, never `--admin` merge, never delete the base branch.**
- **Never merge with failing checks**, whether local or CI.
- Do not amend or rebase commits that are already pushed.
- If the working tree contains changes unrelated to the intended change, point that out before
  committing — shipping a mixed bag is how unrelated work lands unnoticed.
- If any step fails midway, report the exact state: which branch exists, what was committed, what
  was pushed. Never attempt an unrequested rollback that could lose work.
