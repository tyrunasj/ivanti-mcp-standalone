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

The chart forces HTTP (stdio is meaningless in a pod) and refuses to render on a
configuration the server would reject at boot — including `replicaCount > 1` without
session affinity, because HTTP sessions are held in memory and a request routed to
another pod comes back as an unknown session.

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
| `ivanti.baseUrl` | — | **Required.** Tenant origin; the `/HEAT` prefix is probed. |
| `secrets.existingSecret` | — | Keys `ivanti-api-key`, `bearer-token`, and `ivanti-central-config-api-key` when `ivanti.configUrl` is set. Mounted `0400`. |
| `ivanti.configUrl` | — | The ConfigDB tenant. With its key in the secret, `act_as` signs in to Ivanti AS the person and every surface follows them. |
| `ivanti.impersonationRole` | — | `full` only. Pins the role an impersonated session opens under; refused when the person does not hold it. |
| `server.enduser.role` | `SelfServiceMobile` | The self-service role an impersonated `enduser` session opens under. |
| `replicaCount` | `1` | Above 1 needs `sessionAffinity.enabled=true`. |
| `hostAliases` | `[]` | For tenants behind split-horizon DNS. |
| `image.digest` | — | Pin this in production instead of a tag. |

Everything else — probes, resources, ingress, service account — is in `values.yaml`
with the reasoning inline.
