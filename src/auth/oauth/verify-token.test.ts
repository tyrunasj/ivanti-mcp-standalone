// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import {
  JWKS_RETRY_MS,
  createRemoteKeyResolver,
  createTokenVerifier,
  extractScopes,
  looksLikeJwt,
} from './verify-token.js';

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

/**
 * The IdP's key set through an outage, against a real endpoint that can be taken down.
 *
 * jose trusts its copy for ten minutes; after that EVERY request awaited a reload, and a failed
 * reload threw even though the keys already held would verify the token. So an IdP outage became
 * a 503 for every request ten minutes in, and every one of them started its own fetch.
 */
describe('the remote key set', () => {
  const TEN_MINUTES = 10 * 60_000;
  let now = Date.now();
  let closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(closers.map((close) => close()));
    closers = [];
  });

  /** Only the clock is fake: the endpoint, fetch and jose's own timeout run for real. */
  const later = (ms: number): void => {
    now += ms;
    vi.setSystemTime(now);
  };

  const keyPair = async (kid: string): Promise<{ privateKey: CryptoKey; jwk: JWK }> => {
    const pair = await generateKeyPair('RS256');
    return { privateKey: pair.privateKey, jwk: { ...(await exportJWK(pair.publicKey)), kid, alg: 'RS256', use: 'sig' } };
  };

  const sign = (key: CryptoKey, kid: string): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(key);

  /** A JWKS endpoint on loopback that answers, fails with 503, and counts every fetch. */
  const endpoint = async (keys: JWK[]) => {
    const state = { up: true, keys, fetches: 0 };
    const server = createServer((_request, response) => {
      state.fetches += 1;
      if (!state.up) {
        response.writeHead(503).end('down');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: state.keys }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => server.close(() => { resolve(); })));
    const { port } = server.address() as AddressInfo;
    return { state, url: `http://127.0.0.1:${String(port)}/keys` };
  };

  const recording = () => {
    const lines: { level: string; message: string }[] = [];
    const keep = (level: string) => (message: string): void => {
      lines.push({ level, message });
    };
    const log: Logger = { debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') };
    return { log, lines };
  };

  const setup = async () => {
    now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const k1 = await keyPair('k1');
    const k2 = await keyPair('k2');
    const idp = await endpoint([k1.jwk]);
    const { log, lines } = recording();
    const verify = createTokenVerifier({
      issuer: ISSUER,
      audience: [AUDIENCE],
      keyResolver: createRemoteKeyResolver(idp.url, { logger: log }),
      logger: log,
    });
    return { k1, k2, idp, verify, lines };
  };

  it('keeps verifying with the last good keys once the IdP goes down', async () => {
    const { k1, idp, verify } = await setup();
    const token = await sign(k1.privateKey, 'k1');
    expect((await verify(token)).ok).toBe(true);

    idp.state.up = false;
    later(TEN_MINUTES + 1_000);

    expect(await verify(token)).toMatchObject({ ok: true });
  });

  it('asks the IdP once per backoff interval during an outage, not once per request', async () => {
    const { k1, idp, verify, lines } = await setup();
    const token = await sign(k1.privateKey, 'k1');
    await verify(token);

    idp.state.up = false;
    later(TEN_MINUTES + 1_000);
    for (let request = 0; request < 5; request += 1) expect((await verify(token)).ok).toBe(true);

    // The initial fetch, then the one refresh that failed — and nothing for the four after it.
    expect(idp.state.fetches).toBe(2);
    expect(lines.filter((line) => line.level === 'warn')).toHaveLength(1);

    later(JWKS_RETRY_MS + 1);
    await verify(token);
    expect(idp.state.fetches).toBe(3);
  });

  it('takes the fresh key set as soon as the IdP answers again', async () => {
    const { k1, k2, idp, verify, lines } = await setup();
    await verify(await sign(k1.privateKey, 'k1'));

    idp.state.up = false;
    later(TEN_MINUTES + 1_000);
    await verify(await sign(k1.privateKey, 'k1'));

    idp.state.up = true;
    idp.state.keys = [k2.jwk];
    later(JWKS_RETRY_MS + 1);

    expect((await verify(await sign(k2.privateKey, 'k2'))).ok).toBe(true);
    expect(lines.map((line) => line.message)).toContain('the IdP signing keys are reachable again');
  });

  // What makes key rotation a non-event, and must survive the change.
  it('still refetches when a token names a key it has not seen', async () => {
    const { k1, k2, idp, verify } = await setup();
    await verify(await sign(k1.privateKey, 'k1'));

    idp.state.keys = [k1.jwk, k2.jwk];
    later(31_000);

    expect((await verify(await sign(k2.privateKey, 'k2'))).ok).toBe(true);
    expect(idp.state.fetches).toBe(2);
  });

  // It may be signed by a key rotated in while the IdP was down; 401 would start the loop.
  it('answers 503, not 401, for an unseen key while the IdP is down', async () => {
    const { k1, k2, idp, verify } = await setup();
    await verify(await sign(k1.privateKey, 'k1'));

    idp.state.up = false;
    later(TEN_MINUTES + 1_000);
    await verify(await sign(k1.privateKey, 'k1'));

    const result = await verify(await sign(k2.privateKey, 'k2'));
    expect(result.ok === false && result.status).toBe(503);
  });

  it('answers 503 when it never had keys, and backs off there too', async () => {
    const { k1, idp, verify } = await setup();
    idp.state.up = false;
    const token = await sign(k1.privateKey, 'k1');

    expect(await verify(token)).toMatchObject({ ok: false, status: 503 });
    expect(await verify(token)).toMatchObject({ ok: false, status: 503 });
    expect(idp.state.fetches).toBe(1);
  });
});

