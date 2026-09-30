// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { ANONYMOUS } from './auth/identity.js';
import { createOAuthSetup } from './auth/oauth/create-verifier.js';
import type { TokenVerifier } from './auth/oauth/verify-token.js';
import { ConfigError, loadConfig } from './config/load-config.js';
import {
  isImpersonationConfigured,
  isIvantiConfigured,
  requiredImpersonationProblems,
} from './config/validate-config.js';
import { checkTenant } from './ivanti/check-tenant.js';
import { connectIvanti } from './ivanti/connect.js';
import { validateBusinessObjectAllowlist } from './ivanti/validate-allowlist.js';

import { createLogger } from './logger.js';
import { createServerFactory, SERVER_NAME, SERVER_VERSION } from './server/create-server.js';
import { readSdkVersion } from './version.js';
import { startReadiness, type Readiness } from './server/http/readiness.js';
import { ListenError, startHttp, type HttpServer } from './server/start-http.js';
import { startStdio, type StdioServer } from './server/start-stdio.js';

/**
 * How long a graceful shutdown gets before the process exits regardless.
 *
 * Docker's default SIGTERM grace is 10 s and Kubernetes' `terminationGracePeriodSeconds` is 30, so
 * this sits under the smaller of the two: a shutdown that overruns it is going to be SIGKILLed
 * anyway, and exiting on our own terms at least logs why.
 */
const SHUTDOWN_GRACE_MS = 8_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.LOG_LEVEL);

  // The same crash Node would have, but as a JSON line with its stack rather than raw text
  // interleaved with the log. Exit 1 either way: after an uncaught error the process state is
  // unknown, and carrying on is how a half-broken server keeps answering.
  process.on('unhandledRejection', (error: unknown) => {
    logger.error('unhandled rejection', { error });
    process.exit(1);
  });
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught exception', { error });
    process.exit(1);
  });

  // Probed before either transport starts. Which base path a tenant uses is not configuration,
  // it is a fact about the tenant — and a tenant that cannot be reached at all is a startup
  // failure rather than something to discover inside the first tool call.
  const ivanti = isIvantiConfigured(config)
    ? await connectIvanti({
        baseUrl: config.IVANTI_BASE_URL,
        apiKey: config.IVANTI_API_KEY,
        logger,
        timeoutMs: config.IVANTI_TIMEOUT_MS,
        writeTimeoutMs: config.IVANTI_WRITE_TIMEOUT_MS,
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

  // The probe above degrades an unreachable ConfigDB to a warning. A deployment that set
  // IVANTI_IMPERSONATION_REQUIRED has said that running as the service account is not acceptable.
  if (ivanti !== undefined) {
    const problems = requiredImpersonationProblems(config, ivanti.capability);
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

  let stdio: StdioServer | undefined;
  if (config.STDIO_TRANSPORT_ON) {
    // Process trust: whoever can run this binary is the caller, and nothing vouches for who
    // they are. One process is one conversation, so there is no session id either.
    stdio = await startStdio(factory.create({ identity: ANONYMOUS }));
    logger.info('listening on stdio', {
      mcpMode: config.MCP_MODE,
      ivanti: ivanti !== undefined,
      ...factory.manifest,
      tools: factory.toolNames,
    });
  }

  let http: HttpServer | undefined;
  let readiness: Readiness | undefined;
  if (config.HTTP_TRANSPORT_ON) {
    // `enduser` scopes records to one person per MCP session, and a session is whatever the
    // client opened — so a gateway that multiplexes many people onto one connection would show
    // the second person the first person's records. Under `oauth` this cannot happen: every
    // request carries a token and a session belongs to the subject that opened it (`sameSubject`,
    // 403 otherwise). Under `none` and `bearer` there is no per-request principal at all, so the
    // server cannot tell two people apart and the deployment has to.
    if (config.MCP_MODE === 'enduser' && config.AUTH_MODE !== 'oauth') {
      logger.warn(
        'enduser over HTTP without oauth: every person must get their own MCP session — this ' +
          'server cannot tell two callers apart on one',
        { authMode: config.AUTH_MODE },
      );
    }

    let verifier: TokenVerifier | undefined;
    if (config.AUTH_MODE === 'oauth') {
      const setup = await createOAuthSetup(config, undefined, logger);
      verifier = setup.verifier;
      logger.info('oauth resource server ready', {
        issuer: setup.issuer,
        audiences: setup.audiences,
        jwksUri: setup.jwksUri,
      });
    }

    // Only HTTP has anything to route away from, and only a configured tenant can stop answering.
    if (ivanti !== undefined) readiness = startReadiness({ check: () => checkTenant(ivanti), logger });

    // Resolves once the port is bound, and logs `listening on http` then — never before.
    http = await startHttp(config, logger, {
      ...(readiness === undefined ? {} : { readiness }),
      verifier,
      createMcpServer: factory.create,
      serverName: SERVER_NAME,
      serverVersion: SERVER_VERSION,
      sdkVersion: readSdkVersion(),
      listeningFields: {
        ivanti: ivanti !== undefined,
        ...factory.manifest,
        tools: factory.toolNames,
      },
    });
  }

  // Containers are killed, not asked politely, and a stdio client is stopped the same way: close
  // every live conversation — which is what hands each person's Ivanti session back — and only
  // then exit. Bounded, because a shutdown that hangs is indistinguishable from one that crashed
  // and ends in SIGKILL either way. Installed for stdio too: without it SIGTERM killed a stdio-only
  // process outright, with the impersonated session still open on the tenant.
  let stopping = false;
  const shutdown = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { reason });
    readiness?.stop();

    const deadline = setTimeout(() => {
      logger.warn('shutdown timed out; exiting anyway', { afterMs: SHUTDOWN_GRACE_MS });
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    deadline.unref();

    void Promise.all([stdio?.close(), http?.close()]).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('shutdown failed', { error });
        process.exit(0);
      },
    );
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  // The stdio client going away is the end of this process's work — unless HTTP is serving
  // others, where a container's empty stdin ends at once and means nothing. The conversation is
  // closed either way; `ended` settles only after its Ivanti session has been handed back.
  if (stdio !== undefined) {
    void stdio.ended.then(() => {
      if (config.HTTP_TRANSPORT_ON) {
        logger.debug('stdio input ended; still serving http');
        return;
      }
      shutdown('stdin ended');
    });
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  // Already logged by `startHttp`, with what to change; a stack would only bury it.
  if (error instanceof ListenError) process.exit(1);
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
