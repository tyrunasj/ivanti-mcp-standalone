import { describe, expect, it } from 'vitest';
import { configFixture } from './config.fixture.js';
import {
  canonicalUriProblems,
  isExposedToNetwork,
  isHttpTransport,
  isIvantiConfigured,
  validateConfig,
} from './validate-config.js';

const config = configFixture;

describe('isHttpTransport', () => {
  it('is decided by the transport, not by the auth mode', () => {
    expect(isHttpTransport(config({ STDIO_TRANSPORT_ON: true }))).toBe(false);
    expect(isHttpTransport(config({ HTTP_TRANSPORT_ON: true, AUTH_MODE: 'none' }))).toBe(true);
    expect(isHttpTransport(config({ HTTP_TRANSPORT_ON: true, AUTH_MODE: 'oauth' }))).toBe(true);
  });
});

describe('isExposedToNetwork', () => {
  it('recognises loopback addresses', () => {
    expect(isExposedToNetwork(config({ MCP_BIND: '127.0.0.1' }))).toBe(false);
    expect(isExposedToNetwork(config({ MCP_BIND: '::1' }))).toBe(false);
  });

  it('treats anything else as exposed', () => {
    expect(isExposedToNetwork(config({ MCP_BIND: '0.0.0.0' }))).toBe(true);
  });
});

describe('canonicalUriProblems', () => {
  it('accepts a canonical resource URI', () => {
    expect(canonicalUriProblems('https://mcp.example.com/mcp')).toEqual([]);
    expect(canonicalUriProblems('https://mcp.example.com')).toEqual([]);
    expect(canonicalUriProblems('https://mcp.example.com:8443')).toEqual([]);
  });

  it('rejects a fragment, which RFC 8707 forbids in a resource identifier', () => {
    expect(canonicalUriProblems('https://mcp.example.com/mcp#x')).toHaveLength(1);
  });

  it('rejects a trailing slash, which would not match the token audience verbatim', () => {
    expect(canonicalUriProblems('https://mcp.example.com/')).toHaveLength(1);
  });
});

