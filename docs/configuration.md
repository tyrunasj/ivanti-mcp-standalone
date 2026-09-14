# Configuration guide

`.env.example` is the reference — every setting, with its default. This is the guide: how to
set the server up against a real identity provider, and what goes wrong.

## Three decisions, in order

| Decision | Settings | Question it answers |
|---|---|---|
| **Transport** | `STDIO_TRANSPORT_ON`, `HTTP_TRANSPORT_ON` | How is the server reached? |
| **Access** | `AUTH_MODE` and its credentials | Who may connect? |
| **Capability** | `MCP_MODE`, `ENDUSER_BUSINESS_OBJECTS` | What may they do? |

They are independent. `AUTH_MODE` is a **door**, not an identity: it decides whether a client may
connect at all. Who an operation is *for* is the `Customer` field on the Ivanti record, which is a
separate concern entirely.

The server **fails closed**. An incomplete configuration exits `78` (`EX_CONFIG`) and prints every
problem at once — not just the first.

---

## The audience problem — read this before configuring OAuth

The MCP spec has clients send `resource=<canonical MCP URL>` (RFC 8707), and servers validate that
the token was issued for them. A reasonable reading is that `aud` will contain your MCP URL.

**It will not. No mainstream identity provider works that way.**

| IdP | What lands in `aud` |
|---|---|
| Entra ID | **depends on the token version.** v2.0: the API's client id, a bare GUID. v1.0: the Application ID URI, e.g. `api://<app-guid>`. `requestedAccessTokenVersion` on the app registration decides which |
| Zitadel | a numeric project or client id |
| Okta | the authorization server's audience setting |
| Keycloak | typically the client id |
| Auth0 | the `audience` parameter the client passed |

So `OAUTH_AUDIENCE` is configured **independently** of `MCP_PUBLIC_URL`. It is a comma-separated
list, and a token is accepted when its `aud` contains **any** entry — the token's own `aud` may
itself be an array, so this is a set intersection, not an equality check.

A verifier written to the spec's literal wording rejects every real token. This is the single most
common reason OAuth "doesn't work" here.

---

## Redirect URIs — whose are they?

Two different URLs get confused here, and only one of them is ours.

| URL | Belongs to | Production value |
|---|---|---|
| `MCP_PUBLIC_URL` | **this server** | always an FQDN: `https://mcp.example.com/mcp` |
| the redirect URI | **the client** | depends on what kind of client it is |

The redirect URI is where the identity provider sends the user *back to* after login — so it is a
property of the client application, never of this server. We neither host it nor see it.

### A loopback redirect is not "dev mode"

For a **native client** — a CLI or desktop app such as Claude Code — `http://localhost:<port>/callback`
is the correct production value. The app opens a browser, listens on a loopback port, and receives
the authorization code back on it. There is no server to redirect to; the client *is* the endpoint.

This is the pattern RFC 8252 (*OAuth 2.0 for Native Apps*) prescribes, and the MCP spec blesses it
explicitly:

> All redirect URIs **MUST** be either `localhost` or use HTTPS.

So a tenant full of `http://localhost:…` redirects for CLI clients is not a lax configuration. It
is the only thing a native client can do, and every provider special-cases loopback for exactly
this reason — which is why `http://` is permitted there and nowhere else.

### When the redirect *is* an FQDN

A **web-hosted client** redirects to its own domain, e.g. `https://claude.ai/api/mcp/auth_callback`
or your own portal. Then:

- register that URL instead of a loopback one;
- it **must** be HTTPS — no provider will accept plain `http` on a non-loopback host;
- there is no `--callback-port`, because the client is not listening locally.

### What this changes in practice

Nothing about `MCP_PUBLIC_URL`: that is *our* address and is an FQDN behind TLS in any real
deployment. The loopback URIs in the sections below are the client's, and they stay loopback for
CLI clients no matter how production the environment is.

The genuinely dev-only settings are different ones — Zitadel's *Dev Mode* toggle and similar exist
to allow plain `http` on a **non**-loopback host, which is what you should not ship.

---

## Microsoft Entra ID

The majority deployment. Always issues JWTs, so there is no opaque-token trap — but four settings
decide whether it works, and three of them default wrong for this use.

