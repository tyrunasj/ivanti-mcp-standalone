// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

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
  | {
      ok: false;
      status: 401 | 403;
      error: TokenFailure;
      /**
       * Goes into the `WWW-Authenticate` challenge, which is truncated to 200 characters — so
       * this must be short enough to survive intact, remedy included. A diagnosis whose fix is
       * cut off is worse than no diagnosis.
       */
      description: string;
      /** Longer explanation for the log, where there is no length budget. */
      detail?: string;
    };

export interface TokenVerifierOptions {
  issuer: string;
  /**
   * Values the token may name in `aud`; any one matching is enough.
   *
   * Not necessarily the resource URL: no mainstream IdP mints the audience from the client's
   * RFC 8707 `resource` parameter. Zitadel emits a numeric project or client id, Entra an App
   * ID URI. jose treats an array here as "any of", and the token's own `aud` may also be an
   * array — so this is a set intersection, not an equality check.
   */
  audience: readonly string[];
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

/**
 * A compact JWS is exactly three base64url segments. Anything else is an opaque token, which a
 * JWKS verifier cannot inspect at all — there is no header, no signature, nothing to check.
 *
 * Worth detecting explicitly because the fall-through message ("not valid") sends people
 * hunting for a key or audience problem when the real answer is that the authorization server
 * is issuing a reference token.
 */
export function looksLikeJwt(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
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
    if (!looksLikeJwt(token)) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_token',
        description:
          'Access token is opaque, not a JWT. Configure the application to issue JWT ' +
          'access tokens.',
        detail:
          'Access token is opaque, not a JWT, so its signature cannot be verified. The ' +
          'authorization server is issuing reference tokens; in Zitadel this is the ' +
          'per-application default and a client created by Dynamic Client Registration ' +
          'inherits it. Okta behaves the same way on its org authorization server, and Auth0 ' +
          'unless the client passes an `audience` parameter.',
      };
    }

    let claims: JWTPayload;

    try {
      const result = await jwtVerify(token, options.keyResolver, {
        issuer: options.issuer,
        audience: [...options.audience],
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
