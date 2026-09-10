import type { Config } from '../../config/env-schema.js';
import { expectedAudience } from '../../config/validate-config.js';
import { discoverAuthorizationServer, type FetchLike } from './discover-metadata.js';
import { createRemoteKeyResolver, createTokenVerifier, type TokenVerifier } from './verify-token.js';

export interface OAuthSetup {
  verifier: TokenVerifier;
  issuer: string;
  audience: string;
  jwksUri: string;
}

const defaultFetch: FetchLike = (url) => fetch(url);

/**
 * Resolves the signing keys and builds the verifier.
 *
 * Discovery happens once at startup so a wrong issuer fails immediately, rather than turning
 * into a puzzling 401 on the first real request.
 */
export async function createOAuthSetup(
  config: Config,
  fetchImpl: FetchLike = defaultFetch,
): Promise<OAuthSetup> {
  const issuer = config.OAUTH_ISSUER;
  const audience = expectedAudience(config);

  if (issuer === undefined || audience === undefined) {
    throw new Error('AUTH_MODE=oauth requires OAUTH_ISSUER and an audience.');
  }

  const jwksUri =
    config.OAUTH_JWKS_URI ?? (await discoverAuthorizationServer(issuer, fetchImpl)).jwks_uri;

  return {
    verifier: createTokenVerifier({
      issuer,
      audience,
      requiredScopes: config.OAUTH_REQUIRED_SCOPES,
      keyResolver: createRemoteKeyResolver(jwksUri),
    }),
    issuer,
    audience,
    jwksUri,
  };
}
