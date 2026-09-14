// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { readJsonBody } from './read-body.js';

const request = (body: string): IncomingMessage =>
  Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;

describe('readJsonBody', () => {
  it('parses a JSON body', async () => {
    const result = await readJsonBody(request('{"jsonrpc":"2.0","method":"initialize"}'));

    expect(result).toEqual({ ok: true, body: { jsonrpc: '2.0', method: 'initialize' } });
  });

  it('treats an empty body as undefined rather than an error', async () => {
    const result = await readJsonBody(Readable.from([]) as unknown as IncomingMessage);

    expect(result).toEqual({ ok: true, body: undefined });
  });

  it('rejects malformed JSON with 400', async () => {
    const result = await readJsonBody(request('{not json'));

    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects an oversized body with 413 without buffering it all', async () => {
    const result = await readJsonBody(request('x'.repeat(200)), 100);

    expect(result).toMatchObject({ ok: false, status: 413 });
  });
});
