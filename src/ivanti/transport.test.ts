import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger.js';
import { IvantiApiError, isIvantiNotFound } from './errors.js';
import { createTransport, type FetchLike } from './transport.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const reply = (status: number, body: string): Awaited<ReturnType<FetchLike>> => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(body),
});

const transport = (fetchImpl: FetchLike) =>
  createTransport({
    baseUrl: 'https://t',
    basePath: '/HEAT',
    apiKey: 'super-secret-key',
    logger: logger(),
    fetchImpl,
  });

describe('createTransport', () => {
  it('sends the Ivanti Authorization header with an equals sign', async () => {
    const seen: Record<string, string>[] = [];
    const t = transport((_u, init) => {
      seen.push(init.headers);
      return Promise.resolve(reply(200, '{"ok":true}'));
    });

    await t.request(t.routes.entitySet('Incidents'));

    expect(seen[0]?.Authorization).toBe('rest_api_key=super-secret-key');
  });

  it('parses a JSON body', async () => {
    const t = transport(() => Promise.resolve(reply(200, '{"value":[{"RecId":"A"}]}')));

    await expect(t.request('https://t/x')).resolves.toEqual({ value: [{ RecId: 'A' }] });
  });

  it('returns undefined for a 204', async () => {
    const t = transport(() => Promise.resolve(reply(204, '')));

    await expect(t.request('https://t/x')).resolves.toBeUndefined();
  });

  it('treats an empty 200 as absent for request, but an error for requestRequired', async () => {
    // Ivanti answers 200 with an empty body when $select is used on a single record.
    const t = transport(() => Promise.resolve(reply(200, '')));

    await expect(t.request('https://t/x')).resolves.toBeUndefined();
    await expect(t.requestRequired('https://t/x')).rejects.toThrow(/empty body/);
  });

  it('throws a typed error carrying status and body on failure', async () => {
    const t = transport(() => Promise.resolve(reply(400, 'ISM_4000 Invalid key')));

    await expect(t.request('https://t/x')).rejects.toBeInstanceOf(IvantiApiError);
    await t.request('https://t/x').catch((e: IvantiApiError) => {
      expect(e.status).toBe(400);
      expect(isIvantiNotFound(e)).toBe(true);
    });
  });

  it('does not invent a status for a connection failure', async () => {
    const t = transport(() => Promise.reject(new Error('ECONNRESET')));

    await t.request('https://t/x').catch((e: IvantiApiError) => {
      expect(e.status).toBe(0);
      expect(e.message).toMatch(/did not complete/);
    });
  });

  it('rejects a 200 that is not JSON rather than returning garbage', async () => {
    const t = transport(() => Promise.resolve(reply(200, '<html>Sign in</html>')));

    await expect(t.request('https://t/x')).rejects.toThrow(/not JSON/);
  });

  it('serialises a body and sets Content-Type only when there is one', async () => {
    const seen: { headers: Record<string, string>; body?: string }[] = [];
    const t = transport((_u, init) => {
      seen.push({ headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
      return Promise.resolve(reply(200, '{}'));
    });

    await t.request('https://t/x', { method: 'POST', body: { Subject: 'hi' } });
    await t.request('https://t/y');

    expect(seen[0]?.body).toBe('{"Subject":"hi"}');
    expect(seen[0]?.headers['Content-Type']).toBe('application/json');
    expect(seen[1]?.headers['Content-Type']).toBeUndefined();
  });

  it('never lets the API key back out through an error body', async () => {
    // Ivanti echoes submitted values in failures, and the ASMX session sends the key as a body
    // parameter — so this is the realistic path from credential to log line.
    const echoes = transport(() =>
      Promise.resolve(reply(400, '{"message":"bad key super-secret-key in payload"}')),
    );

    await expect(echoes.request('https://t/x')).rejects.toThrow(IvantiApiError);
    await echoes.request('https://t/x').catch((error: unknown) => {
      expect((error as IvantiApiError).body).not.toContain('super-secret-key');
      expect((error as IvantiApiError).body).toContain('[REDACTED-API-KEY]');
    });
  });

  it('scrubs the key from a non-JSON 200 and from a connection failure too', async () => {
    const html = transport(() => Promise.resolve(reply(200, '<html>super-secret-key</html>')));
    await html.request('https://t/x').catch((error: unknown) => {
      expect((error as IvantiApiError).body).not.toContain('super-secret-key');
    });

    const broken = transport(() => Promise.reject(new Error('connect failed: super-secret-key')));
    await broken.request('https://t/x').catch((error: unknown) => {
      expect((error as IvantiApiError).body).not.toContain('super-secret-key');
    });
  });

  it('asks for XML on requestText — JSON turns $metadata into a 500', async () => {
    const seen: Record<string, string>[] = [];
    const t = transport((_u, init) => {
      seen.push(init.headers);
      return Promise.resolve(reply(200, '<edmx:Edmx/>'));
    });

    await t.requestText(t.routes.metadata('incidents'));

    expect(seen[0]?.Accept).toBe('application/xml');
  });

  it('logs the path but never the query, which carries what was searched for', async () => {
    const debugged: { message: string; fields?: Record<string, unknown> }[] = [];
    const t = createTransport({
      baseUrl: 'https://t',
      basePath: '/HEAT',
      apiKey: 'k',
      logger: {
        ...logger(),
        debug: (message, fields) => debugged.push({ message, fields }),
      },
      fetchImpl: () => Promise.resolve(reply(200, '{"value":[]}')),
    });

    await t.request(`${t.routes.entitySet('Incidents')}?$filter=Customer eq 'Jane Doe'`);

    expect(debugged[0]?.fields?.path).toBe('/HEAT/api/odata/businessobject/Incidents');
    expect(debugged[0]?.fields?.status).toBe(200);
    expect(JSON.stringify(debugged)).not.toContain('Jane Doe');
  });

  it('exposes the route builders under the probed base path', () => {
    const t = transport(() => Promise.resolve(reply(200, '{}')));

    expect(t.routes.entitySet('Incidents')).toBe(
      'https://t/HEAT/api/odata/businessobject/Incidents',
    );
  });
});
