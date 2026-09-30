// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger } from '../../logger.js';
import { FAILURES_BEFORE_NOT_READY, startReadiness, type Readiness } from './readiness.js';

const recorder = (): { logger: Logger; warn: Mock; info: Mock } => {
  const warn = vi.fn();
  const info = vi.fn();
  return { logger: { debug: vi.fn(), info, warn, error: vi.fn() }, warn, info };
};
const logger = (): Logger => recorder().logger;

let started: Readiness[] = [];
const start = (...args: Parameters<typeof startReadiness>): Readiness => {
  const readiness = startReadiness(...args);
  started.push(readiness);
  return readiness;
};

afterEach(() => {
  for (const readiness of started) readiness.stop();
  started = [];
});

describe('startReadiness', () => {
  // Created after startup already reached the tenant: saying no first would only delay traffic.
  it('starts ready, before any check has run', () => {
    const readiness = start({ check: () => Promise.resolve(), logger: logger() });

    expect(readiness.state()).toEqual({ ready: true });
  });

  it('stays ready through one failed check — a slow answer as often as an outage', async () => {
    const readiness = start({ check: () => Promise.reject(new Error('Ivanti GET 503')), logger: logger() });

    await readiness.checkNow();

    expect(readiness.state()).toMatchObject({ ready: true, reason: 'Ivanti GET 503' });
  });

  it('turns not ready after failures in a row, says so once, and recovers on the first success', async () => {
    const { logger: log, warn, info } = recorder();
    let answering = false;
    const readiness = start({
      check: () => (answering ? Promise.resolve() : Promise.reject(new Error('Ivanti GET did not complete'))),
      logger: log,
      now: () => new Date('2026-09-30T08:00:00Z'),
    });

    for (let i = 0; i < FAILURES_BEFORE_NOT_READY + 1; i += 1) await readiness.checkNow();

    expect(readiness.state()).toEqual({
      ready: false,
      reason: 'Ivanti GET did not complete',
      checkedAt: '2026-09-30T08:00:00.000Z',
    });
    expect(warn).toHaveBeenCalledTimes(1);

    answering = true;
    await readiness.checkNow();

    expect(readiness.state()).toEqual({ ready: true, checkedAt: '2026-09-30T08:00:00.000Z' });
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('joins a check still running rather than starting a second', async () => {
    let release: () => void = () => undefined;
    const check = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const readiness = start({ check, logger: logger() });

    const first = readiness.checkNow();
    const second = readiness.checkNow();
    release();
    await Promise.all([first, second]);

    expect(check).toHaveBeenCalledTimes(1);
  });

  it('checks on its own, at the interval it was given', async () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn(() => Promise.resolve());
      start({ check, logger: logger(), intervalMs: 1_000 });

      await vi.advanceTimersByTimeAsync(3_000);

      expect(check).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
