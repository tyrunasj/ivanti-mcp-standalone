// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { configFixture } from '../../config/config.fixture.js';
import type { FetchLike } from './discover-metadata.js';
import { createOAuthSetup, DISCOVERY_TIMEOUT_MS } from './create-verifier.js';

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

    expect(setup.audiences).toEqual(['https://mcp.example.com/mcp']);
  });

  it('prefers explicitly configured audiences, as real IdPs require', async () => {
    const setup = await createOAuthSetup(
      { ...oauthConfig, OAUTH_AUDIENCE: ['api://ivanti-mcp'] },
      discovery('https://id.example.com/keys'),
    );

    expect(setup.audiences).toEqual(['api://ivanti-mcp']);
  });

  it('accepts several audiences, since a deployment has more than one client', async () => {
    const setup = await createOAuthSetup(
      { ...oauthConfig, OAUTH_AUDIENCE: ['client-a', 'client-b'] },
      discovery('https://id.example.com/keys'),
    );

    expect(setup.audiences).toEqual(['client-a', 'client-b']);
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

  // Discovery runs before the listener opens, so an IdP that accepts the connection and never
  // answers holds the whole startup — nothing is listening on MCP_PORT, the container's health
  // check reports ECONNREFUSED, and the process is neither healthy, serving, nor exited. undici
  // bounds a bodyless fetch only by its 300 s headersTimeout, and Entra's issuer yields three
  // candidates to try in turn.
  it('bounds the default discovery fetch with a timeout', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
      seen.push(init?.signal);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ issuer: 'https://id.example.com', jwks_uri: 'https://id.example.com/keys' }),
      });
    }) as unknown as typeof globalThis.fetch;

    try {
      // No fetchImpl, so the module's own default is what runs.
      await createOAuthSetup(oauthConfig);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(seen.length).toBeGreaterThan(0);
    for (const signal of seen) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('gives that timeout a bound short enough to fail a startup rather than hang it', () => {
    expect(DISCOVERY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DISCOVERY_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('createOAuthSetup: OAUTH_REQUIRE_TYP', () => {
  const issue = async (typ: string): Promise<{ token: string; jwks: string }> => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig', kid: 'k1' };
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ })
      .setIssuer('https://id.example.com')
      .setAudience('https://mcp.example.com/mcp')
      .setSubject('u')
      .setExpirationTime('5m')
      .sign(privateKey);
    return { token, jwks: JSON.stringify({ keys: [jwk] }) };
  };

  const serve = async (body: string): Promise<{ url: string; close: () => void }> => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/keys`,
      close: () => void server.close(),
    };
  };

  it('hands the setting to the verifier it builds', async () => {
    const { token, jwks } = await issue('JWT');
    const keys = await serve(jwks);
    try {
      const open = await createOAuthSetup({ ...oauthConfig, OAUTH_JWKS_URI: keys.url }, vi.fn());
      const strict = await createOAuthSetup(
        { ...oauthConfig, OAUTH_JWKS_URI: keys.url, OAUTH_REQUIRE_TYP: true },
        vi.fn(),
      );

      expect((await open.verifier(token)).ok).toBe(true);
      expect(await strict.verifier(token)).toMatchObject({ ok: false, status: 401 });
    } finally {
      keys.close();
    }
  });
});
