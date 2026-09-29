# ivanti-mcp

MCP server for Ivanti Neurons for ITSM. **One release serves one tenant and one
audience** — staging, UAT and production are three releases; `full` and `enduser` are
two more.

```bash
helm install ivanti-mcp oci://ghcr.io/tyrunasj/charts/ivanti-mcp \
  --set server.publicUrl=https://mcp.example.com/mcp \
  --set 'server.trustedOrigins={https://claude.ai}' \
  --set ivanti.baseUrl=https://your-tenant.example.com \
  --set secrets.existingSecret=ivanti-mcp-secrets
```

The package is private for now, so this needs a GHCR credential until it is made public.

The chart forces HTTP (stdio is meaningless in a pod) and refuses to render on a
configuration the server would reject at boot. It also refuses `replicaCount > 1`:
HTTP sessions are held in memory, and the pod that answers `initialize` mints the
session id, so nothing in the request that opens a session can route it back to that
pod. **One replica; a rollout ends every open session** and clients reconnect.
`authMode=none` is refused with an ingress, a `LoadBalancer` or a `NodePort`, and gets
a NetworkPolicy by default.

`node scripts/check-chart.mjs` lints the chart and renders every guard; CI runs it.

Full notes, including the secret-ownership and DNS traps, are in
[`docs/deployment.md`](../../docs/deployment.md).

## Values worth knowing

| Key | Default | Notes |
|---|---|---|
| `server.publicUrl` | — | **Required.** Verbatim match against the token audience; no trailing slash. |
| `server.trustedOrigins` | — | **Required.** Origin validation; what stops DNS rebinding. |
| `server.mode` | `full` | `full` or `enduser`. Never mix audiences in one release. |
| `server.authMode` | `bearer` | `none`, `bearer`, `oauth`. |
| `server.enduser.businessObjects` | `[]` | Required for `enduser`. A gate, not a hint. |
| `server.enduser.quickActions` | `[]` | The tenant's own quick-action names an end user may run, on their own open records. Empty means none. |
| `ivanti.baseUrl` | — | **Required.** Tenant origin; the `/HEAT` prefix is probed. |
| `ivanti.maxTier` | — | `odata`, `session` or `admin` — caps the server below what the key can do. |
| `secrets.existingSecret` | — | Keys `ivanti-api-key`, `bearer-token`, and `ivanti-central-config-api-key` when `ivanti.configUrl` is set. Mounted `0400`. |
| `ivanti.configUrl` | — | The ConfigDB tenant. With its key in the secret, `act_as` signs in to Ivanti AS the person and every surface follows them. |
| `ivanti.impersonationRole` | — | `full` only. Pins the role an impersonated session opens under; refused when the person does not hold it. |
| `server.enduser.role` | — | The self-service role an impersonated `enduser` session opens under; empty means the server default, `SelfServiceMobile`. |
| `replicaCount` | `1` | Refused above 1 — sessions are in memory. `0` parks the release. |
| `rolloutToken` | — | Change it to roll the pod after rotating a key in `existingSecret`; the key is read once, at startup. |
| `networkPolicy.enabled` | `auto` | `auto` = on exactly when `authMode=none`. Admits `networkPolicy.from`, by default pods in the release namespace. |
| `server.maxSessionsPerSubject` | — | `MCP_MAX_SESSIONS_PER_SUBJECT`. |
| `ivanti.timeoutMs` / `ivanti.writeTimeoutMs` | — | `IVANTI_TIMEOUT_MS` / `IVANTI_WRITE_TIMEOUT_MS`; empty = the server defaults, 10000 and 30000. |
| `ivanti.impersonationRequired` | `false` | `IVANTI_IMPERSONATION_REQUIRED`, with `ivanti.configUrl`. |
| `hostAliases` | `[]` | For tenants behind split-horizon DNS. |
| `image.digest` | — | Pin this in production instead of a tag. |

Everything else — probes, resources, ingress, service account — is in `values.yaml`
with the reasoning inline.
