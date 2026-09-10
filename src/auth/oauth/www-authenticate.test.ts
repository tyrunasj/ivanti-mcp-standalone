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

  it('collapses the whitespace left behind', () => {
    const header = buildWwwAuthenticate({
      resourceMetadataUrl: metadataUrl,
      error: 'invalid_token',
      errorDescription: 'a\n\nb\tc',
    });

    expect(header).toContain('error_description="a b c"');
  });

  it('truncates a long description rather than emitting a huge header', () => {
    const header = buildWwwAuthenticate({
      resourceMetadataUrl: metadataUrl,
      error: 'invalid_token',
      errorDescription: 'x'.repeat(500),
    });

    expect(header).toContain(`error_description="${'x'.repeat(200)}"`);
  });

  it('removes a quote so it cannot break out of the quoted string', () => {
    const header = buildWwwAuthenticate({
      resourceMetadataUrl: metadataUrl,
      error: 'invalid_token',
      errorDescription: 'bad " token',
    });

    expect(header).toContain('error_description="bad token"');
  });
});
