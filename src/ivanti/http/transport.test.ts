// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import { IvantiApiError, isIvantiNotFound, ResponseTooLargeError } from './errors.js';
import { createTransport, DEFAULT_MAX_BINARY_BYTES, type FetchLike } from './transport.js';

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

  it('names the credential on a 401: the key\'s own account, or the person\'s session', async () => {
    const refused = () => Promise.resolve(reply(401, ''));
    const byKey = await transport(refused).request('https://t/x').catch((e: IvantiApiError) => e);
    const byPerson = await transport(refused)
      .asPerson('tenant#SID#1')
      .request('https://t/x')
      .catch((e: IvantiApiError) => e);

    expect(byKey).toBeInstanceOf(IvantiApiError);
    expect((byKey as IvantiApiError).credential).toBe('service');
    expect((byPerson as IvantiApiError).credential).toBe('person');
  });

  it('scrubs the person\'s SID, not only the key, from what an impersonated call echoes', async () => {
    const t = transport(() => Promise.resolve(reply(500, 'session SID-OF-PERSON failed'))).asPerson(
      'SID-OF-PERSON',
    );

    await t.request('https://t/x').catch((e: IvantiApiError) => {
      expect(e.body).not.toContain('SID-OF-PERSON');
    });
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

/**
 * A create runs the tenant's workflow before it answers, and on workflow-heavy objects that took
 * longer than the one 10 s timeout every request shared. The write was cut off — and very likely
 * applied — and the model, told it had failed, filed it again.
 */
describe('how long a write may take', () => {
  /** Answers after `ms`, unless the request's own signal gives up first. */
  const slow =
    (ms: number): FetchLike =>
    (_url, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(reply(201, '{"RecId":"A"}'));
        }, ms);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal?.reason as Error);
        });
      });

  const quick = (fetchImpl: FetchLike) =>
    createTransport({
      baseUrl: 'https://t',
      basePath: '/HEAT',
      apiKey: 'k',
      logger: logger(),
      fetchImpl,
      timeoutMs: 10,
    });

  it('waits longer for a write than for a read, even when only the read timeout is set', async () => {
    const t = quick(slow(60));

    await expect(t.request('https://t/x', { method: 'POST', body: {} })).resolves.toEqual({
      RecId: 'A',
    });
    await expect(t.request('https://t/x')).rejects.toMatchObject({ status: 0 });
  });

  it('keeps both timeouts on an impersonated transport', async () => {
    const t = quick(slow(60)).asPerson('tenant#SID#1');

    await expect(t.request('https://t/x', { method: 'PATCH', body: {} })).resolves.toBeDefined();
    await expect(t.request('https://t/x')).rejects.toMatchObject({ status: 0 });
  });
});

/**
 * `requestBinary` read the whole body with `arrayBuffer()` before anything looked at its size, so an
 * attachment of any size was held in memory — and again as base64 — to be refused afterwards.
 */
describe('requestBinary never reads past its cap', () => {
  const URL_ = 'https://t/HEAT/api/rest/Attachment?ID=a1';

  /** A body served in 10-byte chunks, recording how many were pulled and whether it was let go. */
  function streamed(chunks: number, contentLength?: number) {
    const state = { pulled: 0, cancelled: false, arrayBufferRead: false };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulled === chunks) {
          controller.close();
          return;
        }
        state.pulled += 1;
        controller.enqueue(new Uint8Array(10).fill(7));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    const fetchImpl: FetchLike = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        arrayBuffer: () => {
          state.arrayBufferRead = true;
          return Promise.resolve(new ArrayBuffer(chunks * 10));
        },
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-length'
              ? (contentLength === undefined ? null : String(contentLength))
              : 'application/pdf',
        },
        body,
      });
    return { state, t: transport(fetchImpl) };
  }

  it('refuses a declared length over the cap without reading the body', async () => {
    const { state, t } = streamed(1000, 10_000);

    await expect(t.requestBinary(URL_, { maxBytes: 100 })).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
    expect(state.pulled).toBeLessThanOrEqual(1);
    expect(state.arrayBufferRead).toBe(false);
    expect(state.cancelled).toBe(true);
  });

  it('stops an undeclared body at the cap, not at its end', async () => {
    const { state, t } = streamed(1000);

    const failure = await t.requestBinary(URL_, { maxBytes: 100 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ResponseTooLargeError);
    expect((failure as ResponseTooLargeError).message).toMatch(/not downloaded/);
    // Eleven chunks is the first that passes 100 bytes; a whole read would have been a thousand.
    expect(state.pulled).toBeLessThan(20);
    expect(state.cancelled).toBe(true);
  });

  it('returns a body within the cap whole', async () => {
    const { t } = streamed(3, 30);

    const { bytes, contentType } = await t.requestBinary(URL_, { maxBytes: 100 });

    expect(bytes.byteLength).toBe(30);
    expect(contentType).toBe('application/pdf');
  });

  it('has a cap even when the caller names none', async () => {
    const { t } = streamed(1, DEFAULT_MAX_BINARY_BYTES + 1);

    await expect(t.requestBinary(URL_)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});
