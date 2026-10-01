// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import { EVICTION_FLOOR_MS, SessionManager } from './session-manager.js';
import { sample } from '../../metrics/sample.fixture.js';

const spyLogger = (): {
  logger: Logger;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} => {
  const info = vi.fn();
  const warn = vi.fn();
  return { logger: { debug: vi.fn(), info, warn, error: vi.fn() }, info, warn };
};

const silent = (): Logger => spyLogger().logger;

let clock = 1_000;
interface FakeSession {
  // `void | Promise<void>`, as `ClosableSession` declares it: closing an MCP session releases the
  // person's Ivanti session, which is asynchronous, and shutdown has to be able to wait for it.
  close: ReturnType<typeof vi.fn<() => void | Promise<void>>>;
}

const session = (): FakeSession => ({ close: vi.fn<() => void | Promise<void>>() });

const manager = (
  maxSessions = 2,
  idleTtlMs = 100,
  logger: Logger = silent(),
  maxPerSubject?: number,
) =>
  new SessionManager<FakeSession>({
    maxSessions,
    idleTtlMs,
    logger,
    now: () => clock,
    ...(maxPerSubject === undefined ? {} : { maxPerSubject }),
  });

/** A TTL long enough that only eviction, never the sweep, can free a slot. */
const HOUR = 3_600_000;

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

    expect(m.admit().admitted).toBe(true);
  });

  it('refuses once full and everything is live', () => {
    const m = manager(2, HOUR);
    m.register('a', session());
    m.register('b', session());

    expect(m.admit().admitted).toBe(false);
  });

  it('sweeps before refusing, so a dead session does not occupy a slot', () => {
    const m = manager(2, 100);
    const stale = session();
    m.register('a', stale);
    m.register('b', session());

    clock += 101; // both now idle beyond the TTL

    expect(m.admit().admitted).toBe(true);
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

    expect(m.admit().admitted).toBe(true);
    expect(m.size).toBe(1);
    expect(m.get('a')).toBeDefined();
  });

  /**
   * Clients abandon sessions without a DELETE as a matter of course, so a full server is usually
   * full of sessions nobody will use again. Refusing until the thirty-minute TTL swept them turned
   * newcomers away for half an hour while the slots were held by nobody.
   */
  it('closes the least recently used quiet session at the cap, rather than refusing', () => {
    const m = manager(2, HOUR);
    const oldest = session();
    const newer = session();
    m.register('oldest', oldest);
    clock += 1_000;
    m.register('newer', newer);
    clock += EVICTION_FLOOR_MS;

    expect(m.admit().admitted).toBe(true);
    expect(oldest.close).toHaveBeenCalled();
    expect(newer.close).not.toHaveBeenCalled();
    expect(m.get('oldest')).toBeUndefined();
  });

  it('logs an eviction, so a person who lost their session can be told why', () => {
    const { logger, info } = spyLogger();
    const m = manager(1, HOUR, logger);
    m.register('a', session());
    clock += EVICTION_FLOOR_MS;
    const before = sample('ivanti_mcp_sessions_evicted_total');

    m.admit();

    expect(sample('ivanti_mcp_sessions_evicted_total')).toBe(before + 1);
    expect(info).toHaveBeenCalledWith(
      'session evicted',
      expect.objectContaining({ sessionId: 'a', reason: 'cap' }),
    );
  });

  // A session between two tool calls of a live conversation is quiet too; closing it would cost
  // that person their pinned identity to admit someone else.
  it('does not close a session used within the floor, and says when one could be', () => {
    const m = manager(1, HOUR);
    const live = session();
    m.register('live', live);
    clock += EVICTION_FLOOR_MS - 20_000;

    const admission = m.admit();

    expect(admission).toEqual({ admitted: false, retryAfterSeconds: 20 });
    expect(live.close).not.toHaveBeenCalled();
  });

  it('never closes a session with a request in flight, and waits the whole floor after it', () => {
    const m = manager(1, HOUR);
    const busy = session();
    m.register('busy', busy);
    const done = m.busy('busy');
    clock += 10 * EVICTION_FLOOR_MS;

    expect(m.admit()).toEqual({ admitted: false, retryAfterSeconds: EVICTION_FLOOR_MS / 1000 });

    // Finishing counts as use: it is quiet from now, not from when the request began.
    done();
    clock += EVICTION_FLOOR_MS - 1;
    expect(m.admit().admitted).toBe(false);
    clock += 1;
    expect(m.admit().admitted).toBe(true);
    expect(busy.close).toHaveBeenCalled();
  });

  /**
   * `admit()` used to count registered sessions only. A burst of initializes was admitted against
   * one free slot, and every one but the first failed mid-handshake as "Session not found".
   */
  it('reserves the slot it admits, so a second admission cannot take it too', () => {
    const m = manager(1, HOUR);

    const first = m.admit();
    const second = m.admit();

    expect(first.admitted).toBe(true);
    expect(second).toEqual({ admitted: false, retryAfterSeconds: 1 });
  });

  it('registers a committed slot, and ignores a cancel after it', () => {
    const m = manager(1, HOUR);
    const s = session();
    const admission = m.admit();
    if (!admission.admitted) throw new Error('expected admission');

    admission.slot.commit('a', s);

    expect(m.get('a')).toBe(s);
    expect(admission.slot.cancel()).toBe(false);
    expect(m.size).toBe(1);
  });

  it('gives a cancelled slot back', () => {
    const m = manager(1, HOUR);
    const admission = m.admit();
    if (!admission.admitted) throw new Error('expected admission');

    expect(admission.slot.cancel()).toBe(true);
    expect(m.admit().admitted).toBe(true);
  });

  it('records the client on the line that opens a session', () => {
    const { logger, info } = spyLogger();
    const m = manager(1, HOUR, logger);
    const admission = m.admit({ client: { remoteAddress: '10.1.2.3', userAgent: 'curl/8' } });
    if (!admission.admitted) throw new Error('expected admission');

    admission.slot.commit('a', session());

    expect(info).toHaveBeenCalledWith(
      'session opened',
      expect.objectContaining({ sessionId: 'a', remoteAddress: '10.1.2.3', userAgent: 'curl/8' }),
    );
  });

  describe('per subject', () => {
    const open = (m: SessionManager<FakeSession>, id: string, subject?: string): FakeSession => {
      const s = session();
      const admission = m.admit(subject === undefined ? {} : { subject });
      if (!admission.admitted) throw new Error(`expected ${id} to be admitted`);
      admission.slot.commit(id, s);
      return s;
    };

    // The person opening another session has almost always abandoned the last one; refusing them
    // would only lock them out of their own limit.
    it('closes the subject\'s own least recently used session past its limit', () => {
      const m = manager(10, HOUR, silent(), 2);
      const first = open(m, 'first', 'alice');
      clock += 10;
      const second = open(m, 'second', 'alice');
      clock += 10;
      const bobs = open(m, 'bobs', 'bob');
      clock += 10;

      const third = open(m, 'third', 'alice');

      expect(first.close).toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
      expect(bobs.close).not.toHaveBeenCalled();
      expect(third.close).not.toHaveBeenCalled();
      expect(m.size).toBe(3);
    });

    it('prefers one of their sessions that is doing nothing', () => {
      const m = manager(10, HOUR, silent(), 2);
      const streaming = open(m, 'streaming', 'alice');
      m.busy('streaming');
      clock += 10;
      const quiet = open(m, 'quiet', 'alice');
      clock += 10;

      open(m, 'third', 'alice');

      expect(streaming.close).not.toHaveBeenCalled();
      expect(quiet.close).toHaveBeenCalled();
    });

    // Admission counts slots still initializing but cannot close one, so two initializes at the
    // same instant were both admitted and the subject stayed above its limit.
    it('holds to the limit when two of the subject\'s initializes land at the same instant', () => {
      const m = manager(10, HOUR, silent(), 1);
      const first = session();
      const second = session();
      const a = m.admit({ subject: 'alice' });
      const b = m.admit({ subject: 'alice' });
      if (!a.admitted || !b.admitted) throw new Error('expected both to be admitted');

      a.slot.commit('first', first);
      clock += 10;
      b.slot.commit('second', second);

      expect(m.size).toBe(1);
      expect(m.get('second')).toBe(second);
      expect(first.close).toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
    });

    it('does not apply to callers without a subject', () => {
      const m = manager(10, HOUR, silent(), 1);
      const a = open(m, 'a');
      const b = open(m, 'b');

      expect(a.close).not.toHaveBeenCalled();
      expect(b.close).not.toHaveBeenCalled();
      expect(m.size).toBe(2);
    });
  });

  // A client's DELETE ends the session from its side; its close is what releases the person's
  // Ivanti session, and shutdown must not outrun it.
  it('tracks the close of a session that ended itself, and waits for it on shutdown', async () => {
    const m = manager();
    let released = false;
    const s = {
      close: vi.fn<() => void | Promise<void>>(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              released = true;
              resolve();
            }, 5);
          }),
      ),
    };
    m.register('a', s);

    m.unregister('a');
    expect(m.size).toBe(0);
    await m.closeAll();

    expect(s.close).toHaveBeenCalledTimes(1);
    expect(released).toBe(true);
  });

  // An evicted session is out of the store already; its transport closing later is no second close.
  it('does not close an evicted session again when its transport reports the close', () => {
    const m = manager(1, HOUR);
    const s = session();
    m.register('a', s);
    clock += EVICTION_FLOOR_MS;
    m.admit();
    expect(s.close).toHaveBeenCalledTimes(1);

    m.unregister('a');

    expect(s.close).toHaveBeenCalledTimes(1);
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

  // An eviction a moment before SIGTERM started a release that shutdown must not outrun either.
  it('waits on shutdown for a close that eviction started', async () => {
    const m = manager(1, HOUR);
    let released = false;
    m.register('evicted', {
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
    clock += EVICTION_FLOOR_MS;
    m.admit();

    await m.closeAll();

    expect(released).toBe(true);
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
    const m = manager(1, HOUR, logger);
    m.register('a', session());
    const before = sample('ivanti_mcp_sessions_refused_total');

    m.admit();

    expect(sample('ivanti_mcp_sessions_refused_total')).toBe(before + 1);
    expect(warn).toHaveBeenCalledWith(
      'refusing new session, cap reached',
      expect.objectContaining({ cap: 1, retryAfterSeconds: EVICTION_FLOOR_MS / 1000 }),
    );
  });
});
