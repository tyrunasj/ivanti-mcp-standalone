// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import { SessionManager } from './session-manager.js';

const spyLogger = (): { logger: Logger; warn: ReturnType<typeof vi.fn> } => {
  const warn = vi.fn();
  return { logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }, warn };
};

const silent = (): Logger => spyLogger().logger;

let clock = 1_000;
interface FakeSession {
  // `void | Promise<void>`, as `ClosableSession` declares it: closing an MCP session releases the
  // person's Ivanti session, which is asynchronous, and shutdown has to be able to wait for it.
  close: ReturnType<typeof vi.fn<() => void | Promise<void>>>;
}

const session = (): FakeSession => ({ close: vi.fn<() => void | Promise<void>>() });

const manager = (maxSessions = 2, idleTtlMs = 100, logger: Logger = silent()) =>
  new SessionManager<FakeSession>({
    maxSessions,
    idleTtlMs,
    logger,
    now: () => clock,
  });

beforeEach(() => {
  clock = 1_000;
});

describe('SessionManager', () => {
  it('registers and returns a session', () => {
    const m = manager();
    const s = session();

    expect(m.register('a', s)).toBe(true);
    expect(m.get('a')).toBe(s);
    expect(m.size).toBe(1);
  });

  it('closes a session it cannot accept, rather than dropping it on the floor', () => {
    const m = manager(1);
    m.register('a', session());
    const rejected = session();

    expect(m.register('b', rejected)).toBe(false);
    expect(rejected.close).toHaveBeenCalled();
  });

  it('admits while below the cap', () => {
    const m = manager(2);
    m.register('a', session());

    expect(m.admit()).toBe(true);
  });

  it('refuses once full and everything is live', () => {
    const m = manager(2);
    m.register('a', session());
    m.register('b', session());

    expect(m.admit()).toBe(false);
  });

  it('sweeps before refusing, so a dead session does not occupy a slot', () => {
    const m = manager(2, 100);
    const stale = session();
    m.register('a', stale);
    m.register('b', session());

    clock += 101; // both now idle beyond the TTL

    expect(m.admit()).toBe(true);
    expect(stale.close).toHaveBeenCalled();
    expect(m.size).toBe(0);
  });

  it('keeps a session that was used recently when sweeping', () => {
    const m = manager(2, 100);
    m.register('a', session());
    m.register('b', session());

    clock += 80;
    m.get('a'); // touch
    clock += 80;

    expect(m.admit()).toBe(true);
    expect(m.size).toBe(1);
    expect(m.get('a')).toBeDefined();
  });

  it('unregisters without closing, since the transport closed itself', () => {
    const m = manager();
    const s = session();
    m.register('a', s);

    m.unregister('a');

    expect(m.size).toBe(0);
    expect(s.close).not.toHaveBeenCalled();
  });

  it('closes everything on shutdown', async () => {
    const m = manager(5);
    const a = session();
    const b = session();
    m.register('a', a);
    m.register('b', b);

    await m.closeAll();

    expect(a.close).toHaveBeenCalled();
    expect(b.close).toHaveBeenCalled();
    expect(m.size).toBe(0);
  });

  /**
   * Closing a session is what releases the person's Ivanti session, so shutdown has to WAIT for
   * it. This used to fire each `close()` and return, which read as tidy and did nothing: the
   * process exited before the release request left the machine.
   */
  it('waits for a close that takes a moment', async () => {
    const m = manager(5);
    let released = false;
    m.register('slow', {
      close: vi.fn<() => void | Promise<void>>(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              released = true;
              resolve();
            }, 5);
          }),
      ),
    });

    await m.closeAll();

    expect(released).toBe(true);
  });

  // One session refusing to close must not strand the others.
  it('closes the rest when one throws', async () => {
    const m = manager(5);
    const good = session();
    m.register('bad', {
      close: vi.fn<() => void | Promise<void>>(() => Promise.reject(new Error('stuck'))),
    });
    m.register('good', good);

    await expect(m.closeAll()).resolves.toBeUndefined();
    expect(good.close).toHaveBeenCalled();
  });

  it('stops sweeping when the returned function is called', () => {
    vi.useFakeTimers();
    const m = manager(5, 100);
    const s = session();
    m.register('a', s);

    const stop = m.startSweeping(10);
    stop();
    clock += 1_000;
    vi.advanceTimersByTime(100);

    expect(s.close).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('logs the cap refusal so it is visible in production', () => {
    const { logger, warn } = spyLogger();
    const m = manager(1, 100, logger);
    m.register('a', session());

    m.admit();

    expect(warn).toHaveBeenCalledWith(
      'refusing new session, cap reached',
      expect.objectContaining({ cap: 1 }),
    );
  });
});
