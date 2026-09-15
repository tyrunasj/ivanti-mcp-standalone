// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
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
    const seen: { headers: Record<string, string>; body?: string | FormData }[] = [];
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

  /**
   * Reading the body is still the request.
   *
   * The `try` used to close before `response.text()`, so a timeout, a socket reset
   * (`TypeError: terminated`), a proxy dropping a long transfer or a decompression failure all
   * threw a RAW error instead of an `IvantiApiError`. That mattered two layers up: the metadata
   * catalog evicts a cached failure only for an `IvantiApiError`, so an interrupted body read
   * poisoned that URL's schema for the life of the process — and `$metadata` is the largest
   * document this server fetches, which is where a mid-body failure is likeliest.
   */
  it('wraps a failure that happens while reading the body', async () => {
    const t = transport(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.reject(new TypeError('terminated')),
      } as unknown as Response),
    );

    await expect(t.request(t.routes.entitySet('Incidents'))).rejects.toMatchObject({
      name: 'IvantiApiError',
      status: 0,
    });
  });

  it('scrubs the api key out of a body-read failure too', async () => {
    const t = transport(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.reject(new Error('socket hung up on super-secret-key')),
      } as unknown as Response),
    );

    const error = await t.request(t.routes.entitySet('Incidents')).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(IvantiApiError);
    expect((error as IvantiApiError).body).not.toContain('super-secret-key');
  });
});


/**
 * `asPerson` has to mean the same thing on every method.
 *
 * `requestBinary` is the only one that does not go through `send`, so it never saw the
 * one-credential-or-the-other branch and always sent the tenant API key — fetching the file bytes
 * as the service account while the row read and the DELETE of that same attachment used the
 * person's SID. Nothing tested the SID branch at any level: `connection.fixture` replaces the
 * whole transport, so no tool test could have seen it either.
 */
describe('which credential each method sends', () => {
  /** Records the headers of every request a transport makes. */
  function recording() {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = ((url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, headers: init?.headers ?? {} });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"value":[]}'),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
        headers: { get: () => 'application/pdf' },
      } as unknown as Response);
    }) as unknown as FetchLike;
    return { seen, fetchImpl };
  }

  it('sends the API key and no cookie when nobody is impersonated', async () => {
    const { seen, fetchImpl } = recording();
    const t = transport(fetchImpl);

    await t.requestBinary('https://t/HEAT/api/rest/Attachment?ID=a1');

    expect(seen[0]?.headers['Authorization']).toContain('rest_api_key=');
    expect(seen[0]?.headers['Cookie']).toBeUndefined();
  });

  it('sends the SID and no API key on an impersonated transport', async () => {
    const { seen, fetchImpl } = recording();
    const t = transport(fetchImpl).asPerson('tenant#SID123#1');

    await t.requestBinary('https://t/HEAT/api/rest/Attachment?ID=a1');

    expect(seen[0]?.headers['Cookie']).toBe('SID=tenant#SID123#1');
    expect(seen[0]?.headers['Authorization']).toBeUndefined();
  });

  // The rule the whole file rests on: one credential or the other, never both.
  it('never sends both, on either method', async () => {
    const { seen, fetchImpl } = recording();
    const person = transport(fetchImpl).asPerson('tenant#SID123#1');

    await person.request(person.routes.entitySet('Incidents'));
    await person.requestBinary('https://t/HEAT/api/rest/Attachment?ID=a1');

    for (const { headers } of seen) {
      expect(headers['Authorization'] !== undefined && headers['Cookie'] !== undefined).toBe(false);
    }
  });
});
