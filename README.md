# Ivanti MCP

A standalone [MCP](https://modelcontextprotocol.io) server for **Ivanti Neurons for ITSM** — reading
records, filing tickets, running the tenant's own quick actions, handling approvals — over stdio or
authenticated HTTP. **41 tools in `full` mode, 34 in `enduser`**, plus six reference documents
served as MCP resources. Ships as a container image, a Helm chart and a tarball, all built from one
commit.

> ### 📘 The Handbook — [`docs/handbook.html`](docs/handbook.html)
>
> One self-contained page: every setting, every tool with its real description and annotations, the
> capability tiers, the Ivanti traps — and a **configurator** that writes the `.env`, `docker run`,
> `compose.yaml`, Helm `values.yaml` and systemd unit from six answers. **Open it from a clone**
> (`open docs/handbook.html`); GitHub's file view shows the source. It covers *running* a published
> build; working on the source is [`docs/development.md`](docs/development.md).

## What it talks to

The server signs in to Ivanti as **one API user** and, by default, acts as that account — like a
call-centre operator working on someone's behalf. So anything Ivanti resolves "for the current
user" answers for the service account; `act_as` is how a conversation says who it is helping, and
every other tool refuses until it has.

**Given a ConfigDB key it signs in *as* the person.** With `IVANTI_CONFIG_URL` and
`IVANTI_CENTRAL_CONFIG_API_KEY` set, `act_as` opens a real Ivanti session for them: Ivanti applies
their own access — a self-service role reads none of the incidents an analyst reads — and what they
create, note, run or file carries their name. Without the pair, the server behaves as above. See
[`docs/impersonation-plan.md`](docs/impersonation-plan.md).

The connection is *probed* at startup, because the surfaces authenticate differently:

| Surface | Credential | Used for |
|---|---|---|
| OData / REST | `Authorization: rest_api_key=<key>` | records, metadata, attachments |
| ASMX services | SID cookie + CSRF token | forms, picklists, quick actions, service requests |
| `/HEAT/AdminUI/` | an admin-rights key | the complete catalog — **optional**; everything built on it degrades instead of breaking |

## Quick start, from source

Node 22 and pnpm. A desktop client over stdio needs no authentication — the credential is the
ability to run the process.

```bash
pnpm install
cp .env.example .env      # set IVANTI_BASE_URL and IVANTI_API_KEY
pnpm build && pnpm start
```

It **fails closed**: an incomplete configuration exits `78` and lists every problem at once.

## Deploy

| | Runs as | Transport | Get it with |
|---|---|---|---|
| **Plain Node host** | a systemd service | stdio or HTTP | the release tarball — Node 22 and nothing else |
| **Container** | `docker run` / compose | either | `tyrunas/ivanti-mcp` — multi-arch, distroless, cosign-signed |
| **Kubernetes** | a Deployment | HTTP only | `oci://ghcr.io/tyrunasj/charts/ivanti-mcp` |

```bash
docker run -d --name ivanti-mcp --env-file .env -p 127.0.0.1:3000:3000 -e MCP_BIND=0.0.0.0 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  tyrunas/ivanti-mcp:$VERSION        # a release from the Releases page
```

The chart package on ghcr.io is currently **private**, so `helm install` needs a GHCR credential
until it is made public. **One instance is one tenant, and one audience** — staging, UAT and
production are three deployments, and `full` and `enduser` are different products. Everything else:
[`docs/deployment.md`](docs/deployment.md).

## Configuration

`.env.example` documents every setting; [`docs/configuration.md`](docs/configuration.md) is the
guide, with a per-provider OAuth walkthrough and a symptom → cause table. Secrets also take a
`_FILE` form; giving both forms is an error. To start from something that runs, copy one of the
nine in [`examples/env/`](examples/env) — CI loads each through the real `loadConfig` and fails if
any would exit 78.

**Transport and access are separate axes.** `STDIO_TRANSPORT_ON` and `HTTP_TRANSPORT_ON` are
independent and may both be on; `AUTH_MODE` (`none` | `bearer` | `oauth`) applies only to HTTP,
and setting it with HTTP off is an error.

### Audience modes

Chosen at startup; narrowing happens at registration, so an unregistered tool is not in
`tools/list` at all.

| | `full` | `enduser` |
|---|---|---|
| Audience | IT staff | employees |
| Tools | 41 | 34 |
| Business Objects | all the credential can see | `ENDUSER_BUSINESS_OBJECTS` — a gate; empty means none |
| `act_as` | required; decides who "my" means | required; decides whose records these are |
| Records | anyone's | own records only |
| Quick actions | everything the role offers | `ENDUSER_QUICK_ACTIONS`, by name, on own open records |
| Ivanti role, when impersonating | the active one or `IVANTI_IMPERSONATION_ROLE`; `switch_role` changes it | `ENDUSER_ROLE` (default `SelfServiceMobile`), fixed |

### Capability tiers

Probed once at startup. Each tier only adds; a lower one is not a failure.

| Tier | The credential | Adds |
|---|---|---|
| `odata` | the API key alone | every read tool; ~194 objects |
| `session` | the ASMX handshake opens | identity, workspaces, picklists, quick actions |
| `admin` | the admin console answers too | the complete catalog — 1,324 objects |

`IVANTI_MAX_TIER` caps the server below its credential — the only way to exercise the degraded
paths, since Ivanti ignores the handshake's `role` argument.

## Development

`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` — commands, the live-tenant loop and the
toolchain constraints are in [`docs/development.md`](docs/development.md); building the image is in
[`docs/deployment.md`](docs/deployment.md#how-the-image-is-built). The source layout and its rules
are in [`CLAUDE.md`](CLAUDE.md), and the reasoning in [`docs/architecture.md`](docs/architecture.md).
What the server's text costs a conversation — `pnpm manifest:size`, `pnpm usage:report`, and the
loop for tuning a description — is [`docs/usage.md`](docs/usage.md).

## Documentation

| | |
|---|---|
| [`docs/handbook.html`](docs/handbook.html) | the Handbook — interactive reference and configurator; start here |
| [`examples/env/`](examples/env) | nine working configurations — CI proves they load |
| [`docs/configuration.md`](docs/configuration.md) | configuring against a real IdP, with a symptom → cause table |
| [`docs/deployment.md`](docs/deployment.md) | the three shapes, the chart's guards, the image build, releasing |
| [`docs/architecture.md`](docs/architecture.md) | how the server works and why |
| [`docs/development.md`](docs/development.md) | commands, checks, testing against the live tenant |
| [`docs/usage.md`](docs/usage.md) | what the tool descriptions and results cost a conversation, the failed turns they cause, and how to tune them |
| [`docs/initial-design.md`](docs/initial-design.md) | decisions — and, in §10, what was rejected and why. Read before proposing architectural changes |
| [`docs/impersonation-plan.md`](docs/impersonation-plan.md) | signing in as the person, through CentralConfig |
| [`docs/notes.md`](docs/notes.md) | traps: things that pass locally and fail elsewhere |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | what was built, in what order, and what remains |
| [`docs/review/`](docs/review) | a full-codebase review, with what was refuted and what nobody looked at |
| [`charts/ivanti-mcp/README.md`](charts/ivanti-mcp/README.md) | the chart's values and what it refuses to render |
| [`CLAUDE.md`](CLAUDE.md) | orientation for agents working in this repository |
| [`LICENSE`](LICENSE) · [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | the commercial terms, and the components distributed with it |

## Licence

Copyright © 2026 SYNERGY. All rights reserved. **This software is licensed, not sold** — see
[`LICENSE`](LICENSE). No right to use it is granted except under a written commercial agreement with
SYNERGY, save for a thirty-day internal evaluation, which is why the image is public to pull.

Third-party components keep their own terms, listed in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) — 99 components, all permissive. It is generated
from the production dependency tree with `pnpm licenses`, ships inside the image and the tarball,
and CI fails if it drifts from what ships.
