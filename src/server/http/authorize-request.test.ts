import { describe, expect, it } from 'vitest';
import { configFixture } from '../../config/config.fixture.js';
import type { Config } from '../../config/env-schema.js';
import { authorizeRequest, extractBearerToken } from './authorize-request.js';

const config = (overrides: Partial<Config> = {}): Config =>
  configFixture({
    AUTH_MODE: 'none',
    MCP_PUBLIC_URL: 'http://127.0.0.1:3000',
    TRUSTED_ORIGINS: ['http://localhost:3000'],
    ...overrides,
  });

describe('extractBearerToken', () => {
  it('reads the token from a Bearer header', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
  });

  it('is case-insensitive about the scheme', () => {
    expect(extractBearerToken('bearer abc')).toBe('abc');
  });

  it('ignores a non-bearer scheme', () => {
    expect(extractBearerToken('Basic abc')).toBeUndefined();
  });

  it('treats an empty token as absent', () => {
    expect(extractBearerToken('Bearer   ')).toBeUndefined();
  });
});

describe('authorizeRequest', () => {
  it('allows any request in open mode', async () => {
    expect((await authorizeRequest(config(), {})).authorized).toBe(true);
  });

  it('accepts a matching bearer token', async () => {
    const result = await authorizeRequest(config({ AUTH_MODE: 'bearer', BEARER_TOKEN: 'secret' }), {
      authorization: 'Bearer secret',
    });

    expect(result.authorized).toBe(true);
  });

  it('rejects a missing Authorization header with 401', async () => {
    const result = await authorizeRequest(config({ AUTH_MODE: 'bearer', BEARER_TOKEN: 'secret' }), {});

    expect(result).toMatchObject({ authorized: false, status: 401 });
  });

  it('rejects a non-bearer scheme', async () => {
    const result = await authorizeRequest(config({ AUTH_MODE: 'bearer', BEARER_TOKEN: 'secret' }), {
      authorization: 'Basic c2VjcmV0',
    });

    expect(result.authorized).toBe(false);
  });

  it('rejects a wrong token of equal length', async () => {
    const result = await authorizeRequest(config({ AUTH_MODE: 'bearer', BEARER_TOKEN: 'secret' }), {
      authorization: 'Bearer sekret',
    });

    expect(result.authorized).toBe(false);
  });

  it('rejects a token of a different length without throwing', async () => {
    const result = await authorizeRequest(config({ AUTH_MODE: 'bearer', BEARER_TOKEN: 'secret' }), {
      authorization: 'Bearer s',
    });

    expect(result.authorized).toBe(false);
  });

  it('fails closed when oauth mode has no verifier wired in', async () => {
    const result = await authorizeRequest(config({ AUTH_MODE: 'oauth' }), {});

    expect(result).toMatchObject({ authorized: false, status: 500 });
  });
});

describe('authorizeRequest in oauth mode', () => {
  const oauth = config({
    AUTH_MODE: 'oauth',
    OAUTH_ISSUER: 'https://id.example.com',
    OAUTH_REQUIRED_SCOPES: ['ivanti:read'],
  });
  const resourceMetadataUrl = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';

  const identity = {
    subject: 'user-1',
    issuer: 'https://id.example.com',
    scopes: ['ivanti:read'],
    claims: {},
  };

  it('challenges with resource metadata when no token is presented', async () => {
    const result = await authorizeRequest(oauth, {}, { verifier: () => Promise.resolve({ ok: true as const, identity }), resourceMetadataUrl });

    expect(result.status).toBe(401);
    expect(result.challenge).toContain(`resource_metadata="${resourceMetadataUrl}"`);
    expect(result.challenge).toContain('scope="ivanti:read"');
    expect(result.challenge).not.toContain('error=');
  });

  it('passes the token to the verifier and returns the identity', async () => {
    const result = await authorizeRequest(
      oauth,
      { authorization: 'Bearer good' },
      { verifier: (token) =>
          Promise.resolve(
            token === 'good'
              ? ({ ok: true, identity } as const)
              : ({ ok: false, status: 401, error: 'invalid_token', description: 'no' } as const),
          ), resourceMetadataUrl },
    );

    expect(result.authorized).toBe(true);
    expect(result.identity?.subject).toBe('user-1');
  });

  it('turns a verifier failure into a challenge carrying the error code', async () => {
    const result = await authorizeRequest(
      oauth,
      { authorization: 'Bearer bad' },
      {
        verifier: () =>
          Promise.resolve({
            ok: false as const,
            status: 401 as const,
            error: 'invalid_token' as const,
            description: 'Access token was not issued for this server',
          }),
        resourceMetadataUrl,
      },
    );

    expect(result.status).toBe(401);
    expect(result.challenge).toContain('error="invalid_token"');
    expect(result.challenge).toContain('Access token was not issued for this server');
  });

  it('propagates a 403 insufficient_scope verdict', async () => {
    const result = await authorizeRequest(
      oauth,
      { authorization: 'Bearer thin' },
      {
        verifier: () =>
          Promise.resolve({
            ok: false as const,
            status: 403 as const,
            error: 'insufficient_scope' as const,
            description: 'Missing required scope: ivanti:write',
          }),
        resourceMetadataUrl,
      },
    );

    expect(result.status).toBe(403);
    expect(result.challenge).toContain('error="insufficient_scope"');
  });
});
