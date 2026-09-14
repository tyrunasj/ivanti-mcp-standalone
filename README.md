# Ivanti MCP

A standalone [MCP](https://modelcontextprotocol.io) server for **Ivanti Neurons for ITSM**.
It gives a model the tenant's own surface — reading records, filing tickets, running the
tenant's own quick actions, reading approvals — over stdio or authenticated HTTP.

**Forty tools in `full` mode, thirty-four in `enduser`**, plus six reference documents served
as MCP resources. Ships as a container image, a Helm chart and a self-contained tarball, all
built from one commit.

> ### 📘 The Handbook — [`docs/handbook.html`](docs/handbook.html)
>
> A single self-contained page: every setting, every tool with its real description and
> annotations, the capability tiers, the Ivanti traps — and a **configurator** that answers six
> questions and writes the `.env`, the `docker run`, the `compose.yaml`, the Helm `values.yaml`
> and the systemd unit for you.
>
> It is one file with no build step and no network dependency beyond web fonts, so **open it
> from a clone** — `open docs/handbook.html`, or serve the directory — rather than from
> GitHub's file view, which shows the source instead of rendering it.
>
> It covers *running* the server from a published build. Everything about working on the source —
> the toolchain, the tests, building the image yourself — is in this file instead.

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

## Quick start, from source

Needs Node 22 and pnpm. A desktop client over stdio needs no authentication at all — the
credential is the ability to run the process.

```bash
pnpm install
cp .env.example .env      # set IVANTI_BASE_URL and IVANTI_API_KEY
pnpm build && pnpm start
```

The server **fails closed**: an incomplete configuration exits `78` (`EX_CONFIG`) and prints
every problem at once rather than the first.

To run it without a clone at all, take a published build — see below.

## Deploy

Three shapes, one build. A tagged release publishes all three from the same commit, so they
cannot drift apart. Full instructions in **[`docs/deployment.md`](docs/deployment.md)**.

| | Runs as | Transport | Get it with |
|---|---|---|---|
| **Plain Node host** | a systemd service | stdio or HTTP | the release tarball — Node 22 and nothing else |
| **Container** | `docker run` / compose | either | `tyrunas/ivanti-mcp` — multi-arch, distroless, cosign-signed |
| **Kubernetes** | a Deployment | HTTP only | `oci://ghcr.io/tyrunasj/charts/ivanti-mcp` — a Helm chart over that same image |

```bash
docker run -d --name ivanti-mcp --env-file .env -p 3000:3000 \
  -e MCP_BIND=0.0.0.0 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  tyrunas/ivanti-mcp:0.1.0
```

```bash
helm install ivanti-mcp oci://ghcr.io/tyrunasj/charts/ivanti-mcp \
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

**To start from something that runs, not from a blank file**, copy one of the eight in
[`examples/env/`](examples/env) — stdio, loopback HTTP, shared bearer, `enduser`, OAuth against
Entra or Keycloak, both transports at once, and a tier-capped one for reproducing what a
customer without admin rights gets:

```bash
cp examples/env/shared-bearer.env .env
```

They are checked rather than merely written: `pnpm check:examples` drives every one through the
real `loadConfig`, the same code path the server runs at boot, and CI fails if any would exit
`78`. An example that does not load is worse than no example, because it gets copied before it
gets read.

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

### Building the image yourself

Everything container-related lives in `docker/`, but **the build context is the repository
root** — `.dockerignore` is at the root because that is where the classic builder looks for it.

```bash
docker build -f docker/Dockerfile -t ivanti-mcp .
docker compose -f docker/compose.yaml up --build
```

Three stages: build → production dependencies → a distroless runtime
(`gcr.io/distroless/nodejs22-debian12`, uid 65532, no shell, no package manager).
**55.4 MB to pull** on amd64, 55.0 MB on arm64 — measured on the published manifest, of which
52.6 MB is the distroless Node base and the rest is ours. `docker images` reports ~235 MB, which is
the uncompressed size on disk, not the download.

Alpine is not smaller: `node:22-alpine` is 57.7 MB compressed, and it brings a shell and a package
manager with it. The deps stage deletes `*.d.ts`, `*.md` and `*.map` from `node_modules` — 10 MB of
28, none of it read by a running process, since source maps need `--enable-source-maps` and the
image does not pass it. LICENCE files stay, because the notices have to travel with the copy.

- **pnpm's symlinked `node_modules` does not survive a `COPY` between stages.** The dependency
  stage installs with `--node-linker=hoisted` so the layout is real directories. The release
  tarball (`scripts/release-tarball.sh`) mirrors that stage for the same reason.
- **`package.json` ships next to `dist/`.** `src/version.ts` reads it at startup and the server
  refuses to start without it, rather than reporting a placeholder version.
- **The health check is a Node script** (`docker/healthcheck.mjs`) — a distroless image has no
  shell and no curl.

`docker/compose.yaml` builds from source and is for working on the server. To *run* a published
build with compose, use the Handbook's configurator, which emits a compose file pinned to the
published image instead of a build context.

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
| [`docs/handbook.html`](docs/handbook.html) | the Handbook — interactive reference and configurator; open it in a browser, start here |
| [`examples/env/`](examples/env) | eight working configurations, one per deployment shape — CI proves they load |
| [`docs/deployment.md`](docs/deployment.md) | the three shapes, the Helm chart's guards, cutting a release |
| [`docs/configuration.md`](docs/configuration.md) | configuring against a real IdP, per provider, with a symptom→cause table |
| [`docs/initial-design.md`](docs/initial-design.md) | decisions and why — including, in §10, what was rejected and for what reason |
| [`docs/notes.md`](docs/notes.md) | traps: things that pass locally and fail elsewhere |
| [`charts/ivanti-mcp/README.md`](charts/ivanti-mcp/README.md) | the chart's values and what it refuses to render |
| [`CLAUDE.md`](CLAUDE.md) | orientation for agents working in this repository |
| [`LICENSE`](LICENSE) · [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | the commercial terms, and the components distributed with it |

`docs/initial-design.md` is the source of truth for design decisions; read it before proposing
architectural changes, because several obvious-looking simplifications were already considered
and turned down for stated reasons.

## Licence

Copyright © 2026 SYNERGY. All rights reserved. **This software is licensed, not sold** — see
[`LICENSE`](LICENSE). No right to use it is granted except under a written commercial agreement
with SYNERGY, save for a thirty-day internal evaluation, which is why the image and the chart are
public to pull.

The third-party components it is distributed with keep their own terms, which this licence does
not affect; they are listed with their notices in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) — 99 components, all permissive. That file is
generated from the production dependency tree with `pnpm licenses`, ships inside the image and
the tarball, and CI fails if it drifts from what actually ships.
