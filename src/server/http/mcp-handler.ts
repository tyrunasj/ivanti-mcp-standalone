import type { IncomingMessage, ServerResponse } from 'node:http';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ANONYMOUS, verifiedIdentity, type CallerIdentity } from '../../auth/identity.js';
import type { Logger } from '../../logger.js';
import type { AuthorizationResult } from './authorize-request.js';
import { describeRpc } from './describe-rpc.js';
import { readJsonBody } from './read-body.js';
import { sendRpcError } from './respond.js';
import type { ClosableSession, SessionManager } from './session-manager.js';

/** Matches the session sweep interval: that is when capacity actually frees up. */
const RETRY_AFTER_SECONDS = 30;

/** The slice of a session this handler needs — narrow enough to fake in a test. */
export interface McpSession extends ClosableSession {
  /** Who this session acts for — fixed when it was created. */
  identity: CallerIdentity;
  transport: {
    sessionId?: string;
    handleRequest: (
      request: IncomingMessage,
      response: ServerResponse,
      body?: unknown,
    ) => Promise<void>;
  };
  connect: () => Promise<void>;
}

export interface McpHandlerDeps<S extends McpSession> {
  sessions: SessionManager<S>;
  logger: Logger;
  /** Builds a session for this identity; registration happens through the transport's callbacks. */
  createSession: (identity: CallerIdentity) => S;
  /**
   * Which token claim names the person, for matching against Ivanti. Absent means the default
   * probe order — `email`, then `preferred_username`, then `upn`.
   */
  directoryClaim?: string;
}

export type McpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  authorization: AuthorizationResult,
) => Promise<void>;

/**
 * Dispatches one request on the MCP endpoint.
 *
 * Separate from `startHttp` because this is MCP protocol dispatch — which session, is this an
 * initialize, is the body well formed — while `startHttp` is HTTP plumbing. They change for
 * different reasons, and only this half is worth testing without a socket.
 */
/**
 * Whether this request's credential belongs to the session it addresses.
 *
 * Only meaningful for verified identities: under `none` and `bearer` every caller is the same
 * anonymous one, so there is nothing to compare and refusing would break the shared-token
 * deployment that mode exists for.
 */
function sameSubject(sessionIdentity: CallerIdentity, authorization: AuthorizationResult): boolean {
  if (sessionIdentity.provenance !== 'verified') return true;
  return authorization.identity?.subject === sessionIdentity.subject;
}

export function createMcpHandler<S extends McpSession>(deps: McpHandlerDeps<S>): McpHandler {
  const { sessions, logger, directoryClaim } = deps;

  /** One place that knows the shape of a request log line. */
  const logExchange = (
    message: string,
    startedAt: number,
    subject: string | undefined,
    fields: Record<string, unknown>,
    durationKey: 'ms' | 'attachedMs' = 'ms',
  ): void => {
    logger.debug(message, { ...fields, subject, [durationKey]: Date.now() - startedAt });
  };

  const sessionIdOf = (request: IncomingMessage): string | undefined => {
    const header = request.headers['mcp-session-id'];
    return Array.isArray(header) ? header[0] : header;
  };

  return async (request, response, authorization): Promise<void> => {
    const subject = authorization.identity?.subject;
    const sessionId = sessionIdOf(request);

    // GET (SSE stream) and DELETE (end session) always address an existing session.
    if (request.method !== 'POST') {
      if (sessionId === undefined) {
        sendRpcError(response, 400, 'Mcp-Session-Id header is required');
        return;
      }
      const existing = sessions.get(sessionId);
      if (existing === undefined) {
        sendRpcError(response, 404, 'Unknown or expired session');
        return;
      }

      // A GET holds the SSE stream open for the life of the connection, so its elapsed time is
      // how long the client stayed attached — not request latency.
      const isStream = request.method === 'GET';
      const startedAt = Date.now();
      if (isStream) logger.debug('mcp stream opened', { sessionId, subject });

      await existing.transport.handleRequest(request, response);

      logExchange(
        isStream ? 'mcp stream closed' : 'mcp request',
        startedAt,
        subject,
        { httpMethod: request.method, sessionId },
        isStream ? 'attachedMs' : 'ms',
      );
      return;
    }

    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      sendRpcError(response, parsed.status, parsed.message);
      return;
    }

    if (sessionId !== undefined) {
      const existing = sessions.get(sessionId);
      if (existing === undefined) {
        sendRpcError(response, 404, 'Unknown or expired session');
        return;
      }
      if (!sameSubject(existing.identity, authorization)) {
        // A session belongs to the identity that opened it. Another verified subject presenting
        // its own valid token is not entitled to this conversation — or to the records it has
        // already been told about.
        logger.warn('session subject mismatch', { sessionId });
        sendRpcError(response, 403, 'This session belongs to another identity');
        return;
      }
      const startedAt = Date.now();
      await existing.transport.handleRequest(request, response, parsed.body);
      logExchange('mcp request', startedAt, subject, { ...describeRpc(parsed.body), sessionId });
      return;
    }

    if (!isInitializeRequest(parsed.body)) {
      sendRpcError(response, 400, 'Mcp-Session-Id header is required for non-initialize requests');
      return;
    }

    if (!sessions.admit()) {
      // 503, not 429. RFC 9110: 503 is "a temporary overload ... which will likely be
      // alleviated after some delay" — which is exactly a global session cap. 429 means "the
      // user has sent too many requests" (RFC 6585), a per-client quota; here a client's very
      // first request can be refused through no fault of its own, and that client backing off
      // frees nothing. If a per-client session quota is ever added, that one is a 429.
      //
      // Retry-After is the part that was missing: a 503 without it tells the client to give up
      // rather than come back. Sessions free up on the sweep, so that interval is the honest
      // hint.
      response.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
      sendRpcError(response, 503, 'Too many active sessions');
      return;
    }

    const session = deps.createSession(
      authorization.identity === undefined
        ? ANONYMOUS
        : verifiedIdentity(authorization.identity, directoryClaim),
    );
    await session.connect();
    const startedAt = Date.now();
    await session.transport.handleRequest(request, response, parsed.body);

    logExchange('mcp request', startedAt, subject, {
      ...describeRpc(parsed.body),
      // `onsessioninitialized` has fired by now, so the id exists — logging "new" here would
      // leave the initialize line unjoinable to the RPCs that follow it.
      sessionId: session.transport.sessionId ?? 'unassigned',
    });
  };
}
