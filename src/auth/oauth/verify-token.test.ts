import { SignJWT, generateKeyPair, type CryptoKey, type JWTVerifyGetKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTokenVerifier, extractScopes } from './verify-token.js';

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
}

const issueToken = async (overrides: TokenOverrides = {}): Promise<string> => {
  const claims: Record<string, unknown> = {};
  if (overrides.scope !== undefined) claims.scope = overrides.scope;
  if (overrides.scp !== undefined) claims.scp = overrides.scp;

  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setExpirationTime(overrides.expiresIn ?? '5m');

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
  createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, requiredScopes, keyResolver });

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