> ### Prerequisite: a public HTTPS hostname on a tenant-verified domain
>
> **This is not optional and cannot be worked around.** Two requirements meet:
>
> - the **client** validates that the RFC 9728 `resource` equals the endpoint it connected to;
> - **Entra** requires `resource` to be a registered Application ID URI. Under the `api://`
>   scheme a GUID must match the app id or the tenant id, and an arbitrary string must sit on a
>   verified custom domain or the tenant's initial domain; `api://<appId>` is the recommended
>   form. HTTPS is permitted on a domain in the tenant's verified list.
>
> So the MCP server's own URL must *be* the Application ID URI. `http://localhost:3000/mcp` can
> never be one, which means **Entra cannot be tested against a local server** — no override
> helps, because a conforming client rejects any `resource` that is not its endpoint.
>
> Deploy at e.g. `https://mcp.example.com/mcp` on a verified domain first. Then the App ID URI,
> `MCP_PUBLIC_URL`, `OAUTH_AUDIENCE` and the endpoint are one identical string, and the rest of
> this section is straightforward.
>
> If *Custom domain names* refuses to verify while your DNS is demonstrably correct, the domain
> is almost certainly claimed by another Microsoft tenant — often an unmanaged one created when
> someone signed up for a free service with an address at that domain. That is an admin-takeover
> or support case, not a DNS problem; check from the command line before spending time on it:
> `dig +short @8.8.8.8 <domain> TXT`.

### One app registration is enough

It can both expose the API and act as the client, which is simpler than wiring two.

**1. Expose an API**

*App registration → Expose an API*
- **Application ID URI**: `api://<app-guid>` (the default) or a friendly name
- **Add a scope**: e.g. `mcp.access`, *Admins and users* can consent

**2. Authentication — the platform choice matters more than it looks**

*App registration → Authentication → Add a platform → **Mobile and desktop applications***
- Redirect URI: `http://localhost/callback` — **omit the port**. Microsoft ignores the port
  component for localhost URIs, matching on path alone, so one entry covers whatever port the
  client happens to pick. Registering a specific port works too but pins you to it.
  Loopback is correct for a CLI client in production, not just development; see *Redirect URIs*
  above. Use the client's own HTTPS URL instead if the client is web-hosted.

  Two related rules from the same page: **do not register URIs differing only by port** — since
  the port is ignored, the login server picks one arbitrarily; differentiate by *path*. And the
  **IPv6 loopback `::1` is not supported**, so use `localhost`.

  The three checkboxes the portal offers — `.../oauth2/nativeclient`, LiveSDK, and
  `msal<guid>://auth` — are broker and custom-scheme defaults. None apply to a client that uses
  a plain loopback listener.
- **Allow public client flows: Yes**

Adding the redirect under *Web* instead puts it in a different manifest array and Entra then
treats the app as a confidential client that must present a secret — which a CLI cannot do. In the
manifest the difference is visible:

```jsonc
"publicClient": { "redirectUris": ["http://localhost:55266/callback"] },  // correct
"web":          { "redirectUris": [] },                                   // must be empty
"allowPublicClient": true          // defaults to false, i.e. confidential
```

**3. Manifest — the access token version**

```jsonc
"api": {
  "requestedAccessTokenVersion": 2
}
```

**This is the one people miss.** It defaults to `null`, meaning v1, and v1 changes the issuer to
`https://sts.windows.net/<tid>/` while v2 issues `https://login.microsoftonline.com/<tid>/v2.0`.
`OAUTH_ISSUER` is matched exactly, so a v1 token is rejected with a message about the issuer that
looks nothing like "you forgot a manifest field".

**4. API permissions**

*Delegated* → *My APIs* → this app → `mcp.access`, plus the usual `openid`, `profile`,
`offline_access`.

**No Microsoft Graph permissions beyond OIDC basics, and no application permissions at all.** The
server never calls Microsoft. It fetches the public JWKS document unauthenticated and verifies a
signature locally — the token is evidence, not an access key.

**Optional: skip the consent prompt.** If the client and API are the same registration, or you
want to pre-approve a known client, add it to `preAuthorizedApplications`:

```jsonc
"api": {
  "requestedAccessTokenVersion": 2,
  "preAuthorizedApplications": [
    { "appId": "<client-app-guid>", "permissionIds": ["<scope-guid>"] }
  ]
}
```

### Single-tenant only

Set `signInAudience` to **`AzureADMyOrg`**.

Our verifier matches `iss` **exactly** against `OAUTH_ISSUER`. That is correct and simple for a
single-tenant app, where the issuer is a fixed string. A **multi-tenant** app is different:
Microsoft's tenant-independent metadata returns an issuer containing a `{tenantid}` placeholder
which a validator is expected to substitute with the token's own `tid` claim before comparing.

