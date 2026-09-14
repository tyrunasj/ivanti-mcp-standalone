# Example configurations

Eight starting points, one per shape people actually deploy. Copy one to `.env`,
change the tenant and the secrets, and you have a working configuration.

**`.env.example` at the repository root is the reference** — it documents every
setting and what it does. These are the opposite: no exhaustive comments, just a
configuration that runs, with a note on the one thing that catches people out.

| File | Transport | Access | Audience |
|---|---|---|---|
| [`desktop-stdio.env`](desktop-stdio.env) | stdio | none — running the process *is* the credential | `full` |
| [`local-http.env`](local-http.env) | HTTP, loopback | `none` | `full` |
| [`shared-bearer.env`](shared-bearer.env) | HTTP | `bearer`, secrets as files | `full` |
| [`enduser-bearer.env`](enduser-bearer.env) | HTTP | `bearer`, secrets as files | `enduser` |
| [`oauth-entra.env`](oauth-entra.env) | HTTP | `oauth` — Microsoft Entra ID | `enduser` |
| [`oauth-keycloak.env`](oauth-keycloak.env) | HTTP | `oauth` — Keycloak, discovery skipped | `full` |
| [`both-transports.env`](both-transports.env) | stdio **and** HTTP | `bearer` (HTTP only) | `full` |
| [`degraded-tier.env`](degraded-tier.env) | stdio | none | `full`, capped to `session` |
| [`impersonation-oauth.env`](impersonation-oauth.env) | HTTP | `oauth`, impersonation on | `enduser`, acting as the caller |

```bash
cp examples/env/shared-bearer.env .env
$EDITOR .env          # tenant, secrets, public URL
pnpm start
```

## They are checked, not just written

`pnpm check:examples` drives every file through the **real** `loadConfig` — the
same code path the server runs at boot, so both the shape rules and the
cross-field rules apply. It runs in CI.

An example that exits 78 is worse than no example, because it gets copied before
it gets read. The check catches exactly the mistakes the server refuses to start
on: HTTP without an `AUTH_MODE`, an `AUTH_MODE` set while HTTP is off, both
transports off, a `MCP_PUBLIC_URL` with a trailing slash, `IVANTI_BASE_URL`
without a key, and `enduser` with an empty allowlist.

`_FILE` secrets point at paths that exist only in the target deployment, so the
file reader is stubbed during the check. What is verified is the configuration,
not the mount.

## What these files cannot tell you

Three settings name **tenant** things, and no example can be right about them:

- `IVANTI_BASE_URL` — your tenant. The `/HEAT` prefix is probed, so give the origin.
- `ENDUSER_BUSINESS_OBJECTS` — technical Business Object names, resolved against
  the tenant at startup. A misspelling exits 78 with suggestions.
- `ENDUSER_QUICK_ACTIONS` — the tenant's own quick-action names, verbatim. They
  are the tenant's text and get renamed freely, so read them off
  `list_quick_actions` in a `full` deployment rather than guessing.

For a configuration built from your own answers rather than a template, the
Handbook's configurator emits the `.env`, the `docker run`, the compose file,
the Helm values and the systemd unit from the same six questions — see
[`docs/handbook.html`](../../docs/handbook.html).
