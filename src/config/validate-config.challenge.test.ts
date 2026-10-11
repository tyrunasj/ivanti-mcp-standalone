// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { configFixture } from './config.fixture.js';
import { validateConfig } from './validate-config.js';

const OAUTH = {
  HTTP_TRANSPORT_ON: true,
  AUTH_MODE: 'oauth' as const,
  OAUTH_ISSUER: 'https://id.example.com',
  MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
  TRUSTED_ORIGINS: ['https://mcp.example.com'],
};

// The 401 challenge advertises these verbatim; the header sanitiser would rewrite a quote or a
// non-ASCII character to a space, splitting a scope token or altering a URL.
describe('validateConfig: what the 401 challenge advertises', () => {
  it('accepts four long Entra scopes, which are past 200 characters', () => {
    const scopes = ['Read', 'Write', 'Delete', 'Attach'].map(
      (name) => `api://11111111-2222-3333-4444-555555555555/Ivanti.${name}`,
    );

    expect(validateConfig(configFixture({ ...OAUTH, OAUTH_REQUIRED_SCOPES: scopes }))).toEqual([]);
  });

  it.each(['say"cheese', 'back\\slash', 'café'])('refuses the scope %s, naming it', (scope) => {
    const problems = validateConfig(configFixture({ ...OAUTH, OAUTH_REQUIRED_SCOPES: [scope] }));

    expect(problems.join('\n')).toContain('OAUTH_REQUIRED_SCOPES');
    expect(problems.join('\n')).toContain(scope);
  });

  // `URL` percent-encodes what the sanitiser would rewrite, so a long address is the real hazard
  // and the old 200-character cut is what it used to meet.
  it('accepts a 300-character public URL', () => {
    const url = `https://${'a'.repeat(280)}.example.com/mcp`;

    expect(validateConfig(configFixture({ ...OAUTH, MCP_PUBLIC_URL: url }))).toEqual([]);
  });

  it('refuses a challenge past what a proxy will pass', () => {
    const scopes = Array.from({ length: 80 }, (_, index) => `${'s'.repeat(60)}${String(index)}`);

    const problems = validateConfig(configFixture({ ...OAUTH, OAUTH_REQUIRED_SCOPES: scopes }));

    expect(problems.join('\n')).toMatch(/challenge would be about/);
  });

  it('says nothing about the challenge outside oauth', () => {
    const problems = validateConfig(
      configFixture({ ...OAUTH, AUTH_MODE: 'none', OAUTH_REQUIRED_SCOPES: ['say"cheese'] }),
    );

    expect(problems.join('\n')).not.toContain('WWW-Authenticate');
  });
});
