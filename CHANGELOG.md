# Changelog

What changed for someone running the server, newest first. **Upgrading** says what to check
before moving to a release; a release with nothing under it upgrades by swapping the version. The
full list of merged changes is on each [GitHub release](https://github.com/tyrunasj/ivanti-mcp-standalone/releases).

## Unreleased

- **`/ready`**, beside `/health`: 503 once the tenant has failed two checks in a row, a minute
  apart, and 200 again on the first that passes. The Helm chart's readiness probe uses it; startup
  and liveness stay on `/health`, so a tenant outage takes a pod out of rotation without
  restarting it. Point a load balancer's health check at it.
- **A 401 on the service account's own calls no longer re-opens the person's Ivanti session.**
  Only a 401 on the person's session does; before, a refused key threw away a session that was
  fine.
- **Every image is scanned before it is published** — the release refuses one with a critical or
  high finding that has a fix — and the published `latest` is scanned every week.

## 0.3.1 — 2026-09-30

A security patch.

- **Runtime base: `gcr.io/distroless/nodejs22-debian13`.** The Debian 12 image had stopped being
  rebuilt, so it still carried OpenSSL and glibc that Debian had fixed. Node 22.22.0 → 22.23.3.
- **`proxy-addr` 2.0.8, `fast-uri` 3.1.8, `ip-address` 10.7.2**, for CVE-2026-90711,
  GHSA-hrr3-gc8f-f4qj, CVE-2026-101911 and CVE-2026-101912.
- A scan of the image finds nothing critical, and nothing high that has a fix.

## 0.3.0 — 2026-09-30

The 50 fixes from the full review of 2026-09-29, and Windows as a fourth way to run it.

**Upgrading.** The server now refuses settings 0.2.x accepted, and exits `78` naming them:

- any `ENDUSER_*` setting with `MCP_MODE=full` (or `MCP_MODE` unset) — remove it, or set
  `MCP_MODE=enduser` if that was the intent;
- a bearer token under 32 characters — `openssl rand -hex 32` makes one;
- a plain `http://` for `IVANTI_BASE_URL`, `IVANTI_CONFIG_URL`, `OAUTH_ISSUER` or
  `OAUTH_JWKS_URI` anywhere but loopback;
- under `oauth`, an `email` claim names the person only with `email_verified: true` — a provider
  that leaves the flag out needs `OAUTH_IDENTITY_CLAIM` (`preferred_username`, say);
- the Helm chart refuses `replicaCount` above 1, `sessionAffinity`, and `authMode: none` behind a
  `LoadBalancer` or `NodePort`.

Also: `IVANTI_TIMEOUT_MS` and `IVANTI_WRITE_TIMEOUT_MS`; `MCP_MAX_SESSIONS_PER_SUBJECT`;
`IVANTI_IMPERSONATION_REQUIRED`; idle sessions are closed at the session cap rather than new ones
refused; a write that got no answer says it may have been applied; the chart ships a
NetworkPolicy and a `rolloutToken`.

## Earlier

See the [GitHub releases](https://github.com/tyrunasj/ivanti-mcp-standalone/releases).
