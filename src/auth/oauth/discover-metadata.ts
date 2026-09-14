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

    return body;
  }

  throw new Error(
    `Could not discover authorization server metadata for "${issuer}". Tried:\n  ` +
      `${attempted.join('\n  ')}\nSet OAUTH_JWKS_URI to skip discovery.`,
  );
}
