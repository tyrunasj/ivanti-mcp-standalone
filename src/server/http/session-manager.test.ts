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
  close: ReturnType<typeof vi.fn<() => void>>;
}

const session = (): FakeSession => ({ close: vi.fn<() => void>() });

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

  it('closes everything on shutdown', () => {
    const m = manager(5);
    const a = session();
    const b = session();
    m.register('a', a);
    m.register('b', b);

    m.closeAll();

    expect(a.close).toHaveBeenCalled();
    expect(b.close).toHaveBeenCalled();
    expect(m.size).toBe(0);
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
