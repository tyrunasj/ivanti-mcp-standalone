import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export interface VerifiedIdentity {
  subject: string;
  issuer: string;
  scopes: string[];
  claims: JWTPayload;
}

export type TokenFailure = 'invalid_token' | 'insufficient_scope';

export type TokenVerification =
  | { ok: true; identity: VerifiedIdentity }
  | { ok: false; status: 401 | 403; error: TokenFailure; description: string };

export interface TokenVerifierOptions {
  issuer: string;
  /**
   * The value the token must name in `aud`.
   *
   * Not necessarily the resource URL: no mainstream IdP mints the audience from the client's
   * RFC 8707 `resource` parameter. Zitadel emits a numeric project id, Entra an App ID URI.
   */
  audience: string;
  requiredScopes?: readonly string[];
  clockToleranceSeconds?: number;
  keyResolver: JWTVerifyGetKey;
}

export type TokenVerifier = (token: string) => Promise<TokenVerification>;

const asList = (value: unknown): string[] => {
  if (typeof value === 'string') return value.split(' ').filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
};

/**
 * Scopes live under `scope` for most providers and `scp` for Entra, as either a
 * space-delimited string or an array. All four shapes occur in practice.
 */
export function extractScopes(claims: JWTPayload): string[] {
  const scopes = new Set([...asList(claims.scope), ...asList(claims.scp)]);
  return [...scopes];
}

export function createRemoteKeyResolver(jwksUri: string): JWTVerifyGetKey {
  // Caches the key set and refetches on an unknown `kid`, which is what makes signing-key
  // rotation at the IdP a non-event.
  return createRemoteJWKSet(new URL(jwksUri));
}

function describeFailure(error: unknown): string {
  const code = (error as { code?: unknown }).code;

  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return 'Access token has expired';
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'Access token signature is invalid';
    case 'ERR_JWKS_NO_MATCHING_KEY':
      return 'Access token was signed by an unknown key';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      const claim = (error as { claim?: unknown }).claim;
      return claim === 'aud'
        ? 'Access token was not issued for this server'
        : `Access token failed validation of the "${String(claim)}" claim`;
    }
    default:
      return 'Access token is not valid';
  }
}

export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const required = options.requiredScopes ?? [];

  return async (token: string): Promise<TokenVerification> => {
    let claims: JWTPayload;

    try {
      const result = await jwtVerify(token, options.keyResolver, {
        issuer: options.issuer,
        audience: options.audience,
        clockTolerance: options.clockToleranceSeconds ?? 30,
      });
      claims = result.payload;
    } catch (error) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_token',
        description: describeFailure(error),
      };
    }

    if (typeof claims.sub !== 'string' || claims.sub === '') {
      return {
        ok: false,
        status: 401,
        error: 'invalid_token',
        description: 'Access token has no subject',
      };
    }

    const scopes = extractScopes(claims);
    const missing = required.filter((scope) => !scopes.includes(scope));

    if (missing.length > 0) {
      return {
        ok: false,
        status: 403,
        error: 'insufficient_scope',
        description: `Missing required scope: ${missing.join(' ')}`,
      };
    }

    return {
      ok: true,
      identity: {
        subject: claims.sub,
        issuer: options.issuer,
        scopes,
        claims,
      },
    };
  };
}
