// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

const WELL_KNOWN = '/.well-known/oauth-protected-resource';

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported?: string[];
  resource_name?: string;
}

export interface MetadataOptions {
  resource: string;
  issuer: string;
  scopesSupported?: readonly string[];
  resourceName?: string;
}

/**
 * RFC 9728 Protected Resource Metadata.
 *
 * `authorization_servers` must carry at least one entry — it is the whole point of the
 * document, and how a client gets from a 401 to the right IdP.
 *
 * `offline_access` is deliberately never advertised here: refresh tokens are a client
 * concern, not a resource requirement.
 */
export function buildProtectedResourceMetadata(
  options: MetadataOptions,
): ProtectedResourceMetadata {
  const scopes = (options.scopesSupported ?? []).filter((scope) => scope !== 'offline_access');

  return {
    resource: options.resource,
    authorization_servers: [options.issuer],
    bearer_methods_supported: ['header'],
    ...(scopes.length > 0 ? { scopes_supported: scopes } : {}),
    ...(options.resourceName !== undefined ? { resource_name: options.resourceName } : {}),
  };
}

/**
 * Paths the metadata document is served from, most specific first.
 *
 * RFC 9728 inserts the resource's path into the well-known path, so a server at
 * `https://example.com/public/mcp` publishes at
 * `https://example.com/.well-known/oauth-protected-resource/public/mcp`. Clients probe the
 * path-inserted form before the root, so both are served.
 */
export function metadataPaths(resourceUrl: string): string[] {
  const { pathname } = new URL(resourceUrl);
  const trimmed = pathname.replace(/\/+$/, '');

  return trimmed === '' ? [WELL_KNOWN] : [`${WELL_KNOWN}${trimmed}`, WELL_KNOWN];
}

/** The absolute URL advertised in the `WWW-Authenticate` challenge. */
export function metadataUrl(resourceUrl: string): string {
  const { origin } = new URL(resourceUrl);
  const [preferred] = metadataPaths(resourceUrl);

  return `${origin}${preferred ?? WELL_KNOWN}`;
}
