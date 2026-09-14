# Deployment

Three shapes, one build. A tagged release publishes a multi-arch image, a Helm chart
and a self-contained tarball from the same commit, so all three are the same code.

| | Runs as | Transport | Get it with |
|---|---|---|---|
| **Plain Node host** | a systemd service | stdio or HTTP | the release tarball |
| **Container** | `docker run` / compose | either | `tyrunas/ivanti-mcp` |
| **Kubernetes** | a Deployment | HTTP only | `oci://registry-1.docker.io/tyrunas/ivanti-mcp` |

Whatever the shape, two rules hold. **One instance serves one tenant** — staging, UAT
and production are three deployments, not three tenants in one process. And **one
instance serves one audience**: `full` and `enduser` are different products, and
mixing them is how an employee ends up holding an analyst's tool surface.

Configuration is the same everywhere and is documented in `.env.example`. The server
fails closed: an incomplete configuration exits **78** (`EX_CONFIG`) and prints every
problem at once rather than the first.

---

## 1. Plain Node host

Needs Node 22 and nothing else — no pnpm, no compiler, no network access to a registry.

```bash
curl -fsSLO https://github.com/tyrunasj/ivanti-mcp-standalone/releases/download/v0.1.0/ivanti-mcp-0.1.0.tar.gz
sudo install -d -o ivanti-mcp -g ivanti-mcp /opt/ivanti-mcp
sudo tar xzf ivanti-mcp-0.1.0.tar.gz --strip-components=1 -C /opt/ivanti-mcp
sudo chown -R ivanti-mcp:ivanti-mcp /opt/ivanti-mcp
node /opt/ivanti-mcp/dist/index.js
```

The tarball carries its own production dependencies, laid out as **real directories**
rather than pnpm's default symlink store — that store points into a content-addressed
cache and does not survive being moved to another machine.

For a service, copy `deploy/systemd/ivanti-mcp.service` to `/etc/systemd/system/` and
put the configuration in `/etc/ivanti-mcp/env` (mode `0640`, owned `root:ivanti-mcp`).
The unit mirrors the container's posture: unprivileged, read-only filesystem, no
capabilities, syscall-filtered.

**Set `STDIO_TRANSPORT_ON=false` for a service.** systemd hands the process a stdin,
and the stdio transport will sit on it waiting for a JSON-RPC stream that never comes.

Two things the unit deliberately does *not* do:

- **`MemoryDenyWriteExecute` is not set.** Node's JIT maps pages writable and then
  executable; under that directive the process dies in a way that looks like a
  segfault rather than a policy denial.
- **`RestartPreventExitStatus=78`.** A configuration error will be a configuration
  error again in five seconds; restarting just fills the journal.

Rebuilding from source instead:

```bash
pnpm install --frozen-lockfile && pnpm build && pnpm start
```

---

## 2. Container

```bash
docker pull tyrunas/ivanti-mcp:0.1.0
```

Multi-arch (`linux/amd64`, `linux/arm64`), distroless, 245 MB, runs as uid 65532.
There is no shell and no package manager in it — nothing to exec into and nothing to
install from, which is the point.

```bash
docker run -d --name ivanti-mcp --restart unless-stopped \
  --env-file .env \
  -p 3000:3000 \
  -v "$PWD/secrets:/run/secrets:ro" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  tyrunas/ivanti-mcp:0.1.0
```

Images are signed with cosign, keylessly, so there is no key to rotate or leak:

```bash
cosign verify tyrunas/ivanti-mcp:0.1.0 \
  --certificate-identity-regexp='^https://github.com/tyrunasj/ivanti-mcp-standalone/' \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com
```

Tags: `1.2.3`, `1.2`, `1` and `latest` for a final release; a prerelease publishes its
exact version only, so nobody pulls an rc by accident. Every `main` build also pushes
`main` and `sha-<short>`. Pin a digest in production.

Three things that bite, all of them recorded in `notes.md` after they bit:

- **`MCP_BIND` must be `0.0.0.0` inside a container.** Loopback there is the
  container's own, and the port publishes nothing.
- **A mounted secret keeps its host ownership**, and the image runs as 65532. A file
  written by your own account at mode 600 is unreadable inside, and the server exits
  78 with `EACCES` — which reads like a missing file rather than a permission.
- **The tenant hostname must resolve *inside* the container.** Split-horizon DNS has
  handed a container a LAN address it could not route to, failing every startup probe
  as a connection error. Pin it with `--add-host`.

---

## 3. Kubernetes

```bash
helm install ivanti-mcp oci://registry-1.docker.io/tyrunas/ivanti-mcp \
  --version 0.1.0 \
  --set server.publicUrl=https://mcp.example.com/mcp \
  --set 'server.trustedOrigins={https://claude.ai}' \
  --set ivanti.baseUrl=https://your-tenant.example.com \
  --set secrets.existingSecret=ivanti-mcp-secrets
```

The chart forces `STDIO_TRANSPORT_ON=false`, `HTTP_TRANSPORT_ON=true` and
`MCP_BIND=0.0.0.0` — none of those is a choice in a pod, so none of them is a value.

**It refuses to render rather than letting you find out later.** The server exits 78 on
a bad configuration; the chart moves that failure earlier still, to `helm install`:

| Refused | Because |
|---|---|
| no `server.publicUrl`, or one with a trailing slash | compared verbatim against the token audience |
| no `server.trustedOrigins` | origin validation is what stops DNS rebinding |
| `replicaCount > 1` without `sessionAffinity.enabled` | see below |
| `mode=enduser` with an empty allowlist | fail-closed, but almost certainly not what you meant |
| `authMode=oauth` with no issuer | discovery happens at boot, so this fails at boot |
| `authMode=none` with an ingress enabled | publishes the whole tool surface unauthenticated |

### Replicas

**Default 1, and that is not laziness.** HTTP sessions live in memory — one `McpServer`
per `Mcp-Session-Id`, created on `initialize`. Scale to two and roughly half of every
conversation's requests land on a pod that has never heard of that session. It presents
as intermittent client bugs, which is the worst way for it to present.

More than one replica needs consistent hashing on that header at the ingress. The chart
will not let you set `replicaCount: 2` without saying so explicitly:

```bash
--set replicaCount=3 --set sessionAffinity.enabled=true
```

which adds `nginx.ingress.kubernetes.io/upstream-hash-by: "$http_mcp_session_id"`.
Confirm your ingress controller honours it; the chart cannot.

### Secrets

Use `secrets.existingSecret` with keys `ivanti-api-key` and, for bearer auth,
`bearer-token`. They are mounted at `/run/secrets` with `defaultMode: 0400`, and the
pod sets `fsGroup: 65532` so the image's own user can read them — the `EACCES` trap
from the container section, closed by default.

`secrets.create=true` exists for development and puts the values in Helm history,
where `helm get values` will show them.

### Probes

`/health` is unauthenticated and always answers 200, so liveness and readiness are
plain `httpGet` — which is also the only option, since a distroless image has no curl.
The startup probe is generous (two minutes by default) because boot does real network
work: it walks the tenant's base paths against `$metadata` and opens the ASMX session.

---

## Releasing

Tag and push. The workflow refuses a tag that disagrees with `package.json`, because
the server reports its version from the manifest — a mismatch would ship an image that
misreports what it is.

```bash
# bump package.json first, then:
git tag v0.2.0 && git push origin v0.2.0
```

Repository secrets required: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (a Docker Hub
access token with Read/Write on `tyrunas/ivanti-mcp`).
