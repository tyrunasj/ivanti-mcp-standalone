// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import {
  buildProtectedResourceMetadata,
  metadataPaths,
  metadataUrl,
} from '../auth/oauth/protected-resource-metadata.js';
import type { CallerIdentity } from '../auth/identity.js';
import type { TokenVerifier } from '../auth/oauth/verify-token.js';
import type { Config } from '../config/env-schema.js';
import type { Logger } from '../logger.js';
import type { CallContext } from '../tools/tool-definition.js';
import { authorizeRequest, type AuthorizationResult } from './http/authorize-request.js';
import { buildHealth, MINIMAL_HEALTH } from './http/health.js';
import { createMcpHandler, type McpSession } from './http/mcp-handler.js';
import { sendJson } from './http/respond.js';
import { resolveRoute } from './http/resolve-route.js';
import { SessionManager } from './http/session-manager.js';
import { isOriginAllowed } from './http/validate-origin.js';

const SWEEP_INTERVAL_MS = 30_000;

export interface HttpDeps {
  verifier?: TokenVerifier;
  /** A fresh McpServer per session: `connect()` binds one transport at a time. */
  createMcpServer: (context: CallContext) => McpServer;
  serverName: string;
  serverVersion: string;
  /** Resolved once at startup: reading it walks node_modules, and /health is a hot path. */
  sdkVersion: string;
}

interface Session extends McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/**
 * Serves the MCP endpoint, a health probe and the OAuth metadata document.
 *
 * This function is wiring. The decisions live in collaborators that can be tested without a
 * socket: `resolveRoute` for dispatch, `authorizeRequest` for the door, `SessionManager` for
 * admission and expiry, `readJsonBody` and `describeRpc` for the payload.
 */
/**
 * The listener, plus the teardown that has to happen before it stops listening.
 *
 * `close()` is not `http.close()`: that waits for every in-flight response, and the standalone
 * `GET /mcp` SSE stream IS an in-flight response held open for the life of the client — measured
 * at 131 s in notes.md, i.e. the ordinary state rather than an edge. With one client attached the
 * callback and the `'close'` event never fired, so nothing that hung off them ever ran and the
 * process waited for SIGKILL.
 */
export interface HttpServer {
  server: Server;
  /** Closes every session (which releases its Ivanti session), then stops the listener. */
  close: () => Promise<void>;
}

export function startHttp(config: Config, logger: Logger, deps: HttpDeps): HttpServer {
  const sessions = new SessionManager<Session>({
    maxSessions: config.MCP_MAX_SESSIONS,
    idleTtlMs: config.MCP_SESSION_IDLE_TTL_SECONDS * 1000,
    logger,
  });

  const publicUrl = config.MCP_PUBLIC_URL;
  const servesOauthMetadata = config.AUTH_MODE === 'oauth' && config.OAUTH_ISSUER !== undefined;
  const oauthPaths =
    publicUrl !== undefined && servesOauthMetadata
      ? new Set(metadataPaths(publicUrl))
      : new Set<string>();
  const resourceMetadataUrl = publicUrl !== undefined ? metadataUrl(publicUrl) : undefined;

  const authorize = (request: IncomingMessage): Promise<AuthorizationResult> =>
    authorizeRequest(
      config,
      { authorization: request.headers.authorization },
      { verifier: deps.verifier, resourceMetadataUrl },
    );

  const createSession = (identity: CallerIdentity): Session => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: (): string => crypto.randomUUID(),
      onsessioninitialized: (sessionId: string): void => {
        sessions.register(sessionId, session);
      },
      onsessionclosed: (sessionId: string): void => {
        sessions.unregister(sessionId);
      },
    });

    // The identity is fixed when the session is created, which is what "pinned per session"
    // means for the verified path: a later request cannot change who this conversation acts as.
    // The session id is not fixed — it does not exist until `initialize` completes — so it is
    // read when a tool is called rather than captured now.
    const mcpServer = deps.createMcpServer({
      identity,
      get sessionId(): string | undefined {
        return transport.sessionId;
      },
    });

    const session: Session = {
      transport,
      server: mcpServer,
      identity,
      connect: () => mcpServer.connect(transport),
      close: () => void transport.close(),
    };

    return session;
  };

  const handleMcp = createMcpHandler<Session>({
    sessions,
    logger,
    createSession,
    ...(config.OAUTH_IDENTITY_CLAIM === undefined
      ? {}
      : { directoryClaim: config.OAUTH_IDENTITY_CLAIM }),
  });

  const http = createHttpServer((request, response): void => {
    void (async (): Promise<void> => {
      switch (resolveRoute(request.url, oauthPaths)) {
        case 'health': {
          // Always 200, because a liveness probe cannot authenticate — but the detail is gated
          // on the same authorization as everything else. Anonymous callers learn only that
          // the process is alive.
          const permitted = await authorize(request);
          sendJson(
            response,
            200,
            permitted.authorized
              ? buildHealth({
                  name: deps.serverName,
                  version: deps.serverVersion,
                  protocolVersion: LATEST_PROTOCOL_VERSION,
                  sdkVersion: deps.sdkVersion,
                  sessions: () => sessions.size,
                })
              : MINIMAL_HEALTH,
          );
          return;
        }

        case 'oauth-metadata': {
          // Unauthenticated by necessity: this document is how a client discovers *how* to
          // authenticate, so requiring a token to read it would be circular.
          sendJson(
            response,
            200,
            buildProtectedResourceMetadata({
              resource: publicUrl ?? '',
              issuer: config.OAUTH_ISSUER ?? '',
              scopesSupported: config.OAUTH_SCOPES_SUPPORTED,
              resourceName: 'Ivanti MCP',
            }),
          );
          return;
        }

        case 'mcp': {
          if (!isOriginAllowed(request.headers.origin, config.TRUSTED_ORIGINS)) {
            logger.warn('rejected request with untrusted origin', {
              origin: request.headers.origin,
            });
            sendJson(response, 403, { error: 'forbidden_origin' });
            return;
          }

          const authorization = await authorize(request);
          if (!authorization.authorized) {
            logger.warn('rejected unauthorized request', { reason: authorization.reason });
            if (authorization.challenge !== undefined) {
              response.setHeader('WWW-Authenticate', authorization.challenge);
            }
            sendJson(response, authorization.status, { error: 'unauthorized' });
            return;
          }

          await handleMcp(request, response, authorization);
          return;
        }

        default:
          sendJson(response, 404, { error: 'not_found' });
      }
    })().catch((error: unknown) => {
      logger.error('request handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) sendJson(response, 500, { error: 'internal_error' });
    });
  });

  const stopSweeping = sessions.startSweeping(SWEEP_INTERVAL_MS);

  http.listen(config.MCP_PORT, config.MCP_BIND);

  return {
    server: http,
    async close(): Promise<void> {
      // Order matters. Closing the sessions ends their SSE streams, which is what lets
      // `http.close()` finish at all; doing it the other way round waits forever on the stream it
      // is trying to drain. Awaited, because closing a session is what releases the person's
      // Ivanti session and the process must not exit before that request leaves.
      stopSweeping();
      await sessions.closeAll();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      // Anything still holding a socket after that — a client that never read its response — is
      // not worth the grace period.
      http.closeAllConnections();
    },
  };
}
