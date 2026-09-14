# Ivanti MCP

A standalone [MCP](https://modelcontextprotocol.io) server for **Ivanti Neurons for ITSM**.
It gives a model the tenant's own surface — reading records, filing tickets, running the
tenant's own quick actions, reading approvals — over stdio or authenticated HTTP.

**Forty tools in `full` mode, thirty-four in `enduser`**, plus six reference documents served
as MCP resources. Ships as a container image, a Helm chart and a self-contained tarball, all
built from one commit.

> ### 📘 [Field guide →](https://claude.ai/code/artifact/9fe31c50-b01a-4b3f-8a6d-49c520e181c9)
>
> Interactive: every setting, every tool with its real description and annotations, the
> capability tiers, the Ivanti traps — and a **configurator** that answers six questions and
> writes the `.env`, the `docker run`, the `compose.yaml`, the Helm `values.yaml` and the
> systemd unit for you.

---

## What it talks to

The server signs in to Ivanti as **one API user**, and everything it does executes as that
account — like a call-centre operator working on someone's behalf. Anything Ivanti resolves
"for the current user" therefore answers for the service account, not for whoever is chatting;
`act_as` is how a conversation says who it is helping.

Three Ivanti surfaces, and the authentication is not uniform — which is why the connection is
*probed* at startup rather than configured:

| Surface | Credential | Used for |
|---|---|---|
| OData / REST | `Authorization: rest_api_key=<key>` | records, metadata, attachments |
| ASMX services | SID cookie + CSRF token | forms, picklists, quick actions, service requests |
| `/HEAT/AdminUI/` | an admin-rights key | the complete Business Object catalog — **optional**, and everything built on it degrades instead of breaking |

## Quick start

Needs Node 22 and pnpm. A desktop client over stdio needs no authentication at all — the
credential is the ability to run the process.

```bash
pnpm install
cp .env.example .env      # set IVANTI_BASE_URL and IVANTI_API_KEY
pnpm build && pnpm start
```

The server **fails closed**: an incomplete configuration exits `78` (`EX_CONFIG`) and prints
every problem at once rather than the first.

## Deploy

Three shapes, one build. A tagged release publishes all three from the same commit, so they
cannot drift apart. Full instructions in **[`docs/deployment.md`](docs/deployment.md)**.

| | Runs as | Transport | Get it with |
|---|---|---|---|
| **Plain Node host** | a systemd service | stdio or HTTP | the release tarball — Node 22 and nothing else |
| **Container** | `docker run` / compose | either | `tyrunas/ivanti-mcp` — multi-arch, distroless, cosign-signed |
| **Kubernetes** | a Deployment | HTTP only | `oci://registry-1.docker.io/tyrunas/ivanti-mcp` — a Helm chart over that same image |

```bash
docker run -d --name ivanti-mcp --env-file .env -p 3000:3000 \
  -e MCP_BIND=0.0.0.0 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  tyrunas/ivanti-mcp:0.1.0
```

```bash
helm install ivanti-mcp oci://registry-1.docker.io/tyrunas/ivanti-mcp \
  --version 0.1.0 --namespace ivanti --create-namespace \
  --set server.publicUrl=https://mcp.example.com/mcp \
  --set 'server.trustedOrigins={https://claude.ai}' \
  --set ivanti.baseUrl=https://your-tenant.example.com \
  --set secrets.existingSecret=ivanti-mcp-secrets
```

Two rules hold whatever the shape. **One instance is one tenant** — staging, UAT and production
are three deployments. And **one instance is one audience**: `full` and `enduser` are different
products, and mixing them is how an employee ends up holding an analyst's tool surface.

## Configuration

`.env.example` is the reference and documents every setting;
[`docs/configuration.md`](docs/configuration.md) is the guide, with a per-provider OAuth walkthrough
and a symptom→cause table. Secrets take a `_FILE` suffix (`IVANTI_API_KEY_FILE`,
`BEARER_TOKEN_FILE`); setting both forms is an error rather than a precedence question.

**Transport and access are separate axes.** `STDIO_TRANSPORT_ON` and `HTTP_TRANSPORT_ON` are
independent toggles and both may be on; `AUTH_MODE` (`none` | `bearer` | `oauth`) applies only
to HTTP. An `AUTH_MODE` set while HTTP is off is an error rather than a no-op.

### Audience modes

Chosen at startup, and narrowing happens at *registration* — an unregistered tool never appears
in `tools/list`, so the model cannot call it at all.

| | `full` | `enduser` |
|---|---|---|
| Audience | IT staff | employees |
| Tools | 40 | 34 |
| Business Objects | all the credential can see | `ENDUSER_BUSINESS_OBJECTS` — a gate, not a hint; empty means none |
| `act_as` | a preference: decides who "my" means | a gate: nothing returns a record until it resolves |
| Records | anyone's — an analyst works other people's tickets | own records only |
| Quick actions | everything the role offers | `ENDUSER_QUICK_ACTIONS`, by name, on own open records |

### Capability tiers

Probed once at startup, because tools are selected once. Each rung only ever *adds* — a lower
tier is not a failure, since refusing to start would punish exactly the customers who cannot
hand an MCP server an admin key.

| Tier | The credential | What it adds |
|---|---|---|
| `odata` | the API key alone | every read tool; ~194 objects from the metadata graphs |
| `session` | the ASMX handshake opens | the identity, the role's workspaces, picklists, quick actions |
| `admin` | the admin console answers too | the complete catalog — 1,324 objects with descriptions |

`IVANTI_MAX_TIER` caps the server below what the credential can do, which is the only way to
exercise the degraded paths: `AuthenticateTenantAPIKey` ignores its own `role` argument.

## Development

```bash
pnpm dev          # tsx watch
pnpm lint         # eslint, type-aware
pnpm typecheck    # tsc --noEmit over src + config files
pnpm test         # vitest
pnpm build        # -> dist/
```

`typecheck` is not redundant with `build`: the build config excludes tests, so `typecheck` is
the only thing that type-checks the suite.

Composition runs one way — `index.ts` loads config, builds the server, then picks a transport.
Nothing lower in the stack reads `process.env`.

```
config/   env-schema -> read-secret-file -> validate-config -> load-config
auth/     identity, the per-conversation pin, oauth/ (jose/JWKS, RFC 9728)
server/   create-server -> start-stdio | start-http
ivanti/   connect: probe -> transport -> catalog
          http/ odata/ metadata/ session/ write/ people/
          quick-actions/ service-request/ attachments/
tools/    tool-definition -> register-tools (which tools this mode exposes)
          schema/ records/ search/ relationships/ notes/ knowledge/
          approvals/ quick-actions/ service-request/ attachments/ identity/ shared/
```

`tools/` is the surface that gets tuned, so it sits at the top of `src/` rather than inside
`ivanti/` — nothing under `tools/` builds a URL or parses a response.

## Documentation

| | |
|---|---|
| [Field guide](https://claude.ai/code/artifact/9fe31c50-b01a-4b3f-8a6d-49c520e181c9) | interactive reference and configurator — start here |
| [`docs/deployment.md`](docs/deployment.md) | the three shapes, the Helm chart's guards, cutting a release |
| [`docs/configuration.md`](docs/configuration.md) | configuring against a real IdP, per provider, with a symptom→cause table |
| [`docs/initial-design.md`](docs/initial-design.md) | decisions and why — including, in §10, what was rejected and for what reason |
| [`docs/notes.md`](docs/notes.md) | traps: things that pass locally and fail elsewhere |
| [`charts/ivanti-mcp/README.md`](charts/ivanti-mcp/README.md) | the chart's values and what it refuses to render |
| [`CLAUDE.md`](CLAUDE.md) | orientation for agents working in this repository |

`docs/initial-design.md` is the source of truth for design decisions; read it before proposing
architectural changes, because several obvious-looking simplifications were already considered
and turned down for stated reasons.
