// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { BodyBudget, readJsonBody } from './read-body.js';

const request = (body: string): IncomingMessage =>
  Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;

/** A body that arrives in `pieces`, from the given socket, and only as the reader asks for it. */
const slowRequest = (pieces: string[], socket: object = {}): IncomingMessage => {
  const stream = Readable.from(pieces.map((piece) => Buffer.from(piece)));
  return Object.assign(stream, { socket }) as unknown as IncomingMessage;
};

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
    // Many small chunks, counted as the reader pulls them: a reader that buffered everything and
    // checked the size afterwards would drain all of them; one that stops pulls a handful.
    let pulled = 0;
    const total = 1_000;
    const source = Readable.from(
      (function* (): Generator<Buffer> {
        for (let index = 0; index < total; index += 1) {
          pulled += 1;
          yield Buffer.from('x'.repeat(10));
        }
      })(),
    ) as unknown as IncomingMessage;

    const result = await readJsonBody(source, 100);

    expect(result).toMatchObject({ ok: false, status: 413 });
    expect(pulled).toBeLessThan(total);
  });

  it('stops at the first chunk past the limit, leaving the rest unread', async () => {
    const pieces = ['x'.repeat(60), 'x'.repeat(60), 'x'.repeat(60)];
    const stream = slowRequest(pieces);

    const result = await readJsonBody(stream, 100);

    expect(result).toMatchObject({ ok: false, status: 413 });
    expect((stream as unknown as Readable).readableFlowing).not.toBe(true);
  });
});

describe('readJsonBody with a budget', () => {
  it('answers 503 once the bodies being buffered would pass the process-wide budget', async () => {
    const budget = new BodyBudget(100, 4);
    expect(budget.charge(80)).toBe(true);

    const result = await readJsonBody(request(`{"a":"${'x'.repeat(40)}"}`), 1_000, budget);

    expect(result).toMatchObject({ ok: false, status: 503, retryAfterSeconds: 1 });
  });

  it('gives the bytes back when the read ends, however it ends', async () => {
    const budget = new BodyBudget(1_000, 4);

    await readJsonBody(request('{"a":1}'), 1_000, budget);
    await readJsonBody(request('{not json'), 1_000, budget);
    await readJsonBody(request('x'.repeat(2_000)), 1_500, budget);

    expect(budget.held).toBe(0);
    expect((await readJsonBody(request('{"a":1}'), 1_000, budget)).ok).toBe(true);
  });

  it('refuses a socket that is already sending its quota, and frees the slot afterwards', async () => {
    const budget = new BodyBudget(1_000_000, 2);
    const socket = {};
    const open = [budget.open(socket), budget.open(socket)];

    expect(await readJsonBody(slowRequest(['{}'], socket), 1_000, budget)).toMatchObject({
      ok: false,
      status: 503,
    });
    // Another socket is not affected.
    expect((await readJsonBody(slowRequest(['{}']), 1_000, budget)).ok).toBe(true);

    open[0]?.();
    expect((await readJsonBody(slowRequest(['{}'], socket), 1_000, budget)).ok).toBe(true);
  });
});
