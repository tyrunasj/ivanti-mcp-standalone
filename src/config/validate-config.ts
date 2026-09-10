import type { Config } from './env-schema.js';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost']);

export function isHttpTransport(config: Config): boolean {
  return config.HTTP_TRANSPORT_ON;
}

export function isStdioTransport(config: Config): boolean {
  return config.STDIO_TRANSPORT_ON;
}

/**
 * Open mode binds loopback by default, so reaching the network takes a second deliberate
 * key (`MCP_BIND`). That is allowed — it is the intended corporate-network deployment —
 * but the caller is expected to say so loudly in the startup log.
 */
/**
 * The audience a token must name. Defaults to the resource identifier, which is what the spec
 * assumes, but real IdPs mint their own — so it is overridable.
 */
export function expectedAudience(config: Config): string | undefined {
  return config.OAUTH_AUDIENCE ?? config.MCP_PUBLIC_URL;
}

export function isExposedToNetwork(config: Config): boolean {
  return !LOOPBACK_ADDRESSES.has(config.MCP_BIND);
}

/**
 * MCP_PUBLIC_URL doubles as the OAuth resource identifier, which the spec requires to be a
 * canonical URI (RFC 8707 §2). A client sends this exact string as its `resource` parameter
 * and the token's audience is compared against it, so a fragment or a stray trailing slash
 * produces an audience mismatch that reads like a client bug.
 */
export function canonicalUriProblems(url: string): string[] {
  const problems: string[] = [];

  if (url.includes('#')) {
    problems.push(`MCP_PUBLIC_URL must not contain a fragment: ${url}`);
  }

  if (url.endsWith('/')) {
    problems.push(
      `MCP_PUBLIC_URL must not end with a trailing slash: ${url}. The resource identifier ` +
        'is compared verbatim against the token audience.',
    );
  }

  return problems;
}

/**
 * Cross-field rules the server refuses to start without.
 *
 * Every rule here fails closed: a container will be run by people who have not read the
 * README, so an incomplete configuration must stop the process rather than quietly
 * degrade into something less protected than intended.
 */
export function validateConfig(config: Config): string[] {
  const problems: string[] = [];

  if (!config.STDIO_TRANSPORT_ON && !config.HTTP_TRANSPORT_ON) {
    problems.push(
      'Both STDIO_TRANSPORT_ON and HTTP_TRANSPORT_ON are off; the server would serve nobody.',
    );
  }

  if (isHttpTransport(config) && config.AUTH_MODE === undefined) {
    problems.push(
      'HTTP_TRANSPORT_ON=true requires AUTH_MODE (none | bearer | oauth). Refusing to serve ' +
        'on a socket without an explicit decision about who may connect.',
    );
  }

  if (!isHttpTransport(config) && config.AUTH_MODE !== undefined) {
    problems.push(
      `AUTH_MODE=${config.AUTH_MODE} has no effect with HTTP_TRANSPORT_ON=false, where the ` +
        'credential is the ability to run the process. Remove it rather than rely on it.',
    );
  }

  if (isHttpTransport(config)) {
    if (config.MCP_PUBLIC_URL !== undefined) {
      problems.push(...canonicalUriProblems(config.MCP_PUBLIC_URL));
    }

    if (config.MCP_PUBLIC_URL === undefined) {
      problems.push(
        'MCP_PUBLIC_URL is required for HTTP transports. It must be the externally visible ' +
          'URL and is never derived from the request, because a reverse proxy rewrites Host ' +
          'and scheme while token audiences must still match exactly.',
      );
    }

    if (config.TRUSTED_ORIGINS.length === 0) {
      problems.push(
        'TRUSTED_ORIGINS is required for HTTP transports. Origin validation is mandatory ' +
          'and is what prevents DNS rebinding from a page the user merely visits.',
      );
    }
  }

  if (config.AUTH_MODE === 'bearer' && config.BEARER_TOKEN === undefined) {
    problems.push('AUTH_MODE=bearer requires BEARER_TOKEN or BEARER_TOKEN_FILE.');
  }

  if (config.AUTH_MODE === 'oauth' && config.OAUTH_ISSUER === undefined) {
    problems.push('AUTH_MODE=oauth requires OAUTH_ISSUER.');
  }

  if (config.MCP_MODE === 'enduser' && config.ENDUSER_BUSINESS_OBJECTS.length === 0) {
    problems.push(
      'MCP_MODE=enduser requires ENDUSER_BUSINESS_OBJECTS, listing the technical Business ' +
        'Object names end users may create.',
    );
  }

  return problems;
}
