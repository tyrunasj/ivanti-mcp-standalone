import { describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from './load-config.js';

describe('loadConfig', () => {
  it('loads with no environment at all, defaulting to stdio', () => {
    const config = loadConfig({});

    expect(config.STDIO_TRANSPORT_ON).toBe(true);
    expect(config.HTTP_TRANSPORT_ON).toBe(false);
    expect(config.AUTH_MODE).toBeUndefined();
    expect(config.MCP_MODE).toBe('full');
  });

  it('resolves a file-backed secret before validating rules that depend on it', () => {
    const readFile = vi.fn().mockReturnValue('token-from-file\n');

    const config = loadConfig(
      {
        HTTP_TRANSPORT_ON: 'true',
        AUTH_MODE: 'bearer',
        BEARER_TOKEN_FILE: '/run/secrets/bearer',
        MCP_PUBLIC_URL: 'https://mcp.example.com',
        TRUSTED_ORIGINS: 'https://claude.ai',
      },
      readFile,
    );

    expect(config.BEARER_TOKEN).toBe('token-from-file');
  });

  it('reports schema problems as a ConfigError', () => {
    expect(() => loadConfig({ AUTH_MODE: 'nonsense' })).toThrow(ConfigError);
  });

  it('refuses an HTTP transport with no auth mode chosen', () => {
    try {
      loadConfig({ HTTP_TRANSPORT_ON: 'true' });
      expect.unreachable('expected a ConfigError');
    } catch (error) {
      expect((error as ConfigError).problems.join(' ')).toContain('requires AUTH_MODE');
    }
  });

  it('reports cross-field problems as a ConfigError', () => {
    try {
      loadConfig({ HTTP_TRANSPORT_ON: 'true', AUTH_MODE: 'bearer', BEARER_TOKEN: 't' });
      expect.unreachable('expected a ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems.join(' ')).toContain('MCP_PUBLIC_URL');
    }
  });

  it('collects every schema problem rather than only the first', () => {
    try {
      loadConfig({ MCP_PORT: 'not-a-port', LOG_LEVEL: 'chatty' });
      expect.unreachable('expected a ConfigError');
    } catch (error) {
      expect((error as ConfigError).problems.length).toBeGreaterThan(1);
    }
  });

  it('surfaces a conflicting inline/file secret', () => {
    expect(() =>
      loadConfig(
        { HTTP_TRANSPORT_ON: 'true', AUTH_MODE: 'bearer', BEARER_TOKEN: 'a', BEARER_TOKEN_FILE: '/x' },
        () => 'b',
      ),
    ).toThrow(/provide exactly one/);
  });

  it('resolves IVANTI_API_KEY_FILE the same way as the bearer token', () => {
    const config = loadConfig(
      { IVANTI_BASE_URL: 'https://t.ivanticloud.com', IVANTI_API_KEY_FILE: '/run/secrets/ivanti' },
      () => 'key-from-file',
    );

    expect(config.IVANTI_API_KEY).toBe('key-from-file');
  });

  it('treats a variable set to nothing as unset', () => {
    // `docker run -e AUTH_MODE=` clears a value inherited from an --env-file; so does a bare
    // `AUTH_MODE=` line in .env. Neither should read as an invalid option.
    const config = loadConfig({ AUTH_MODE: '', MCP_BIND: '   ', MCP_MODE: 'enduser', ENDUSER_BUSINESS_OBJECTS: 'Incident' });

    expect(config.AUTH_MODE).toBeUndefined();
    expect(config.MCP_BIND).toBe('127.0.0.1');
  });

  it('still refuses a value that is wrong rather than empty', () => {
    expect(() => loadConfig({ AUTH_MODE: 'nonsense' })).toThrow(/Invalid option/);
  });
});
