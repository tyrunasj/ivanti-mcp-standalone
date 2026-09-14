// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { SignJWT, generateKeyPair, type CryptoKey, type JWTVerifyGetKey } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifier, extractScopes, looksLikeJwt } from './verify-token.js';

const ISSUER = 'https://id.example.com';
const AUDIENCE = '259254020357488642'; // Zitadel shape: a project id, not a URL.

let privateKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;
let otherPrivateKey: CryptoKey;

interface TokenOverrides {
  issuer?: string;
  audience?: string | string[];
  subject?: string | undefined;
  scope?: string | string[];
  scp?: string;
  expiresIn?: string;
  notBefore?: string;
  signWith?: CryptoKey;
  /** RFC 9068 makes `exp` REQUIRED; a server that omits it is what this guards against. */
  noExpiry?: boolean;
}

const issueToken = async (overrides: TokenOverrides = {}): Promise<string> => {
  const claims: Record<string, unknown> = {};
  if (overrides.scope !== undefined) claims.scope = overrides.scope;
  if (overrides.scp !== undefined) claims.scp = overrides.scp;

  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE);
  if (overrides.noExpiry !== true) jwt = jwt.setExpirationTime(overrides.expiresIn ?? '5m');

  const subject = 'subject' in overrides ? overrides.subject : 'user-123';
  if (subject !== undefined) jwt = jwt.setSubject(subject);
  if (overrides.notBefore !== undefined) jwt = jwt.setNotBefore(overrides.notBefore);

  return jwt.sign(overrides.signWith ?? privateKey);
};

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  keyResolver = () => Promise.resolve(pair.publicKey);
  otherPrivateKey = (await generateKeyPair('RS256')).privateKey;
});

const verifier = (requiredScopes?: string[]) =>
  createTokenVerifier({ issuer: ISSUER, audience: [AUDIENCE], requiredScopes, keyResolver });