We do not implement that substitution, so **multi-tenant Entra apps are not supported** — a token
from any tenant would fail the issuer check. A separate deployment per tenant is the supported
shape, and matches the one-instance-one-tenant decision anyway (design §2).

Also note: if `signInAudience` is `AzureADandPersonalMicrosoftAccount`, `requestedAccessTokenVersion`
**must** be 2 — Entra enforces that pairing.

### Server settings

```bash
AUTH_MODE=oauth
MCP_PUBLIC_URL=https://mcp.example.com/mcp
TRUSTED_ORIGINS=https://claude.ai
OAUTH_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OAUTH_AUDIENCE=api://<app-guid>
```

`OAUTH_AUDIENCE` is the **Application ID URI**, not `MCP_PUBLIC_URL`. Entra may also emit the bare
client GUID as the audience depending on how the token was requested — if verification fails,
decode the token and read its real `aud` rather than guessing. The setting takes a list, so both
values can be accepted at once.

### Client registration

**Entra supports no Dynamic Client Registration**, so the client must be pre-registered and pinned:

```bash
claude mcp add --transport http ivanti http://127.0.0.1:3000/mcp \
  --client-id <app-guid> --callback-port <port>
```

The port must match the redirect URI exactly.

### Two Entra quirks worth knowing

**Discovery resolves only on the third probe.** Its issuer carries a path, and both
path-insertion forms return 404 — only `{issuer}/.well-known/openid-configuration` answers.
Verified against live tenants; an implementation that tries fewer candidates cannot reach Entra.

**Entra publishes no `code_challenge_methods_supported`.** The spec says a client **MUST refuse to
proceed** when it is absent, and Entra is the only provider of ten surveyed that omits it — while
supporting PKCE S256 in practice. Whether a given client is strict about this cannot be fixed from
the server side. See design §12.

---

## Zitadel

Supports DCR, but **do not rely on it** — see the token-type trap below.

**Create**
1. *Projects* → your project (or create one)
2. *Applications* → **New** → type **Native** (a CLI client is a public client)
3. Authentication method: **None** — PKCE, no client secret
4. Redirect URI: `http://localhost:<port>/callback`
5. Copy the **Client ID** shown after creation

**The setting that decides whether any of this works**

*Application → Token Settings → **Auth Token Type: JWT***

Zitadel's default is **Bearer**, which is an opaque reference token. A JWKS verifier cannot
inspect one at all — there is no header, no signature, nothing to check — and the server will
reject it with *"Access token is opaque, not a JWT"*.

**Why pinning the client matters here specifically:** Zitadel supports Dynamic Client
Registration, so a client that registers itself gets a brand-new application which inherits the
instance default — Bearer. Flipping one app to JWT therefore lasts only until the next
re-authentication creates another. Pin the client id and the problem disappears.

**Server config**
```bash
OAUTH_ISSUER=https://your-instance.zitadel.cloud
OAUTH_AUDIENCE=<client-id>        # Zitadel always puts the requesting client id in aud
OAUTH_SCOPES_SUPPORTED=openid,profile
```

**Client**
```bash
claude mcp add --transport http ivanti http://127.0.0.1:3000/mcp \
  --client-id <client-id> --callback-port <port>
```

**Not needed:** the proprietary scope `urn:zitadel:iam:org:project:id:<projectId>:aud`, which adds
a *project* to the audience. The client id is always in `aud` anyway, so target that and skip the
Zitadel-specific coupling entirely.

---

## Okta

**Create**
1. *Security → API → Authorization Servers* → **Add Authorization Server**
   - Set an **Audience** value — this is literally what lands in `aud`
   - Add a scope, e.g. `mcp.access`
   - *Access Policies* → add a policy and rule allowing your client
2. *Applications* → **Create App Integration** → **OIDC** → **Native Application**
   - Grant types: *Authorization Code* + *Refresh Token*
   - Sign-in redirect URI: `http://localhost:<port>/callback`
   - PKCE is required for native apps by default — leave it on
3. Assign the app to the authorization server's access policy

**The trap:** *use the custom authorization server you just created, not the **org** one.* Okta's
org authorization server (`https://<org>.okta.com` with no `/oauth2/<id>`) issues **opaque**
tokens. Only a custom authorization server issues JWTs.