describe('validateConfig', () => {
  it('accepts a minimal stdio configuration', () => {
    expect(validateConfig(config())).toEqual([]);
  });

  it('refuses a configuration that serves nobody', () => {
    const problems = validateConfig(config({ STDIO_TRANSPORT_ON: false }));

    expect(problems.some((problem) => problem.includes('would serve nobody'))).toBe(true);
  });

  it('allows both transports at once', () => {
    const problems = validateConfig(
      config({
        STDIO_TRANSPORT_ON: true,
        HTTP_TRANSPORT_ON: true,
        AUTH_MODE: 'none',
        MCP_PUBLIC_URL: 'http://127.0.0.1:3000/mcp',
        TRUSTED_ORIGINS: ['https://claude.ai'],
      }),
    );

    expect(problems).toEqual([]);
  });

  it('requires an explicit auth mode before serving on a socket', () => {
    const problems = validateConfig(config({ HTTP_TRANSPORT_ON: true }));

    expect(problems.some((problem) => problem.includes('requires AUTH_MODE'))).toBe(true);
  });

  it('rejects an auth mode under stdio rather than letting it look protective', () => {
    const problems = validateConfig(config({ AUTH_MODE: 'bearer', BEARER_TOKEN: 't' }));

    expect(
      problems.some((problem) => problem.includes('no effect with HTTP_TRANSPORT_ON=false')),
    ).toBe(true);
  });

  it('requires MCP_PUBLIC_URL for HTTP transports', () => {
    const problems = validateConfig(config({ HTTP_TRANSPORT_ON: true, AUTH_MODE: 'bearer', BEARER_TOKEN: 't' }));

    expect(problems.some((problem) => problem.includes('MCP_PUBLIC_URL'))).toBe(true);
  });

  it('surfaces a non-canonical public URL', () => {
    const problems = validateConfig(
      config({
        HTTP_TRANSPORT_ON: true,
        AUTH_MODE: 'bearer',
        BEARER_TOKEN: 't',
        MCP_PUBLIC_URL: 'https://mcp.example.com/',
        TRUSTED_ORIGINS: ['https://claude.ai'],
      }),
    );

    expect(problems.some((problem) => problem.includes('trailing slash'))).toBe(true);
  });

  it('requires TRUSTED_ORIGINS for HTTP transports', () => {
    const problems = validateConfig(
      config({
        HTTP_TRANSPORT_ON: true,
        AUTH_MODE: 'bearer',
        BEARER_TOKEN: 't',
        MCP_PUBLIC_URL: 'https://mcp.example.com',
      }),
    );

    expect(problems.some((problem) => problem.includes('TRUSTED_ORIGINS'))).toBe(true);
  });

  it('requires a token in bearer mode', () => {
    const problems = validateConfig(config({ HTTP_TRANSPORT_ON: true, AUTH_MODE: 'bearer' }));

    expect(problems.some((problem) => problem.includes('BEARER_TOKEN'))).toBe(true);
  });

  it('permits open mode on a non-loopback bind, since MCP_BIND is a second explicit key', () => {
    const problems = validateConfig(
      config({
        HTTP_TRANSPORT_ON: true,
        AUTH_MODE: 'none',
        MCP_BIND: '0.0.0.0',
        MCP_PUBLIC_URL: 'https://mcp.example.com',
        TRUSTED_ORIGINS: ['https://claude.ai'],
      }),
    );

    expect(problems).toEqual([]);
  });

  it('still requires an origin allowlist when open mode is exposed', () => {
    const problems = validateConfig(
      config({
        HTTP_TRANSPORT_ON: true,
        AUTH_MODE: 'none',
        MCP_BIND: '0.0.0.0',
        MCP_PUBLIC_URL: 'https://mcp.example.com',
      }),
    );

    expect(problems.some((problem) => problem.includes('TRUSTED_ORIGINS'))).toBe(true);
  });

  it('allows open mode on loopback', () => {
    const problems = validateConfig(
      config({
        HTTP_TRANSPORT_ON: true,
        AUTH_MODE: 'none',
        MCP_PUBLIC_URL: 'http://127.0.0.1:3000',
        TRUSTED_ORIGINS: ['http://localhost:3000'],
      }),
    );

    expect(problems).toEqual([]);
  });

  it('requires a Business Object allowlist in enduser mode', () => {
    const problems = validateConfig(config({ MCP_MODE: 'enduser' }));

    expect(problems.some((problem) => problem.includes('ENDUSER_BUSINESS_OBJECTS'))).toBe(true);
  });

  it('accepts enduser mode once the allowlist is present', () => {
    const problems = validateConfig(
      config({ MCP_MODE: 'enduser', ENDUSER_BUSINESS_OBJECTS: ['Incident'] }),
    );

    expect(problems).toEqual([]);
  });

  it('refuses an Ivanti base URL without a key', () => {
    const problems = validateConfig(config({ IVANTI_BASE_URL: 'https://t.ivanticloud.com' }));

    expect(problems.some((problem) => problem.includes('IVANTI_API_KEY'))).toBe(true);
  });

  it('refuses an Ivanti key without a base URL', () => {
    const problems = validateConfig(config({ IVANTI_API_KEY: 'k' }));

    expect(problems.some((problem) => problem.includes('IVANTI_BASE_URL'))).toBe(true);
  });

  it('accepts both together, and neither at all', () => {
    expect(
      validateConfig(config({ IVANTI_BASE_URL: 'https://t.ivanticloud.com', IVANTI_API_KEY: 'k' })),
    ).toEqual([]);
    expect(validateConfig(config({}))).toEqual([]);
  });
});

describe('isIvantiConfigured', () => {
  it('is true only when both halves are present', () => {
    expect(isIvantiConfigured(config({}))).toBe(false);
    expect(isIvantiConfigured(config({ IVANTI_BASE_URL: 'https://t' }))).toBe(false);
    expect(isIvantiConfigured(config({ IVANTI_API_KEY: 'k' }))).toBe(false);
    expect(isIvantiConfigured(config({ IVANTI_BASE_URL: 'https://t', IVANTI_API_KEY: 'k' }))).toBe(
      true,
    );
  });
});
