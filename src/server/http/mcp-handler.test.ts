import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import type { AuthorizationResult } from './authorize-request.js';
import { createMcpHandler, type McpSession } from './mcp-handler.js';
import { SessionManager } from './session-manager.js';

const silentLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const authorized: AuthorizationResult = {
  authorized: true,
  status: 200,
  identity: { subject: 'user-1', issuer: 'https://id.example', scopes: [], claims: {} },
};

interface FakeSession extends McpSession {
  handled: ReturnType<typeof vi.fn<() => void>>;
}

const fakeSession = (sessionId = 'generated-id'): FakeSession => {
  const handled = vi.fn<() => void>();
  return {
    close: vi.fn<() => void>(),
    connect: () => Promise.resolve(),
    handled,
    transport: {
      sessionId,
      handleRequest: () => {
        handled();
        return Promise.resolve();
      },
    },
  };
};

const request = (
  method: string,
  headers: Record<string, string> = {},
  body?: unknown,
): IncomingMessage => {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, { method, headers, url: '/mcp' }) as unknown as IncomingMessage;
};

interface FakeResponse extends ServerResponse {
  status?: number;
  payload?: string;
  headers: Record<string, string>;
}

const response = (): FakeResponse => {
  const res = {
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    writeHead(status: number) {
      res.status = status;
      return res;
    },
    end(payload?: string) {
      res.payload = payload;
      return res;
    },
    headersSent: false,
  } as unknown as FakeResponse;
  return res;
};

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
};

const setup = (maxSessions = 10) => {
  const logger = silentLogger();
  const sessions = new SessionManager<FakeSession>({ maxSessions, idleTtlMs: 60_000, logger });
  const created: FakeSession[] = [];
  const handler = createMcpHandler<FakeSession>({
    sessions,
    logger,
    createSession: () => {
      const s = fakeSession(`session-${created.length}`);
      created.push(s);
      return s;
    },
  });
  return { handler, sessions, created };
};

describe('createMcpHandler', () => {
  it('opens a session for an initialize with no session header', async () => {
    const { handler, created } = setup();
    const res = response();

    await handler(request('POST', {}, INITIALIZE), res, authorized);

    expect(created).toHaveLength(1);
    expect(created[0]?.handled).toHaveBeenCalled();
  });

  it('refuses a non-initialize POST that carries no session', async () => {
    const { handler } = setup();
    const res = response();

    await handler(request('POST', {}, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), res, authorized);

    expect(res.status).toBe(400);
  });

  it('routes a POST with a known session to that session', async () => {
    const { handler, sessions } = setup();
    const existing = fakeSession('abc');
    sessions.register('abc', existing);

    await handler(
      request('POST', { 'mcp-session-id': 'abc' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      response(),
      authorized,
    );

    expect(existing.handled).toHaveBeenCalled();
  });

  it('answers 404 for an unknown session', async () => {
    const { handler } = setup();
    const res = response();

    await handler(
      request('POST', { 'mcp-session-id': 'gone' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      res,
      authorized,
    );

    expect(res.status).toBe(404);
  });

  it('answers 503 once the session cap is reached, with a Retry-After', async () => {
    const { handler, sessions } = setup(1);
    sessions.register('taken', fakeSession('taken'));
    const res = response();

    await handler(request('POST', {}, INITIALIZE), res, authorized);

    // 503 rather than 429: the cap is global, so this client sent nothing wrong and its
    // backing off frees nothing. Retry-After is what makes it actionable.
    expect(res.status).toBe(503);
    expect(res.headers['Retry-After']).toBe('30');
  });

  it('rejects a malformed body before touching a session', async () => {
    const { handler, created } = setup();
    const res = response();
    const bad = Object.assign(Readable.from([Buffer.from('{not json')]), {
      method: 'POST',
      headers: {},
      url: '/mcp',
    }) as unknown as IncomingMessage;

    await handler(bad, res, authorized);

    expect(res.status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('requires a session header on GET', async () => {
    const { handler } = setup();
    const res = response();

    await handler(request('GET'), res, authorized);

    expect(res.status).toBe(400);
  });

  it('routes a GET to its session as a stream', async () => {
    const { handler, sessions } = setup();
    const existing = fakeSession('abc');
    sessions.register('abc', existing);

    await handler(request('GET', { 'mcp-session-id': 'abc' }), response(), authorized);

    expect(existing.handled).toHaveBeenCalled();
  });

  it('routes a DELETE to its session', async () => {
    const { handler, sessions } = setup();
    const existing = fakeSession('abc');
    sessions.register('abc', existing);

    await handler(request('DELETE', { 'mcp-session-id': 'abc' }), response(), authorized);

    expect(existing.handled).toHaveBeenCalled();
  });
});