**Server config**
```bash
OAUTH_ISSUER=https://<org>.okta.com/oauth2/<authServerId>
OAUTH_AUDIENCE=<the Audience value from step 1>
```

DCR is supported, but pinning `--client-id` is still simpler and avoids policy-assignment
surprises for self-registered clients.

---

## Keycloak

The least troublesome of the mainstream providers: JWTs by default, DCR supported, PKCE advertised.

**Create**
1. *Clients* → **Create client** → OpenID Connect
   - Client authentication: **Off** (public client)
   - Standard flow: **on**; Direct access grants: off
   - Valid redirect URIs: `http://localhost:<port>/callback`
2. *Advanced* → **Proof Key for Code Exchange Code Challenge Method: S256**

**The one non-obvious step — the audience mapper.** By default Keycloak puts `account` in `aud`,
not your client id, so audience validation fails with an otherwise perfect token. Add a mapper:

*Client scopes* → `<your-client>-dedicated` → **Add mapper** → **By configuration** → **Audience**
→ set *Included Client Audience* to your client → ensure **Add to access token** is on.

**Server config**
```bash
OAUTH_ISSUER=https://<host>/realms/<realm>
OAUTH_AUDIENCE=<client-id>
```

---

## Auth0

**Create**
1. *Applications → APIs* → **Create API**
   - **Identifier** — e.g. `https://ivanti-mcp`. This string is the audience; it never has to
     resolve to anything.
2. *Applications* → **Create Application** → **Native**
   - Allowed Callback URLs: `http://localhost:<port>/callback`

**The trap:** Auth0 issues an **opaque** token unless the client passes an `audience` parameter —
and an MCP client will not, because nothing in the protocol tells it to.

The fix is tenant-side, not client-side: *Settings → API Authorization Settings → **Default
Audience*** → set it to your API identifier. Every token then carries that audience and is issued
as a JWT.

**Server config**
```bash
OAUTH_ISSUER=https://<tenant>.auth0.com/     # note the trailing slash — Auth0 issues it that way
OAUTH_AUDIENCE=https://ivanti-mcp
```

`OAUTH_ISSUER` must match the `iss` claim byte for byte, and Auth0's includes a trailing slash.
This is the one place where a trailing slash is correct.

---

## Others

**JumpCloud** — JWTs, no DCR, PKCE advertised. Pre-register a client and pin `--client-id`.
Issuer `https://oauth.id.jumpcloud.com`.

**Google** — not recommended. Access tokens are opaque (`ya29.…`), there is no introspection
endpoint, and no DCR. Nothing to configure your way out of.

**Anything else** — if it publishes a `jwks_uri` and issues JWTs, it will work. Point
`OAUTH_ISSUER` at it, set `OAUTH_AUDIENCE` to whatever the token actually carries in `aud`
(decode one and look), and pre-register a client if it has no `registration_endpoint`.

---

## Discovery, and how to skip it

There are exactly two ways the server learns where the signing keys are.

### 1. Discovery (default) — set `OAUTH_ISSUER` only

At **startup**, the server probes the well-known URLs in the order the spec defines, takes the
first document that parses, and reads `jwks_uri` from it.

The candidate list depends on whether the issuer has a path component:

| Issuer shape | Probes, in order |
|---|---|
| **With a path**<br>`https://host/tenant/v2.0`<br>*(Entra, Okta, Keycloak)* | 1. `https://host/.well-known/oauth-authorization-server/tenant/v2.0`<br>2. `https://host/.well-known/openid-configuration/tenant/v2.0`<br>3. `https://host/tenant/v2.0/.well-known/openid-configuration` |
| **Without a path**<br>`https://host`<br>*(Zitadel, Auth0)* | 1. `https://host/.well-known/oauth-authorization-server`<br>2. `https://host/.well-known/openid-configuration` |

**All three candidates matter.** Entra 404s on the first two and answers only on the third;
Zitadel answers on the first. An implementation that tries fewer cannot reach one or the other.

The document's `issuer` must equal `OAUTH_ISSUER` **exactly**, or it is rejected — that check is
the mitigation for a metadata document served from one host claiming to be another.

Discovery runs **once, at boot**. A wrong issuer therefore fails immediately with the list of URLs
tried, rather than turning into a puzzling 401 on the first real request hours later.

```
Could not discover authorization server metadata for "https://…". Tried:
  https://…/.well-known/oauth-authorization-server
  https://…/.well-known/openid-configuration
Set OAUTH_JWKS_URI to skip discovery.
```

