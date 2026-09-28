# Implementation plan — status

**Updated 2026-09-28.** The plan ran in two phases: **A** proved authentication with `get_version`
as the only tool, so no Ivanti behaviour was in the loop when auth failed; **B** added Ivanti
functionality one axis per stage — read before write, `full` before `enduser`. Every stage is
done. Each stage's goals, exit criteria and findings are in git history
(`git log -p -- docs/implementation-plan.md`); decisions are in [`initial-design.md`](./initial-design.md).

## Stages

| Stage | | Note |
|---|---|---|
| A0 Scaffold | ✅ | |
| A1 Transport and test harness | ✅ | the container landed here |
| A2 Identity seam | ✅ | |
| A3 OAuth resource server | ✅ | |
| A4 Prove the access matrix | 🟡 | every row proven except Entra's final token check — below |
| B1 Transport foundation | ✅ | |
| B2 Metadata, naming, reads | ✅ | |
| B3 Session and capability tier | ✅ | the `.ashx` handler call exists but has no caller yet |
| B4 Writes and hints | ✅ | |
| B5 Workflow surface | ✅ | |
| B6 Service requests, attachments | ✅ | overlord's hosted-upload pair deliberately not ported |
| B7 `enduser` mode and resources | ✅ | |

The plan ended at 34 tools in `full` and 25 in `enduser`.

## Since the plan

- **Impersonation through CentralConfig** — `act_as` opens Ivanti's own session as the person
  ([`impersonation-plan.md`](./impersonation-plan.md)), with `switch_role` in `full` mode.
- **Seven more tools** — `switch_role`, `vote_on_approval`, `list_approvals`, `list_notes`,
  `add_note`, `search_knowledge`, `download_attachment` — for **41 in `full`, 34 in `enduser`**.
- **The identity gate covers `full` mode too**, and a conversation ends on silence or a fresh
  `initialize` (2026-09-17).
- **Near-misses refused instead of answered** — closed tool arguments, field names checked before a
  write, the form's rule lists read and reported (2026-09-17 → 28).

## What remains

- **A4 — Entra's final token check.** Discovery, issuer, JWKS and the PKCE-metadata question were
  proven against a live tenant; only token verification is untested, and it is IdP-agnostic code
  already proven against Zitadel. It is blocked by a deployment prerequisite, not code — an Entra
  deployment needs a public HTTPS hostname on a domain verified in that tenant (see
  [`configuration.md`](./configuration.md)). Revisit at the first real Entra deployment.
- **A gateway carrying its own users' identities** (Slack, Teams) — deferred, not designed: a
  provenance between `asserted` and `verified`, best designed against a real deployment. Until
  then `enduser` over HTTP without `oauth` warns that each person needs their own session.
- **Open items found while testing** — `link_records` reporting a no-op as a link, batch
  relationship calls, elicitation — are tracked in [`notes.md`](./notes.md).

## Still-standing risks

| Risk | Mitigation |
|---|---|
| The fork of overlord's Ivanti layer drifts | The three habits below |
| SDK 1.30.0 implements protocol `2025-11-25`, not `2026-07-28` | Check `LATEST_PROTOCOL_VERSION` before assuming a newer requirement |
| TypeScript pinned to 6.x by `typescript-eslint` | Revisit when it supports TS 7 |
| An asserted identity can be impersonated | Accepted; pinning bounds it, `oauth` removes it |

## Fork, not shared package — decided 2026-09-11

The Ivanti layer is forked from `overlord-service`, not shared as a package: this server is meant
to evolve independently, and shared code would make every divergence a negotiation. The cost —
an Ivanti discovery made in one codebase is a quirk in both — is paid with three habits:

1. **The fork point is recorded:** `synergy-platform` at commit `952ad0c` (2026-09-01, the last
   change to `services/overlord-service/src/mcp/servers/ivanti`). `git log 952ad0c..HEAD -- …/ivanti`
   then answers "what has upstream learned since".
2. **Ported files carry a provenance comment** naming their origin path, so one file can be diffed.
3. **Discoveries are offered back** to whoever owns overlord.

Deliberate divergences: no `tenant` parameter (one tenant per instance), capability tiers, two
audiences (`full` / `enduser`), and this server's own OAuth resource server. Everything else —
transport conventions, hints, the metadata catalog, write recipes — should stay recognisably the
same, because a difference there would be accidental.