describe('extractScopes', () => {
  it('reads a space-delimited scope claim', () => {
    expect(extractScopes({ scope: 'a b' })).toEqual(['a', 'b']);
  });

  it('reads the scp claim Entra uses', () => {
    expect(extractScopes({ scp: 'a b' })).toEqual(['a', 'b']);
  });

  it('reads an array-valued claim', () => {
    expect(extractScopes({ scope: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('de-duplicates across both claim names', () => {
    expect(extractScopes({ scope: 'a', scp: 'a b' })).toEqual(['a', 'b']);
  });

  it('returns nothing when neither claim is present', () => {
    expect(extractScopes({})).toEqual([]);
  });
});

describe('createTokenVerifier', () => {
  it('accepts a well-formed token and reports the subject', async () => {
    const result = await verifier()(await issueToken({ scope: 'ivanti:read' }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.subject).toBe('user-123');
      expect(result.identity.scopes).toEqual(['ivanti:read']);
    }
  });

  it('rejects a token issued for a different audience', async () => {
    const result = await verifier()(await issueToken({ audience: 'some-other-api' }));

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      error: 'invalid_token',
      description: 'Access token was not issued for this server',
    });
  });

  it('accepts a token naming any one of several configured audiences', async () => {
    const multi = createTokenVerifier({
      issuer: ISSUER,
      audience: ['other-client', AUDIENCE],
      keyResolver,
    });

    expect((await multi(await issueToken())).ok).toBe(true);
  });

  it('accepts a token whose aud is an array containing us', async () => {
    const result = await verifier()(await issueToken({ audience: ['other-api', AUDIENCE] }));

    expect(result.ok).toBe(true);
  });

  it('rejects a token from a different issuer', async () => {
    const result = await verifier()(await issueToken({ issuer: 'https://attacker.example' }));

    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
  });

  it('rejects an expired token', async () => {
    const result = await verifier()(await issueToken({ expiresIn: '-1h' }));

    expect(result).toMatchObject({ status: 401, description: 'Access token has expired' });
  });

  it('rejects a token signed by an unknown key', async () => {
    const result = await verifier()(await issueToken({ signWith: otherPrivateKey }));

    expect(result).toMatchObject({
      status: 401,
      description: 'Access token signature is invalid',
    });
  });

  it('rejects a token with no subject', async () => {
    const result = await verifier()(await issueToken({ subject: undefined }));

    expect(result).toMatchObject({ status: 401, description: 'Access token has no subject' });
  });

  it('rejects garbage that is not a JWT at all', async () => {
    const result = await verifier()('not-a-token');

    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
  });

  it('answers 403 insufficient_scope when a required scope is missing', async () => {
    const result = await verifier(['ivanti:write'])(await issueToken({ scope: 'ivanti:read' }));

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: 'insufficient_scope',
      description: 'Missing required scope: ivanti:write',
    });
  });

  it('accepts when every required scope is present', async () => {
    const result = await verifier(['ivanti:read'])(
      await issueToken({ scope: 'ivanti:read ivanti:write' }),
    );

    expect(result.ok).toBe(true);
  });

  it('tolerates small clock skew on nbf', async () => {
    const result = await verifier()(await issueToken({ notBefore: '5s' }));

    expect(result.ok).toBe(true);
  });
});

describe('looksLikeJwt', () => {
  it('accepts a three-segment compact JWS', () => {
    expect(looksLikeJwt('aaa.bbb.ccc')).toBe(true);
  });

  it('rejects an opaque reference token', () => {
    expect(looksLikeJwt('NaUAPHy5mLFQlwUCeUGYeDyhcQYuNhzTiYgwMor9BxP')).toBe(false);
  });

  it('rejects a token with an empty segment', () => {
    expect(looksLikeJwt('aaa..ccc')).toBe(false);
  });
});

describe('opaque token handling', () => {
  it('names the actual cause instead of a generic failure', async () => {
    const result = await verifier()('NaUAPHy5mLFQlwUCeUGYeDyhcQYuNhzTiYgwMor9BxP');

    expect(result).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
    if (!result.ok) {
      expect(result.description).toContain('opaque');
      expect(result.description).toContain('JWT access tokens');
    }
  });
});

describe('challenge-safe descriptions', () => {
  it('keeps the opaque-token remedy inside the header length budget', async () => {
    const result = await verifier()('NaUAPHy5opaqueReferenceToken');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // buildWwwAuthenticate truncates at 200 chars; a diagnosis whose fix is cut off is
      // worse than no diagnosis.
      expect(result.description.length).toBeLessThanOrEqual(200);
      expect(result.description).toContain('JWT access tokens');
      // The fuller explanation still exists, for the log.
      expect(result.detail).toContain('Dynamic Client Registration');
    }
  });

  /**
   * An IdP that cannot be reached is not a bad token.
   *
   * jose fetches the JWKS lazily and again on an unknown `kid`, so a firewall change or an IdP
   * outage surfaces at verification time rather than at startup. Reported as 401 it starts a
   * re-authentication LOOP across every user: the client reads 401 as "your token is bad",
   * discards it, runs the authorization code flow — which SUCCEEDS, because the browser can still
   * reach the IdP — and presents a fresh token to the same 401. And the cause was discarded, so
   * the operator's only log line named neither the JWKS URI nor the network error.
   */
  describe('when the IdP cannot be reached', () => {
    it.each([
      ['a fetch failure', Object.assign(new TypeError('fetch failed'), {})],
      ['a JWKS timeout', Object.assign(new Error('timeout'), { name: 'JWKSTimeout' })],
    ])('answers 503 rather than 401 for %s', async (_label, thrown) => {
      const warn = vi.fn();
      const verify = createTokenVerifier({
        issuer: ISSUER,
        audience: [AUDIENCE],
        keyResolver: () => Promise.reject(thrown),
        logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      });

      const result = await verify(await issueToken());

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.status).toBe(503);
      // The cause is logged once, which is the only place it is visible at all.
      expect(warn).toHaveBeenCalled();
    });

    // Narrowing check: a genuinely bad token must still be 401, or this would hide real failures.
    it('still answers 401 for a token that is actually invalid', async () => {
      const verify = createTokenVerifier({
        issuer: ISSUER,
        audience: [AUDIENCE],
        keyResolver: () => Promise.reject(Object.assign(new Error('nope'), { code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' })),
      });

      const result = await verify(await issueToken());

      expect(result.ok === false && result.status).toBe(401);
    });
  });

  /**
   * RFC 9068 §2.2 makes `exp` REQUIRED in a JWT access token, and jose only validates a claim it
   * finds — so a token minted without one verified forever. Disabling the user at the IdP would
   * change nothing, and a token captured from a log would be a permanent credential.
   */
  it('refuses a token that carries no expiry at all', async () => {
    const verify = createTokenVerifier({ issuer: ISSUER, audience: [AUDIENCE], keyResolver });

    const result = await verify(await issueToken({ noExpiry: true }));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(401);
  });
});