### 2. Explicit — set `OAUTH_JWKS_URI` as well

Discovery is skipped entirely; the URL is used as given. Reach for this when:

- the IdP publishes metadata somewhere the probe order does not look;
- a proxy or firewall blocks the `.well-known` path but not the keys endpoint;
- you want no startup dependency on the discovery endpoint being reachable;
- you are pinning to a specific keys URL for change control.

**Security is unchanged.** The token's `iss` claim is still validated against `OAUTH_ISSUER`, and
its `aud` against `OAUTH_AUDIENCE`. Skipping discovery skips *finding* the keys, not *checking*
the token — the only thing lost is the metadata document's own issuer cross-check, which is
irrelevant when you supplied the URL yourself.

| | Discovery | Explicit `OAUTH_JWKS_URI` |
|---|---|---|
| Config | issuer only | issuer + keys URL |
| Startup | one network call, fails fast | no network call |
| IdP moves its keys | picked up on restart | breaks until you update it |
| Unusual metadata layout | may fail | works |

### JWKS URLs, if you are setting them explicitly

| IdP | `OAUTH_JWKS_URI` |
|---|---|
| Entra ID | `https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys` |
| Zitadel | `https://<instance>/oauth/v2/keys` |
| Okta | `https://<org>.okta.com/oauth2/<authServerId>/v1/keys` |
| Keycloak | `https://<host>/realms/<realm>/protocol/openid-connect/certs` |
| Auth0 | `https://<tenant>.auth0.com/.well-known/jwks.json` |

In both modes the key set is **fetched lazily on the first token and cached**, and refetched when a
token arrives with an unknown `kid` — which is what makes signing-key rotation at the IdP a
non-event rather than an outage.

---

## Deployment shapes

**Local desktop client** — the default; needs nothing else.
```bash
STDIO_TRANSPORT_ON=true
```

**Internal HTTP service, shared token**
```bash
STDIO_TRANSPORT_ON=false
HTTP_TRANSPORT_ON=true
AUTH_MODE=bearer
BEARER_TOKEN_FILE=/run/secrets/bearer-token
MCP_PUBLIC_URL=https://mcp.example.com/mcp
TRUSTED_ORIGINS=https://claude.ai
```
Size the token's audience to the tool surface behind it. A token given to a multi-user client
grants that surface to **everyone** who can use the connector — pair a widely shared token with
`MCP_MODE=enduser`.

**Trusted network, no authentication**
```bash
AUTH_MODE=none
MCP_BIND=0.0.0.0        # loopback by default; exposing it is a second, deliberate act
TRUSTED_ORIGINS=https://claude.ai
```
`TRUSTED_ORIGINS` still matters here — it is the *only* control left. Origin validation is what
stops a page the user merely visits from driving this server from inside the network.

**Behind a reverse proxy** — set `MCP_PUBLIC_URL` to the externally visible URL. It is never
derived from the request, because the proxy rewrites Host and scheme while the OAuth token audience
and RFC 9728 metadata must still match exactly.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Access token is opaque, not a JWT` | The IdP is issuing reference tokens. Zitadel per-app default, Okta org authorization server, or Auth0 without an `audience` parameter. |
| `Access token was not issued for this server` | `OAUTH_AUDIENCE` mismatch — almost always the first thing to check. Decode the token and read its real `aud`. |
| `Access token was signed by an unknown key` | JWKS problem, or the issuer is not who you configured. |
| `Could not discover authorization server metadata` | Wrong `OAUTH_ISSUER`, or the IdP publishes metadata somewhere the spec's probe order does not look — set `OAUTH_JWKS_URI` to skip discovery. |
| Startup exits `78` | Incomplete configuration. Every problem is listed; fix them all. |
| `MCP_PUBLIC_URL must not end with a trailing slash` | The resource identifier is compared verbatim against the token audience. |
| Client keeps registering new apps | It is using DCR. Pin it with `--client-id`, and remember a **running client reads its config at startup** — restart it. |
| Everything looks right, still 401 | Cached credentials from before the fix. Clear the client's stored authentication and re-authenticate. |
| Container starts, then exits | `package.json` is missing next to `dist/`. The server refuses to report a placeholder version. |

At `LOG_LEVEL=debug` every request logs its method, tool, session and authenticated subject, which
answers most of the above directly. Arguments are never logged.
