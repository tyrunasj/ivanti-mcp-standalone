// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import { IvantiApiError } from './errors.js';
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
});
