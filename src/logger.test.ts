// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { IvantiApiError } from './ivanti/http/errors.js';
import { createLogger, withLogContext } from './logger.js';

const collect = (): { lines: string[]; sink: (line: string) => void } => {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
};

const at = new Date('2026-09-28T10:00:00.000Z');
const parsed = (line: string | undefined): Record<string, unknown> =>
  JSON.parse(line ?? '') as Record<string, unknown>;

describe('createLogger', () => {
  it('emits structured JSON with the time, level and message first', () => {
    const { lines, sink } = collect();

    createLogger('info', sink, () => at).info('server started', { port: 3000 });

    expect(lines[0]).toBe(
      '{"time":"2026-09-28T10:00:00.000Z","level":"info","message":"server started","port":3000}',
    );
  });

  it('drops entries below the configured level', () => {
    const { lines, sink } = collect();

    const logger = createLogger('warn', sink);
    logger.debug('noisy');
    logger.info('also noisy');
    logger.warn('kept');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('kept');
  });

  it('keeps entries at or above the configured level', () => {
    const { lines, sink } = collect();

    const logger = createLogger('debug', sink);
    logger.debug('a');
    logger.error('b');

    expect(lines).toHaveLength(2);
  });

  it('never lets a field overwrite the level or the message', () => {
    const { lines, sink } = collect();

    createLogger('info', sink).error('tool failed', { level: 'debug', message: 'fine' });

    expect(parsed(lines[0])).toMatchObject({ level: 'error', message: 'tool failed' });
  });

  it('writes an error field with its message and stack rather than as {}', () => {
    const { lines, sink } = collect();

    createLogger('info', sink).error('tool failed', { error: new TypeError('boom') });

    expect(parsed(lines[0]).error).toMatchObject({
      name: 'TypeError',
      message: 'boom',
      stack: expect.stringContaining('TypeError: boom') as string,
    });
  });

  it('writes an Ivanti error by its path, never the query it was asked', () => {
    const { lines, sink } = collect();
    const error = new IvantiApiError({
      status: 500,
      method: 'GET',
      url: "https://t/HEAT/api/odata/businessobject/Incidents?$filter=Customer eq 'Jane Doe'",
      body: 'Internal error',
    });

    createLogger('info', sink).warn('ivanti call failed', { error });

    expect(parsed(lines[0]).error).toMatchObject({
      status: 500,
      path: '/HEAT/api/odata/businessobject/Incidents',
    });
    expect(lines[0]).not.toContain('Jane Doe');
  });

  it('still logs the message when a field cannot be serialised', () => {
    const { lines, sink } = collect();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => createLogger('info', sink).info('odd', { circular })).not.toThrow();
    expect(parsed(lines[0])).toMatchObject({ message: 'odd', logError: expect.any(String) as string });
  });

  it('stamps every line inside a log context, however deep the call', async () => {
    const { lines, sink } = collect();
    const logger = createLogger('debug', sink);

    await withLogContext({ tool: 'list_records', sessionId: 's1' }, async () => {
      await Promise.resolve();
      logger.debug('ivanti request', { status: 200 });
    });
    logger.debug('outside');

    expect(parsed(lines[0])).toMatchObject({ tool: 'list_records', sessionId: 's1', status: 200 });
    expect(parsed(lines[1])).not.toHaveProperty('tool');
  });
});
