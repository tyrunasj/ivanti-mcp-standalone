// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from './session-store.js';

let clock = 1_000;
const now = (): number => clock;

const store = (maxSessions = 3, idleTtlMs = 100): SessionStore<string> =>
  new SessionStore<string>({ maxSessions, idleTtlMs, now });

beforeEach(() => {
  clock = 1_000;
});

describe('SessionStore', () => {
  it('stores and returns a session', () => {
    const sessions = store();
    sessions.set('a', 'transport-a');

    expect(sessions.get('a')).toBe('transport-a');
    expect(sessions.size).toBe(1);
  });

  it('returns undefined for an unknown session', () => {
    expect(store().get('nope')).toBeUndefined();
  });

  it('refuses a new session once the cap is reached', () => {
    const sessions = store(2);

    expect(sessions.set('a', 'x')).toBe(true);
    expect(sessions.set('b', 'y')).toBe(true);
    expect(sessions.set('c', 'z')).toBe(false);
    expect(sessions.size).toBe(2);
  });

  it('still allows replacing an existing session at the cap', () => {
    const sessions = store(1);
    sessions.set('a', 'x');

    expect(sessions.set('a', 'x2')).toBe(true);
    expect(sessions.get('a')).toBe('x2');
  });

  it('sweeps sessions idle beyond the TTL', () => {
    const sessions = store(3, 100);
    sessions.set('a', 'x');

    clock += 101;

    expect(sessions.sweep()).toEqual([{ id: 'a', value: 'x' }]);
    expect(sessions.size).toBe(0);
  });

  it('keeps a session that was used recently', () => {
    const sessions = store(3, 100);
    sessions.set('a', 'x');

    clock += 80;
    sessions.get('a'); // touch
    clock += 80;

    expect(sessions.sweep()).toEqual([]);
    expect(sessions.size).toBe(1);
  });

  it('deletes a session and hands back its value for cleanup', () => {
    const sessions = store();
    sessions.set('a', 'x');

    expect(sessions.delete('a')).toBe('x');
    expect(sessions.has('a')).toBe(false);
  });

  // Initializes still in flight hold slots too, or a burst of them overshoots the cap.
  it('counts reserved slots against the cap', () => {
    const sessions = store(2);

    expect(sessions.reserve()).toBe(true);
    expect(sessions.set('a', 'x')).toBe(true);
    expect(sessions.reserve()).toBe(false);
    expect(sessions.set('b', 'y')).toBe(false);

    sessions.unreserve();
    expect(sessions.set('b', 'y')).toBe(true);
  });

  it('counts a subject\'s sessions and reservations together', () => {
    const sessions = store(5);
    sessions.set('a', 'x', 'alice');
    sessions.set('b', 'y', 'bob');
    sessions.reserve('alice');

    expect(sessions.countFor('alice')).toBe(2);
    sessions.unreserve('alice');
    expect(sessions.countFor('alice')).toBe(1);
  });

  it('finds the least recently seen session that qualifies', () => {
    const sessions = store(5);
    sessions.set('old', 'x');
    clock += 10;
    sessions.set('busy', 'y');
    sessions.begin('busy');
    clock += 10;
    sessions.set('new', 'z');

    expect(sessions.leastRecentlySeen(() => true)?.id).toBe('old');
    expect(sessions.leastRecentlySeen((s) => s.id !== 'old')?.id).toBe('busy');
    expect(sessions.leastRecentlySeen((s) => s.id !== 'old' && s.inFlight === 0)?.id).toBe('new');
  });

  it('treats the end of a request as use', () => {
    const sessions = store(5);
    sessions.set('a', 'x');
    sessions.begin('a');
    clock += 500;
    sessions.end('a');

    expect(sessions.leastRecentlySeen(() => true)?.idleMs).toBe(0);
  });

  it('says how long until some session has been quiet for the floor', () => {
    const sessions = store(5);
    sessions.set('a', 'x');
    clock += 400;
    sessions.set('b', 'y');
    sessions.begin('b');

    expect(sessions.msUntilIdleFor(1_000)).toBe(600);
    // With nothing registered only reservations hold slots, and those settle at once.
    expect(store(5).msUntilIdleFor(1_000)).toBe(0);
  });

  it('drains everything for shutdown', () => {
    const sessions = store();
    sessions.set('a', 'x');
    sessions.set('b', 'y');

    expect(sessions.drain()).toHaveLength(2);
    expect(sessions.size).toBe(0);
  });
});
