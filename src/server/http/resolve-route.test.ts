import { describe, expect, it } from 'vitest';
import { resolveRoute } from './resolve-route.js';

const oauthPaths = new Set([
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-protected-resource',
]);

describe('resolveRoute', () => {
  it('routes the health probe', () => {
    expect(resolveRoute('/health', oauthPaths)).toBe('health');
  });

  it('routes the MCP endpoint', () => {
    expect(resolveRoute('/mcp', oauthPaths)).toBe('mcp');
  });

  it('routes both OAuth metadata paths', () => {
    expect(resolveRoute('/.well-known/oauth-protected-resource/mcp', oauthPaths)).toBe(
      'oauth-metadata',
    );
    expect(resolveRoute('/.well-known/oauth-protected-resource', oauthPaths)).toBe(
      'oauth-metadata',
    );
  });

  it('ignores the query string', () => {
    expect(resolveRoute('/mcp?sessionId=abc', oauthPaths)).toBe('mcp');
  });

  it('does not route metadata paths when OAuth is off', () => {
    expect(resolveRoute('/.well-known/oauth-protected-resource', new Set())).toBe('not-found');
  });

  it('falls through to not-found', () => {
    expect(resolveRoute('/nope', oauthPaths)).toBe('not-found');
    expect(resolveRoute(undefined, oauthPaths)).toBe('not-found');
    expect(resolveRoute('/mcp/extra', oauthPaths)).toBe('not-found');
  });
});
