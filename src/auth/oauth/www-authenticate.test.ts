import { describe, expect, it } from 'vitest';
import { buildWwwAuthenticate } from './www-authenticate.js';

const metadataUrl = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';

describe('buildWwwAuthenticate', () => {
  it('always advertises the resource metadata URL', () => {
    expect(buildWwwAuthenticate({ resourceMetadataUrl: metadataUrl })).toBe(
      `Bearer resource_metadata="${metadataUrl}"`,
    );
  });

  it('joins scopes with a space, as RFC 6750 requires', () => {
    const header = buildWwwAuthenticate({
      resourceMetadataUrl: metadataUrl,
      scope: ['files:read', 'files:write'],
    });

    expect(header).toContain('scope="files:read files:write"');
  });

  it('omits an empty scope list rather than emitting scope=""', () => {
    expect(buildWwwAuthenticate({ resourceMetadataUrl: metadataUrl, scope: [] })).not.toContain(
      'scope=',
    );
  });

  it('carries the error and description for an insufficient-scope challenge', () => {
    const header = buildWwwAuthenticate({
      resourceMetadataUrl: metadataUrl,
      error: 'insufficient_scope',
      errorDescription: 'File write permission required',
      scope: ['files:write'],
    });

    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('error_description="File write permission required"');
  });

  it('escapes quotes so a crafted description cannot break out of the header', () => {
    const header = buildWwwAuthenticate({
      resourceMetadataUrl: metadataUrl,
      error: 'invalid_token',
      errorDescription: 'bad " token',
    });

    expect(header).toContain('error_description="bad \\" token"');
  });
});
