# Changelog

What changed for someone running the server, newest first. **Upgrading** says what to check
before moving to a release; a release with nothing under it upgrades by swapping the version. The
full list of merged changes is on each [GitHub release](https://github.com/tyrunasj/ivanti-mcp-standalone/releases).

## 0.3.2 — 2026-10-05

**Upgrading.** Nothing needs setting, but three things behave differently:

- the Helm chart's readiness probe is now `/ready`, so a pod whose tenant stops answering leaves
  rotation instead of taking traffic it cannot serve;
- filters Ivanti misreads are refused with how to rewrite them — anything that sent a group after
  the start, an `and` after an `or`, or `not` got wrong rows before and gets an error now;
- requests to the tenant are capped at 16 in flight and tool calls at 120 a minute per
  conversation; raise `IVANTI_MAX_CONCURRENT_REQUESTS` or `MCP_MAX_CALLS_PER_MINUTE` if a busy
  deployment hits them (the `ivanti request cap reached` and `tool call rate limited` warnings).

- **Runtime base rebuilt:** `gcr.io/distroless/nodejs22-debian13` now carries `libssl3t64`
  `3.5.7-1~deb13u3`, for CVE-2026-75804 and CVE-2026-84782. A scan of the image finds nothing
  critical or high.
- **`/ready`**, beside `/health`: 503 once the tenant has failed two checks in a row, a minute
  apart, and 200 again on the first that passes. The Helm chart's readiness probe uses it; startup
  and liveness stay on `/health`, so a tenant outage takes a pod out of rotation without
  restarting it. Point a load balancer's health check at it.
- **A 401 on the service account's own calls no longer re-opens the person's Ivanti session.**
  Only a 401 on the person's session does; before, a refused key threw away a session that was
  fine.
- **Every image is scanned before it is published** — the release refuses one with a critical or
  high finding that has a fix — and the published `latest` is scanned every week.
- **`IVANTI_MAX_CONCURRENT_REQUESTS`** (default 16): a cap on requests in flight to the tenant at
  once. Past it a request waits its turn, and one that waits out its timeout fails as never sent.
- **`MCP_MAX_CALLS_PER_MINUTE`** (default 120): tool calls per conversation per minute; past it a
  call is refused with how long to wait. Both are new defaults rather than new requirements —
  nothing needs setting on upgrade.
- **Three known limits closed:** two initializes from one person at the same instant no longer
  leave them above `MCP_MAX_SESSIONS_PER_SUBJECT`; shutdown waits for the release a client's own
  DELETE started; with stdio beside an `oauth` HTTP transport, the stdio conversation is told to
  ask who it is helping rather than that its sign-in already says.
- **`group_count` with a filter counted wrong.** Ivanti honours parentheses only at the start of a
  `$filter`, and each bucket put the caller's filter last — so buckets could add up to many times
  the total. The same cause made `act_as` miss on a person's full name at the exact lookup. Both
  now put the group first.
- **Filters Ivanti would misread are refused before sending**, with how to rewrite them: a group
  anywhere but the start, an `and` after an `or` in the same group, and `not`. Ivanti answers each
  with a 200 and the wrong rows — `not` with every row.
- **Prometheus metrics, off by default.** `METRICS_ON=true` serves `GET /metrics` on a port of its
  own (`METRICS_PORT`, 9464), never the MCP port, bound to `METRICS_BIND` (`127.0.0.1`), with an
  optional scrape-only `METRICS_TOKEN` / `_FILE`. Tool calls by tool and outcome, Ivanti requests by
  method and status, latencies, sessions, evictions and refusals, readiness, memory — never a
  person, filter, record or ticket text. A browser's request is refused (403). Startup refuses a
  metrics port equal to `MCP_PORT`, a token under 32 characters, and a token equal to another
  secret, only while metrics are on. The chart gains `metrics.*`: a Service of its own the Ingress
  never routes to, an optional ServiceMonitor, and a NetworkPolicy rule. Nothing changes on upgrade
  unless you turn it on; leave it off on an internet-facing deployment unless something private
  scrapes it.
- `create_record` in `enduser` no longer credits Ivanti's session with the `CreatedBy` the server
  stamped itself. The third-party notices now include nested dependencies.

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
