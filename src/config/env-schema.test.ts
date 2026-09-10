import { describe, expect, it } from 'vitest';
import { envSchema } from './env-schema.js';

describe('envSchema', () => {
  it('applies safe defaults around an empty environment', () => {
    const config = envSchema.parse({});

    expect(config.STDIO_TRANSPORT_ON).toBe(true);
    expect(config.HTTP_TRANSPORT_ON).toBe(false);
    expect(config.AUTH_MODE).toBeUndefined();
    expect(config.MCP_MODE).toBe('full');
    expect(config.MCP_BIND).toBe('127.0.0.1');
    expect(config.MCP_PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.TRUSTED_ORIGINS).toEqual([]);
  });

  it('rejects an unknown auth mode', () => {
    expect(envSchema.safeParse({ AUTH_MODE: 'open' }).success).toBe(false);
  });

  it('ignores a removed setting rather than failing on it', () => {
    // MCP_TRANSPORT was replaced by the two toggles; unknown keys are not an error.
    expect(envSchema.safeParse({ MCP_TRANSPORT: 'websocket' }).success).toBe(true);
  });

  it('no longer accepts stdio as an auth mode, now that it is a transport', () => {
    expect(envSchema.safeParse({ AUTH_MODE: 'stdio' }).success).toBe(false);
  });

  it('splits comma-separated lists and trims blanks', () => {
    const config = envSchema.parse({
      ENDUSER_BUSINESS_OBJECTS: 'Incident, ChangeRequest ,,ServiceReq',
    });

    expect(config.ENDUSER_BUSINESS_OBJECTS).toEqual(['Incident', 'ChangeRequest', 'ServiceReq']);
  });

  it('coerces the port from its string environment form', () => {
    expect(envSchema.parse({ MCP_PORT: '8080' }).MCP_PORT).toBe(8080);
  });

  it('rejects a public URL that is not a URL', () => {
    expect(
      envSchema.safeParse({ MCP_PUBLIC_URL: 'mcp.example.com' }).success,
    ).toBe(false);
  });
});
