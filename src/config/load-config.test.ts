// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

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

  it('expires an identity on its own clock, not the HTTP session\'s', () => {
    // The identity TTL borrowed MCP_SESSION_IDLE_TTL_SECONDS for one release. They answer
    // different questions — one bounds memory held by a dead HTTP session, the other decides how
    // long a person\'s records stay reachable to whoever is at the keyboard, and on stdio it is
    // the only thing that ends a conversation at all. Tuning one must not move the other.
    const config = loadConfig({ MCP_SESSION_IDLE_TTL_SECONDS: '60' });

    expect(config.MCP_SESSION_IDLE_TTL_SECONDS).toBe(60);
    expect(config.MCP_IDENTITY_IDLE_TTL_SECONDS).toBe(1800);

    const tuned = loadConfig({ MCP_IDENTITY_IDLE_TTL_SECONDS: '300' });

    expect(tuned.MCP_IDENTITY_IDLE_TTL_SECONDS).toBe(300);
    expect(tuned.MCP_SESSION_IDLE_TTL_SECONDS).toBe(1800);
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

  // The secrets resolve in their own loop, and it used to read the RAW record — so the rule above
  // stopped at their doorstep. Clearing the inline form is the documented way to move to a mounted
  // file, and it reported the opposite of what the operator had just done.
  describe('a secret set to nothing is unset too', () => {
    it('lets an emptied inline token hand over to its _FILE partner', () => {
      const config = loadConfig(
        {
          AUTH_MODE: 'bearer',
          HTTP_TRANSPORT_ON: 'true',
          MCP_PUBLIC_URL: 'https://mcp.example.com',
          TRUSTED_ORIGINS: 'https://mcp.example.com',
          BEARER_TOKEN: '',
          BEARER_TOKEN_FILE: '/run/secrets/bearer-token',
        },
        () => 'token-from-file',
      );

      expect(config.BEARER_TOKEN).toBe('token-from-file');
    });

    it('lets an emptied _FILE path hand back to the inline form', () => {
      const config = loadConfig({
        IVANTI_BASE_URL: 'https://t.ivanticloud.com',
        IVANTI_API_KEY: 'inline-key',
        IVANTI_API_KEY_FILE: '',
      });

      expect(config.IVANTI_API_KEY).toBe('inline-key');
    });

    // The one direction this failed OPEN: without the normalisation a whitespace-only token was a
    // token, and `bearer` mode started with it.
    it('refuses to start on a whitespace-only bearer token', () => {
      expect(() =>
        loadConfig({
          AUTH_MODE: 'bearer',
          HTTP_TRANSPORT_ON: 'true',
          MCP_PUBLIC_URL: 'https://mcp.example.com',
          TRUSTED_ORIGINS: 'https://mcp.example.com',
          BEARER_TOKEN: '   ',
        }),
      ).toThrow(/BEARER_TOKEN/);
    });

    // Narrowing check: a genuine both-set collision must still be refused.
    it('still refuses a token that really is set both ways', () => {
      expect(() =>
        loadConfig(
          { BEARER_TOKEN: 'inline', BEARER_TOKEN_FILE: '/run/secrets/bearer-token' },
          () => 'from-file',
        ),
      ).toThrow(/provide exactly one/);
    });
  });
});
