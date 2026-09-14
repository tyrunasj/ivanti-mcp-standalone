// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import {
  buildProtectedResourceMetadata,
  metadataPaths,
  metadataUrl,
} from './protected-resource-metadata.js';

describe('buildProtectedResourceMetadata', () => {
  it('always names at least one authorization server', () => {
    const metadata = buildProtectedResourceMetadata({
      resource: 'https://mcp.example.com/mcp',
      issuer: 'https://id.example.com',
    });

    expect(metadata.authorization_servers).toEqual(['https://id.example.com']);
    expect(metadata.resource).toBe('https://mcp.example.com/mcp');
    expect(metadata.bearer_methods_supported).toEqual(['header']);
  });

  it('omits scopes_supported entirely when there are none', () => {
    const metadata = buildProtectedResourceMetadata({
      resource: 'https://mcp.example.com',
      issuer: 'https://id.example.com',
    });

    expect(metadata.scopes_supported).toBeUndefined();
  });

  it('never advertises offline_access, which is not a resource requirement', () => {
    const metadata = buildProtectedResourceMetadata({
      resource: 'https://mcp.example.com',
      issuer: 'https://id.example.com',
      scopesSupported: ['openid', 'offline_access', 'ivanti:read'],
    });

    expect(metadata.scopes_supported).toEqual(['openid', 'ivanti:read']);
  });
});

describe('metadataPaths', () => {
  it('inserts the resource path, most specific first', () => {
    expect(metadataPaths('https://example.com/public/mcp')).toEqual([
      '/.well-known/oauth-protected-resource/public/mcp',
      '/.well-known/oauth-protected-resource',
    ]);
  });

  it('serves only the root path for a root resource', () => {
    expect(metadataPaths('https://example.com')).toEqual([
      '/.well-known/oauth-protected-resource',
    ]);
  });

  it('does not emit a doubled slash for a trailing-slash resource', () => {
    expect(metadataPaths('https://example.com/')).toEqual([
      '/.well-known/oauth-protected-resource',
    ]);
  });
});

describe('metadataUrl', () => {
  it('advertises the path-inserted form', () => {
    expect(metadataUrl('https://mcp.example.com/mcp')).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('keeps a non-default port', () => {
    expect(metadataUrl('https://mcp.example.com:8443/mcp')).toBe(
      'https://mcp.example.com:8443/.well-known/oauth-protected-resource/mcp',
    );
  });
});
