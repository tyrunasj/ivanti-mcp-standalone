import type { Config } from './env-schema.js';

/**
 * Test-only Config builder. Kept in one place so that adding a setting does not require
 * editing every test that happens to need a Config.
 */
export const configFixture = (overrides: Partial<Config> = {}): Config => ({
  STDIO_TRANSPORT_ON: true,
  HTTP_TRANSPORT_ON: false,
  AUTH_MODE: undefined,
  MCP_MODE: 'full',
  MCP_BIND: '127.0.0.1',
  MCP_PORT: 3000,
  MCP_PUBLIC_URL: undefined,
  TRUSTED_ORIGINS: [],
  MCP_SESSION_IDLE_TTL_SECONDS: 1800,
  MCP_MAX_SESSIONS: 100,
  BEARER_TOKEN: undefined,
  OAUTH_ISSUER: undefined,
  OAUTH_AUDIENCE: [],
  OAUTH_JWKS_URI: undefined,
  OAUTH_SCOPES_SUPPORTED: [],
  OAUTH_REQUIRED_SCOPES: [],
  ENDUSER_BUSINESS_OBJECTS: [],
  LOG_LEVEL: 'info',
  ...overrides,
});
