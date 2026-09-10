import { createServer as createHttpServer, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  buildProtectedResourceMetadata,
  metadataPaths,
  metadataUrl,
} from '../auth/oauth/protected-resource-metadata.js';
import type { TokenVerifier } from '../auth/oauth/verify-token.js';
import type { Config } from '../config/env-schema.js';
import type { Logger } from '../logger.js';
import { authorizeRequest } from './http/authorize-request.js';
import { readJsonBody } from './http/read-body.js';
import { SessionStore } from './http/session-store.js';
import { isOriginAllowed } from './http/validate-origin.js';

const MCP_PATH = '/mcp';
const HEALTH_PATH = '/health';
const SWEEP_INTERVAL_MS = 30_000;

export interface HttpDeps {
  verifier?: TokenVerifier;
  /** A fresh McpServer per session: `connect()` binds one transport at a time. */
  createMcpServer: () => McpServer;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function rpcError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { jsonrpc: '2.0', error: { code: -32600, message }, id: null });
}

/**
 * Serves the MCP endpoint, an unauthenticated health probe, and the OAuth metadata document.
 *
 * Sessions are routed by `Mcp-Session-Id` to their own transport. A single shared transport
 * cannot work in stateful mode: one instance holds one session id, so the second client to
 * call `initialize` is rejected with "Server already initialized".
 */
export function startHttp(config: Config, logger: Logger, deps: HttpDeps): Server {
  const sessions = new SessionStore<Session>({
    maxSessions: config.MCP_MAX_SESSIONS,
    idleTtlMs: config.MCP_SESSION_IDLE_TTL_SECONDS * 1000,
  });

  const publicUrl = config.MCP_PUBLIC_URL;
  const oauthPaths = publicUrl !== undefined ? new Set(metadataPaths(publicUrl)) : new Set<string>();
  const resourceMetadataUrl = publicUrl !== undefined ? metadataUrl(publicUrl) : undefined;

  const closeSession = (id: string, session: Session, reason: string): void => {
    logger.debug('closing session', { sessionId: id, reason });
    void session.transport.close();
  };

  const createSession = (): Session => {
    const mcpServer = deps.createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: (): string => crypto.randomUUID(),
      onsessioninitialized: (sessionId: string): void => {
        if (!sessions.set(sessionId, { transport, server: mcpServer })) {
          logger.warn('session cap reached, dropping new session', { sessionId });
          void transport.close();
          return;
        }
        logger.info('session opened', { sessionId, sessions: sessions.size });
      },
      onsessionclosed: (sessionId: string): void => {
        sessions.delete(sessionId);
        logger.info('session closed', { sessionId, sessions: sessions.size });
      },
    });

    return { transport, server: mcpServer };
  };

  const http = createHttpServer((request, response): void => {
    void (async (): Promise<void> => {
      const path = (request.url ?? '').split('?')[0] ?? '';

      // Unauthenticated on purpose: probes must work before auth is configured.
      if (path === HEALTH_PATH) {
        sendJson(response, 200, { status: 'ok', sessions: sessions.size });
        return;
      }

      // Also unauthenticated on purpose: this document is how a client discovers *how* to
      // authenticate, so requiring a token to read it would be circular.
      if (oauthPaths.has(path) && config.AUTH_MODE === 'oauth' && config.OAUTH_ISSUER !== undefined) {
        sendJson(
          response,
          200,
          buildProtectedResourceMetadata({
            resource: publicUrl ?? '',
            issuer: config.OAUTH_ISSUER,
            scopesSupported: config.OAUTH_SCOPES_SUPPORTED,
            resourceName: 'Ivanti MCP',
          }),
        );
        return;
      }

      if (path !== MCP_PATH) {
        sendJson(response, 404, { error: 'not_found' });
        return;
      }

      if (!isOriginAllowed(request.headers.origin, config.TRUSTED_ORIGINS)) {
        logger.warn('rejected request with untrusted origin', { origin: request.headers.origin });
        sendJson(response, 403, { error: 'forbidden_origin' });
        return;
      }

      const authorization = await authorizeRequest(
        config,
        { authorization: request.headers.authorization },
        { verifier: deps.verifier, resourceMetadataUrl },
      );

      if (!authorization.authorized) {
        logger.warn('rejected unauthorized request', { reason: authorization.reason });
        if (authorization.challenge !== undefined) {
          response.setHeader('WWW-Authenticate', authorization.challenge);
        }
        sendJson(response, authorization.status, { error: 'unauthorized' });
        return;
      }

      const header = request.headers['mcp-session-id'];
      const sessionId = Array.isArray(header) ? header[0] : header;

      // GET (SSE stream) and DELETE (end session) always address an existing session.
      if (request.method !== 'POST') {
        if (sessionId === undefined) {
          rpcError(response, 400, 'Mcp-Session-Id header is required');
          return;
        }
        const existing = sessions.get(sessionId);
        if (existing === undefined) {
          rpcError(response, 404, 'Unknown or expired session');
          return;
        }
        await existing.transport.handleRequest(request, response);
        return;
      }

      const parsed = await readJsonBody(request);
      if (!parsed.ok) {
        rpcError(response, parsed.status, parsed.message);
        return;
      }

      if (sessionId !== undefined) {
        const existing = sessions.get(sessionId);
        if (existing === undefined) {
          rpcError(response, 404, 'Unknown or expired session');
          return;
        }
        await existing.transport.handleRequest(request, response, parsed.body);
        return;
      }

      if (!isInitializeRequest(parsed.body)) {
        rpcError(response, 400, 'Mcp-Session-Id header is required for non-initialize requests');
        return;
      }

      if (sessions.size >= config.MCP_MAX_SESSIONS) {
        // An expired-but-unswept session still occupies a slot, and the sweep only runs on a
        // timer. Sweep before refusing so nobody is turned away for sessions already dead.
        for (const { id, value } of sessions.sweep()) closeSession(id, value, 'idle');
      }

      if (sessions.size >= config.MCP_MAX_SESSIONS) {
        logger.warn('refusing new session, cap reached', { cap: config.MCP_MAX_SESSIONS });
        rpcError(response, 503, 'Too many active sessions');
        return;
      }

      const session = createSession();
      await session.server.connect(session.transport);
      await session.transport.handleRequest(request, response, parsed.body);
    })().catch((error: unknown) => {
      logger.error('request handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) sendJson(response, 500, { error: 'internal_error' });
    });
  });

  const sweep = setInterval(() => {
    for (const { id, value } of sessions.sweep()) closeSession(id, value, 'idle');
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  http.on('close', () => {
    clearInterval(sweep);
    for (const { id, value } of sessions.drain()) closeSession(id, value, 'shutdown');
  });

  http.listen(config.MCP_PORT, config.MCP_BIND);
  return http;
}
