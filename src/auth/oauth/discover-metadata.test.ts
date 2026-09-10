import { describe, expect, it, vi } from 'vitest';
import {
  authorizationServerMetadataUrls,
  discoverAuthorizationServer,
  type FetchLike,
} from './discover-metadata.js';

const ok = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) });
const notFound = { ok: false, json: () => Promise.resolve({}) };

describe('authorizationServerMetadataUrls', () => {
  it('probes two endpoints for a path-less issuer (Zitadel shape)', () => {
    expect(authorizationServerMetadataUrls('https://id.example.com')).toEqual([
      'https://id.example.com/.well-known/oauth-authorization-server',
      'https://id.example.com/.well-known/openid-configuration',
    ]);
  });

  it('probes three, path-insertion first, for an issuer with a path (Entra shape)', () => {
    expect(
      authorizationServerMetadataUrls('https://login.microsoftonline.com/tenant-id/v2.0'),
    ).toEqual([
      'https://login.microsoftonline.com/.well-known/oauth-authorization-server/tenant-id/v2.0',
      'https://login.microsoftonline.com/.well-known/openid-configuration/tenant-id/v2.0',
      'https://login.microsoftonline.com/tenant-id/v2.0/.well-known/openid-configuration',
    ]);
  });
});

describe('discoverAuthorizationServer', () => {
  const issuer = 'https://id.example.com';
  const metadata = { issuer, jwks_uri: 'https://id.example.com/keys' };

  it('returns the first document that resolves', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(metadata)) as unknown as FetchLike;

    await expect(discoverAuthorizationServer(issuer, fetchImpl)).resolves.toEqual(metadata);
  });

  it('falls through to the next candidate on a 404', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce(ok(metadata)) as unknown as FetchLike;

    await expect(discoverAuthorizationServer(issuer, fetchImpl)).resolves.toEqual(metadata);
  });

  it('falls through when a candidate throws', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(ok(metadata)) as unknown as FetchLike;

    await expect(discoverAuthorizationServer(issuer, fetchImpl)).resolves.toEqual(metadata);
  });

  it('rejects a document claiming a different issuer', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(ok({ issuer: 'https://attacker.example', jwks_uri: 'x' })) as unknown as FetchLike;

    await expect(discoverAuthorizationServer(issuer, fetchImpl)).rejects.toThrow(
      /does not match the configured OAUTH_ISSUER/,
    );
  });

  it('reports every URL it tried when discovery fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(notFound) as unknown as FetchLike;

    await expect(discoverAuthorizationServer(issuer, fetchImpl)).rejects.toThrow(
      /oauth-authorization-server[\s\S]*openid-configuration/,
    );
  });
});
