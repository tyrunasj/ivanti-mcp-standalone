import { describe, expect, it, vi } from 'vitest';
import { configFixture } from '../../config/config.fixture.js';
import type { FetchLike } from './discover-metadata.js';
import { createOAuthSetup } from './create-verifier.js';

const oauthConfig = configFixture({
  AUTH_MODE: 'oauth',
  MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
  OAUTH_ISSUER: 'https://id.example.com',
});

const discovery =
  (jwksUri: string): FetchLike =>
  () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ issuer: 'https://id.example.com', jwks_uri: jwksUri }),
    });

describe('createOAuthSetup', () => {
  it('discovers the JWKS URI from the issuer', async () => {
    const setup = await createOAuthSetup(oauthConfig, discovery('https://id.example.com/keys'));

    expect(setup.jwksUri).toBe('https://id.example.com/keys');
  });

  it('defaults the audience to the resource identifier', async () => {
    const setup = await createOAuthSetup(oauthConfig, discovery('https://id.example.com/keys'));

    expect(setup.audience).toBe('https://mcp.example.com/mcp');
  });

  it('prefers an explicitly configured audience, as real IdPs require', async () => {
    const setup = await createOAuthSetup(
      { ...oauthConfig, OAUTH_AUDIENCE: 'api://ivanti-mcp' },
      discovery('https://id.example.com/keys'),
    );

    expect(setup.audience).toBe('api://ivanti-mcp');
  });

  it('skips discovery entirely when OAUTH_JWKS_URI is set', async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;

    const setup = await createOAuthSetup(
      { ...oauthConfig, OAUTH_JWKS_URI: 'https://id.example.com/custom-keys' },
      fetchImpl,
    );

    expect(setup.jwksUri).toBe('https://id.example.com/custom-keys');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses to build a verifier without an issuer', async () => {
    await expect(
      createOAuthSetup({ ...oauthConfig, OAUTH_ISSUER: undefined }, discovery('x')),
    ).rejects.toThrow(/requires OAUTH_ISSUER/);
  });
});
