// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { ANONYMOUS } from './auth/identity.js';
import { createOAuthSetup } from './auth/oauth/create-verifier.js';
import type { TokenVerifier } from './auth/oauth/verify-token.js';
import { ConfigError, loadConfig } from './config/load-config.js';
import { isImpersonationConfigured, isIvantiConfigured } from './config/validate-config.js';
import { connectIvanti } from './ivanti/connect.js';
import { validateBusinessObjectAllowlist } from './ivanti/validate-allowlist.js';

import { createLogger } from './logger.js';
import { createServerFactory, SERVER_NAME, SERVER_VERSION } from './server/create-server.js';
import { readSdkVersion } from './version.js';
import { startHttp } from './server/start-http.js';
import { startStdio } from './server/start-stdio.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.LOG_LEVEL);

  // Probed before either transport starts. Which base path a tenant uses is not configuration,
  // it is a fact about the tenant — and a tenant that cannot be reached at all is a startup
  // failure rather than something to discover inside the first tool call.
  const ivanti = isIvantiConfigured(config)
    ? await connectIvanti({
        baseUrl: config.IVANTI_BASE_URL,
        apiKey: config.IVANTI_API_KEY,
        logger,
        ...(config.IVANTI_MAX_TIER === undefined ? {} : { maxTier: config.IVANTI_MAX_TIER }),
        // Both or neither: validateConfig has already refused the half-configured case.
        ...(isImpersonationConfigured(config)
          ? {
              impersonation: {
                configUrl: config.IVANTI_CONFIG_URL,
                apiKey: config.IVANTI_CENTRAL_CONFIG_API_KEY,
              },
            }
          : {}),
      })
    : undefined;

  // The allowlist is the whole of what an end user may do, so a name the tenant does not have is
  // a configuration error rather than an empty result later.
  if (ivanti !== undefined && config.MCP_MODE === 'enduser') {
    const problems = await validateBusinessObjectAllowlist(ivanti, config.ENDUSER_BUSINESS_OBJECTS);
    if (problems.length > 0) throw new ConfigError(problems);
  }

  if (ivanti === undefined) {
    logger.warn('ivanti is not configured; serving transport-level tools only', {
      missing: 'IVANTI_BASE_URL and IVANTI_API_KEY (or IVANTI_API_KEY_FILE)',
    });
  }

  // Tool definitions are built once here; each connection gets its own server around them,
  // because `connect()` binds one transport at a time.
  const factory = createServerFactory(config, {
    logger,
    ...(ivanti === undefined ? {} : { ivanti }),
  });

  if (config.STDIO_TRANSPORT_ON) {
    // Process trust: whoever can run this binary is the caller, and nothing vouches for who
    // they are. One process is one conversation, so there is no session id either.
    await startStdio(factory.create({ identity: ANONYMOUS }));
    logger.info('listening on stdio', {
      mcpMode: config.MCP_MODE,
      ivanti: ivanti !== undefined,
      tools: factory.toolNames,
    });
  }

  if (!config.HTTP_TRANSPORT_ON) return;

  if (config.AUTH_MODE === 'none') {
    logger.warn('AUTH_MODE=none: no authentication, the network is the only boundary', {
      bind: config.MCP_BIND,
      port: config.MCP_PORT,
      trustedOrigins: config.TRUSTED_ORIGINS,
    });
  }

  // `enduser` scopes records to one person per MCP session, and a session is whatever the client
  // opened — so a gateway that multiplexes many people onto one connection would show the second
  // person the first person's records. Under `oauth` this cannot happen: every request carries a
  // token and a session belongs to the subject that opened it (`sameSubject`, 403 otherwise).
  // Under `none` and `bearer` there is no per-request principal at all, so the server cannot tell
  // two people apart and the deployment has to.
  if (config.MCP_MODE === 'enduser' && config.AUTH_MODE !== 'oauth') {
    logger.warn(
      'enduser over HTTP without oauth: every person must get their own MCP session — this ' +
        'server cannot tell two callers apart on one',
      { authMode: config.AUTH_MODE },
    );
  }

  let verifier: TokenVerifier | undefined;
  if (config.AUTH_MODE === 'oauth') {
    const setup = await createOAuthSetup(config);
    verifier = setup.verifier;
    logger.info('oauth resource server ready', {
      issuer: setup.issuer,
      audiences: setup.audiences,
      jwksUri: setup.jwksUri,
    });
  }

  const http = startHttp(config, logger, {
    verifier,
    createMcpServer: factory.create,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    sdkVersion: readSdkVersion(),
  });

  // Containers are killed, not asked politely: let in-flight requests finish and close
  // every live session rather than dropping them on the floor.
  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    http.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('listening on http', {
    bind: config.MCP_BIND,
    port: config.MCP_PORT,
    authMode: config.AUTH_MODE,
    mcpMode: config.MCP_MODE,
    ivanti: ivanti !== undefined,
    maxSessions: config.MCP_MAX_SESSIONS,
    tools: factory.toolNames,
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
