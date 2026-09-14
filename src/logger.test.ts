// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

const collect = (): { lines: string[]; sink: (line: string) => void } => {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
};

describe('createLogger', () => {
  it('emits structured JSON containing level and message', () => {
    const { lines, sink } = collect();

    createLogger('info', sink).info('server started', { port: 3000 });

    expect(JSON.parse(lines[0] ?? '')).toEqual({
      level: 'info',
      message: 'server started',
      port: 3000,
    });
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
});
