// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

export interface AuthorizationServerMetadata {
  issuer: string;
  jwks_uri: string;
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * Well-known URLs to probe, in the priority order the spec defines.
 *
 * The order matters for real providers: Entra's issuer carries a path
 * (`https://login.microsoftonline.com/{tid}/v2.0`) and only the third form — path appending —
 * actually resolves. Zitadel's issuer has no path and answers on the first two.
 */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  const { origin } = url;

  if (path === '') {
    return [
      `${origin}/.well-known/oauth-authorization-server`,
      `${origin}/.well-known/openid-configuration`,
    ];
  }

  return [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
    `${origin}${path}/.well-known/openid-configuration`,
  ];
}

function isMetadata(value: unknown): value is AuthorizationServerMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.issuer === 'string' && typeof record.jwks_uri === 'string';
}

/** A development IdP on this machine, where there is no network for anyone to sit on. */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Why a discovered key-set URL cannot be trusted, if it cannot.
 *
 * The keys are what every token is checked against, so whoever can answer that URL can sign in as
 * anyone. Over plain HTTP that is anyone on the path — and a discovered URL is not something an
 * operator ever looked at, which is why the configured pair is checked at startup and this one
 * has to be checked here.
 */
function jwksUriProblem(jwksUri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(jwksUri);
  } catch {
    return 'is not an absolute URL';
  }
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return undefined;
  return `uses ${url.protocol.replace(/:$/, '')}, not https`;
}

/**
 * Resolves the authorization server's metadata, rejecting any document whose `issuer` does not
 * match the one we asked for. That check is the mitigation for a metadata document served from
 * one host claiming to be another.
 */
export async function discoverAuthorizationServer(
  issuer: string,
  fetchImpl: FetchLike,
): Promise<AuthorizationServerMetadata> {
  const attempted: string[] = [];

  for (const url of authorizationServerMetadataUrls(issuer)) {
    attempted.push(url);

    let body: unknown;
    try {
      const response = await fetchImpl(url);
      if (!response.ok) continue;
      body = await response.json();
    } catch {
      continue;
    }

    if (!isMetadata(body)) continue;

    if (body.issuer !== issuer) {
      throw new Error(
        `Authorization server metadata at ${url} declares issuer "${body.issuer}", ` +
          `which does not match the configured OAUTH_ISSUER "${issuer}".`,
      );
    }

    // Refused rather than skipped: the next candidate is the same issuer's document, and falling
    // through to it would make the check depend on the order the provider happens to answer in.
    const problem = jwksUriProblem(body.jwks_uri);
    if (problem !== undefined) {
      throw new Error(
        `Authorization server metadata at ${url} names the signing keys at "${body.jwks_uri}", ` +
          `which ${problem}. Keys fetched without TLS can be replaced by anyone on the path, and ` +
          'every token is verified against them. Fix the provider, or set OAUTH_JWKS_URI to the ' +
          'https address of its keys.',
      );
    }

    return body;
  }

  throw new Error(
    `Could not discover authorization server metadata for "${issuer}". Tried:\n  ` +
      `${attempted.join('\n  ')}\nSet OAUTH_JWKS_URI to skip discovery.`,
  );
}
