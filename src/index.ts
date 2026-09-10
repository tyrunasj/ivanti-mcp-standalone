import { createOAuthSetup } from './auth/oauth/create-verifier.js';
import type { TokenVerifier } from './auth/oauth/verify-token.js';
import { ConfigError, loadConfig } from './config/load-config.js';

import { createLogger } from './logger.js';
import { createServerFactory } from './server/create-server.js';
import { startHttp } from './server/start-http.js';
import { startStdio } from './server/start-stdio.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.LOG_LEVEL);

  // Tool definitions are built once here; each connection gets its own server around them,
  // because `connect()` binds one transport at a time.
  const factory = createServerFactory(config);

  if (config.STDIO_TRANSPORT_ON) {
    await startStdio(factory.create());
    logger.info('listening on stdio', { mcpMode: config.MCP_MODE, tools: factory.toolNames });
  }

  if (!config.HTTP_TRANSPORT_ON) return;

  if (config.AUTH_MODE === 'none') {
    logger.warn('AUTH_MODE=none: no authentication, the network is the only boundary', {
      bind: config.MCP_BIND,
      port: config.MCP_PORT,
      trustedOrigins: config.TRUSTED_ORIGINS,
    });
  }

  let verifier: TokenVerifier | undefined;
  if (config.AUTH_MODE === 'oauth') {
    const setup = await createOAuthSetup(config);
    verifier = setup.verifier;
    logger.info('oauth resource server ready', {
      issuer: setup.issuer,
      audience: setup.audience,
      jwksUri: setup.jwksUri,
    });
  }

  const http = startHttp(config, logger, {
    verifier,
    createMcpServer: factory.create,
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
