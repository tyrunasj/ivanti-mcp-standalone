// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import { IvantiApiError, ResponseTooLargeError } from './errors.js';
import { exchange, readText, type FetchLike, type FetchResponse } from './exchange.js';

const reply = (status: number, body: string): FetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(body),
});

const recorder = (): {
  logger: Logger;
  debugged: Record<string, unknown>[];
  info: ReturnType<typeof vi.fn>;
} => {
  const debugged: Record<string, unknown>[] = [];
  const info = vi.fn();
  const logger: Logger = {
    debug: (message, fields) => debugged.push({ message, ...fields }),
    info,
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { logger, debugged, info };
};

const send = (
  fetchImpl: FetchLike,
  logger: Logger,
  init: { method?: string; body?: string | FormData } = {},
): Promise<{ status: number; body: string }> =>
  exchange(
    "https://t/HEAT/api/odata/businessobject/Incidents?$filter=Customer eq 'Jane Doe'&$top=5",
    {
      method: init.method ?? 'GET',
      headers: {},
      ...(init.body === undefined ? {} : { body: init.body }),
    },
    { fetchImpl, logger, timeoutMs: 1_000, secrets: ['super-secret-key'] },
    readText,
  );

describe('exchange', () => {
  it('logs every request at debug with its path and decoded query', async () => {
    const { logger, debugged, info } = recorder();

    await send(() => Promise.resolve(reply(200, '{}')), logger);

    expect(debugged).toEqual([
      expect.objectContaining({
        message: 'ivanti request',
        method: 'GET',
        path: '/HEAT/api/odata/businessobject/Incidents',
        query: { $filter: "Customer eq 'Jane Doe'", $top: '5' },
        status: 200,
        ms: expect.any(Number) as number,
      }),
    ]);
    // The query is for debug only: nothing above it may carry what was searched for.
    expect(info).not.toHaveBeenCalled();
  });

  it('never logs a credential that travels in the query', async () => {
    const { logger, debugged } = recorder();

    await exchange(
      'https://config/CentralConfig.asmx/RemoveSession?sessionId=t%23LIVE-SID%231&tenantId=t&q=super-secret-key',
      { method: 'GET', headers: {} },
      {
        fetchImpl: () => Promise.resolve(reply(200, '')),
        logger,
        timeoutMs: 1_000,
        secrets: ['super-secret-key'],
      },
      readText,
    );

    expect(debugged[0]?.query).toEqual({
      sessionId: '[REDACTED]',
      tenantId: 't',
      q: '[REDACTED-API-KEY]',
    });
    expect(JSON.stringify(debugged)).not.toContain('LIVE-SID');
  });

  it.each([
    ['JSON', JSON.stringify({ Subject: 'Printer on fire', Status: 'Logged' })],
    [
      'form-urlencoded',
      new URLSearchParams({ Subject: 'Printer on fire', Status: 'Logged' }).toString(),
    ],
  ])('logs a %s write by its field names, never its values', async (_kind, body) => {
    const { logger, debugged } = recorder();

    await send(() => Promise.resolve(reply(201, '{}')), logger, { method: 'POST', body });

    expect(debugged[0]?.fields).toEqual(['Subject', 'Status']);
    expect(JSON.stringify(debugged)).not.toContain('Printer on fire');
  });

  it('logs a multipart upload by its part names', async () => {
    const { logger, debugged } = recorder();
    const form = new FormData();
    form.append('ObjectId', 'A1');
    form.append('file', new Blob(['secret contents']), 'notes.txt');

    await send(() => Promise.resolve(reply(200, '{}')), logger, { method: 'POST', body: form });

    expect(debugged[0]?.fields).toEqual(['ObjectId', 'file']);
  });

  it('logs a refusal with the body Ivanti sent, scrubbed of the credential', async () => {
    const { logger, debugged } = recorder();

    const failure = await send(
      () => Promise.resolve(reply(400, 'ISM_4000 Invalid key; you sent super-secret-key')),
      logger,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IvantiApiError);
    expect((failure as IvantiApiError).body).not.toContain('super-secret-key');
    expect(debugged).toEqual([
      expect.objectContaining({
        message: 'ivanti request failed',
        status: 400,
        error: 'ISM_4000 Invalid key; you sent [REDACTED-API-KEY]',
      }),
    ]);
  });

  it('logs a request Ivanti never answered, which used to leave no line at all', async () => {
    const { logger, debugged } = recorder();

    const failure = await send(() => Promise.reject(new Error('ECONNRESET')), logger).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(IvantiApiError);
    expect(failure).toMatchObject({ status: 0 });
    expect((failure as IvantiApiError).message).toMatch(/did not complete/);
    expect(debugged).toEqual([
      expect.objectContaining({ message: 'ivanti request failed', status: 0, error: 'ECONNRESET' }),
    ]);
  });

  it('turns a failure mid-body into status 0 rather than a raw error', async () => {
    const { logger } = recorder();
    const broken: FetchResponse = {
      ok: true,
      status: 200,
      text: () => Promise.reject(new TypeError('terminated')),
    };

    await expect(send(() => Promise.resolve(broken), logger)).rejects.toMatchObject({ status: 0 });
  });

  /**
   * Node's fetch rejects every network failure as `TypeError: fetch failed` and keeps the reason in
   * `.cause`. Reporting the message alone made a DNS typo, a firewall and a TLS-intercepting proxy
   * all read "did not complete: fetch failed".
   */
  describe('why nothing came back', () => {
    const networkFailure = (code: string, message: string): TypeError =>
      new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });

    it.each([
      ['ENOTFOUND', 'getaddrinfo ENOTFOUND t.example.com'],
      ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate'],
      ['UND_ERR_SOCKET', 'other side closed'],
    ])('keeps the cause of a network failure (%s)', async (code, message) => {
      const { logger, debugged } = recorder();

      const failure = (await send(
        () => Promise.reject(networkFailure(code, message)),
        logger,
      ).catch((error: unknown) => error)) as IvantiApiError;

      expect(failure.body).toContain(code);
      expect(failure.body).toContain(message);
      expect(failure.code).toBe(code);
      expect(debugged[0]?.error).toContain(code);
    });

    it('names the code of an AggregateError, whose message is empty', async () => {
      const { logger } = recorder();
      const refused = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });

      const failure = (await send(
        () => Promise.reject(new TypeError('fetch failed', { cause: refused })),
        logger,
      ).catch((error: unknown) => error)) as IvantiApiError;

      expect(failure.body).toBe('fetch failed: ECONNREFUSED');
    });

    it('scrubs the cause as it scrubs a body', async () => {
      const { logger } = recorder();

      const failure = (await send(
        () => Promise.reject(networkFailure('ECONNRESET', 'reset while sending super-secret-key')),
        logger,
      ).catch((error: unknown) => error)) as IvantiApiError;

      expect(failure.body).not.toContain('super-secret-key');
    });

    it('says how long it waited, rather than that something was aborted', async () => {
      const { logger } = recorder();

      const failure = (await send(
        () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
        logger,
      ).catch((error: unknown) => error)) as IvantiApiError;

      expect(failure.body).toBe('no answer within 1000 ms');
      expect(failure.code).toBe('TimeoutError');
    });
  });

  /**
   * One timeout for everything either hangs reads or cuts writes off — and a write cut off may well
   * have been applied, which is the costliest way for a request to fail.
   */
  describe('how long it waits', () => {
    /** Answers after `ms`, unless the request's own signal gives up first. */
    const slow =
      (ms: number): FetchLike =>
      (_url, init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(reply(200, '{}'));
          }, ms);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal?.reason as Error);
          });
        });

    const timed = (method: string) =>
      exchange(
        'https://t/HEAT/api/odata/businessobject/Incidents',
        { method, headers: {} },
        { fetchImpl: slow(60), logger: recorder().logger, timeoutMs: 10, writeTimeoutMs: 1_000, secrets: [] },
        readText,
      );

    it('gives a write the write timeout', async () => {
      await expect(timed('POST')).resolves.toMatchObject({ status: 200 });
      await expect(timed('PATCH')).resolves.toMatchObject({ status: 200 });
    });

    it('gives a read the read timeout', async () => {
      await expect(timed('GET')).rejects.toMatchObject({ status: 0, code: 'TimeoutError' });
    });

    it('uses the one timeout for both when no write timeout is given', async () => {
      await expect(
        exchange(
          'https://t/x',
          { method: 'POST', headers: {} },
          { fetchImpl: slow(60), logger: recorder().logger, timeoutMs: 10, secrets: [] },
          readText,
        ),
      ).rejects.toMatchObject({ status: 0 });
    });
  });

  it('passes a body the caller declined to hold through as itself, not as "no answer"', async () => {
    const { logger } = recorder();

    const failure = await exchange(
      'https://t/HEAT/api/rest/Attachment?ID=a1',
      { method: 'GET', headers: {} },
      { fetchImpl: () => Promise.resolve(reply(200, '')), logger, timeoutMs: 1_000, secrets: [] },
      () => Promise.reject(new ResponseTooLargeError('https://t/x', 10, 20)),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ResponseTooLargeError);
  });
});
