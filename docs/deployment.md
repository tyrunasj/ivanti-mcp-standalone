# Deployment

Three shapes, one build. A release publishes a multi-arch image, a Helm chart and a self-contained
tarball from the same commit.

| | Runs as | Transport | Get it with |
|---|---|---|---|
| **Plain Node host** | a systemd service | stdio or HTTP | the release tarball |
| **Container** | `docker run` / compose | either | `tyrunas/ivanti-mcp` on Docker Hub |
| **Kubernetes** | a Deployment | HTTP only | `oci://ghcr.io/tyrunasj/charts/ivanti-mcp` |

**The image and the chart live in different registries on purpose.** `helm push` derives the
repository from the chart name, so pushing `ivanti-mcp` to Docker Hub's `tyrunas` namespace would
overwrite the image; ghcr.io nests, so the chart lives under `charts/`.

**The chart package is private** (checked 2026-09-28), as every package pushed by `GITHUB_TOKEN`
starts. Until it is made public, an anonymous `helm pull` or `helm install` answers 403 — which is
also why the home-lab deploy reads the chart from git. Making it public is a one-time setting:
*repository → Packages → `charts/ivanti-mcp` → Package settings → Change visibility → Public*. The
Docker Hub image is public.

Everywhere: **one instance serves one tenant** (staging, UAT and production are three deployments)
and **one audience** (`full` and `enduser` are different products — mixing them hands an employee
an analyst's tools). Every setting is in `.env.example`; an incomplete configuration exits **78**
and lists every problem at once.

In the commands below, set `VERSION` to a release from
<https://github.com/tyrunasj/ivanti-mcp-standalone/releases>.

## 1. Plain Node host

Node 22 and nothing else — no pnpm, no compiler, no registry access.

```bash
curl -fsSLO https://github.com/tyrunasj/ivanti-mcp-standalone/releases/download/v$VERSION/ivanti-mcp-$VERSION.tar.gz
sudo install -d -o ivanti-mcp -g ivanti-mcp /opt/ivanti-mcp
sudo tar xzf ivanti-mcp-$VERSION.tar.gz --strip-components=1 -C /opt/ivanti-mcp
sudo chown -R ivanti-mcp:ivanti-mcp /opt/ivanti-mcp
node /opt/ivanti-mcp/dist/index.js
```

The tarball carries its production dependencies as real directories — pnpm's symlink store does not
survive moving machines. As a service: copy `deploy/systemd/ivanti-mcp.service` to
`/etc/systemd/system/`, with configuration in `/etc/ivanti-mcp/env` (`0640`, `root:ivanti-mcp`). The
unit runs unprivileged, read-only, with no capabilities and a syscall filter.

- **Set `STDIO_TRANSPORT_ON=false` for a service** — systemd hands it a stdin, and stdio would wait
  on it forever.
- **`MemoryDenyWriteExecute` is deliberately not set** — Node's JIT needs writable-then-executable
  pages, and the failure looks like a segfault.
- **`RestartPreventExitStatus=78`** — a configuration error will still be one in five seconds.

From source: `pnpm install --frozen-lockfile && pnpm build && pnpm start`.

## 2. Container

```bash
docker run -d --name ivanti-mcp --restart unless-stopped \
  --env-file .env -p 3000:3000 \
  -v "$PWD/secrets:/run/secrets:ro" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  tyrunas/ivanti-mcp:$VERSION
```

Multi-arch (`amd64`, `arm64`), distroless, uid 65532, no shell and no package manager. **~55 MB to
pull**, of which 52.6 MB is the distroless Node base; the ~235 MB `docker images` prints is the
uncompressed size. Images are signed keylessly with cosign:

```bash
cosign verify tyrunas/ivanti-mcp:$VERSION \
  --certificate-identity-regexp='^https://github.com/tyrunasj/ivanti-mcp-standalone/' \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com
```

Tags: `1.2.3`, `1.2`, `1` and `latest` for a release; a prerelease publishes its exact version only.
Every `main` build also pushes `main` and `sha-<short>`. Pin a digest in production.

Three things that bite, all recorded in `notes.md`:

- **`MCP_BIND=0.0.0.0` inside a container** — its loopback is its own.
- **A mounted secret keeps its host ownership**, and the image runs as 65532: a mode-600 file you
  own is unreadable inside, and the exit-78 `EACCES` reads like a missing file.
- **The tenant hostname must resolve inside the container** — split-horizon DNS has handed one a LAN
  address it could not route to. Pin it with `--add-host`.

### How the image is built

Everything is in `docker/` (`Dockerfile`, `compose.yaml`, `healthcheck.mjs`), but the **build
context is the repository root**, and `.dockerignore` stays there:

```bash
docker build -f docker/Dockerfile -t ivanti-mcp .
docker compose -f docker/compose.yaml up
```

Three stages: build → production dependencies → distroless runtime. Alpine is not smaller —
`node:22-alpine` is 57.7 MB compressed and brings a shell and a package manager. `compose.yaml`
builds from source and is for working on the server; to run a published build with compose, the
Handbook's configurator emits one pinned to the image.

- **Dependencies install with `--node-linker=hoisted`**, because pnpm's symlinked `node_modules`
  does not survive a `COPY` between stages.
- **The dependency stage prunes `*.d.ts`, `*.md` and `*.map`** (10 MB of 28) — nothing a running
  process reads, since this image does not pass `--enable-source-maps`. Licence files stay.
  `scripts/release-tarball.sh` mirrors the prune, which is why the tarball is ~3 MB.
- **`package.json` ships next to `dist/`** — the server reads its version from it and refuses to
  start without it.
- **The health check is a Node script**, since there is no shell or curl. It exits 0 when HTTP is
  off: reporting a stdio deployment unhealthy for running as configured would be worse than not
  checking.
- Verified on Docker Desktop on macOS (arm64) and Docker 29.1.3 on Ubuntu 26.04 (x86_64).

## 3. Kubernetes

```bash
helm install ivanti-mcp oci://ghcr.io/tyrunasj/charts/ivanti-mcp \
  --version $VERSION \
  --set server.publicUrl=https://mcp.example.com/mcp \
  --set 'server.trustedOrigins={https://claude.ai}' \
  --set ivanti.baseUrl=https://your-tenant.example.com \
  --set secrets.existingSecret=ivanti-mcp-secrets
```

(Anonymous access needs the chart package made public — see the top of this page.)

The chart forces `STDIO_TRANSPORT_ON=false`, `HTTP_TRANSPORT_ON=true` and `MCP_BIND=0.0.0.0` — none
is a choice in a pod. **It refuses to render** what the server would refuse to start with, moving
the failure to `helm install`:

| Refused | Because |
|---|---|
| no `server.publicUrl`, or one with a trailing slash | compared verbatim against the token audience |
| no `server.trustedOrigins` | origin validation stops DNS rebinding |
| `replicaCount > 1` without `sessionAffinity.enabled` | sessions are in memory — below |
| `mode=enduser` with an empty allowlist | fail-closed, but almost certainly not meant |
| `authMode=oauth` with no issuer | discovery happens at boot |
| `authMode=none` with an ingress | publishes the tool surface unauthenticated |

- **One replica by default.** Sessions live in memory, one `McpServer` per `Mcp-Session-Id`; with
  two pods about half of each conversation lands on one that has never seen it, which looks like
  intermittent client bugs. More needs consistent hashing on that header:
  `--set replicaCount=3 --set sessionAffinity.enabled=true` adds
  `nginx.ingress.kubernetes.io/upstream-hash-by: "$http_mcp_session_id"` — confirm your ingress
  honours it.
- **Secrets:** `secrets.existingSecret` with keys `ivanti-api-key` and, for bearer auth,
  `bearer-token`, mounted at `/run/secrets` (`0400`) with `fsGroup: 65532` so the image's user can
  read them. `secrets.create=true` is for development — it puts the values in Helm history.
- **Probes:** `/health` is unauthenticated and always 200, so liveness and readiness are plain
  `httpGet`. The startup probe allows two minutes, because boot probes the tenant and opens the
  ASMX session.

## Releasing

**Releasing and deploying are separate buttons.** Releasing publishes an image to Docker Hub, a
chart to ghcr.io and a tarball to the GitHub release; nothing reaches a cluster until it is deployed.

`package.json` is the only place a version is written. `pnpm version:sync` mirrors it into
`Chart.yaml` (`version` and `appVersion`), and `pnpm version:check`, run on every CI build, fails if
the three disagree. **The tag is an output of the release** — pushing one by hand triggers nothing.

```bash
/ship --release                 # bumps the patch, syncs the chart, PR, merge to main
# Actions → Release             (this repo)        image + chart + tarball, then the tag
# Actions → deploy-ivanti-mcp   (k3s-home-lab)     moves targetRevision; ArgoCD syncs
```

The **Release** workflow (`workflow_dispatch` only) reads `package.json`, refuses a version already
released, runs the same checks as CI, publishes, and **creates the tag last**, at the commit it built
and signed — so a run that dies halfway retries by pressing the button again instead of leaving an
orphan tag. Every `docker/metadata-action` tag carries an explicit `value=`: its semver patterns read
`github.ref_name`, which on a manual run is the branch, and the image would publish as `main`. A
prerelease (`0.3.0-rc.1`) publishes its exact version only.

| Artifact | Version from |
|---|---|
| `tyrunas/ivanti-mcp:<v>` (+ `<major.minor>`, `<major>`, `latest`) | `package.json` |
| the chart, pushed OCI | `Chart.yaml`, kept in step by `version:sync` |
| `ivanti-mcp-<v>.tar.gz` on the release | `package.json`, via `release-tarball.sh` |
| the tag `v<v>` and the GitHub release | `package.json` |

**CI and Release share one check list**, `.github/actions/checks`. It used to be written twice, and
the release ran a subset that skipped `check:examples` and `check:licenses` — which validate two
files the tarball ships. It is a composite action, not a reusable workflow, because the release
needs the `dist/` the checks leave behind. Every check runs even after one fails.

**`main` is protected, admins included.** A PR is required; `Checks` and `Image` must be green; the
branch must be up to date; force-pushes and deletions are refused; there is no bypass.

Repository secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (Read/Write on `tyrunas/ivanti-mcp`).

## Deploying to k3s-home-lab

The cluster runs this through ArgoCD, and **releasing does not touch it**. `argocd-apps/ivanti-mcp.yaml`
in `tyrunasj/k3s-home-lab` is a multi-source Application: the chart from this repo at a release
**tag** (from git, because the ghcr package is private), the values from that repo at `main`.

Deploying is **Actions → deploy-ivanti-mcp → Run workflow** there, with a tag or empty for the
latest. It checks that `Chart.yaml` at that tag agrees with the tag — `appVersion` *is* the deployed
image tag, since `values.yaml` leaves `image.tag` empty, and drift would run an image nobody chose
while ArgoCD reports Synced — then moves `targetRevision` and commits. ArgoCD (automated, `selfHeal`,
`prune`) does the rest. Values-only changes skip all of this: edit
`infrastructure/ivanti-mcp/values.yaml` and merge.
