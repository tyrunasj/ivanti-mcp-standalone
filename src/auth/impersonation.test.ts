// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { ImpersonatedSession } from '../ivanti/session/impersonated-session.js';
import { createImpersonationSlot } from './impersonation.js';
import { impersonatedSessionFixture } from '../ivanti/session/impersonated-session.fixture.js';

const session = (loginId: string, release = vi.fn(() => Promise.resolve())): ImpersonatedSession =>
  impersonatedSessionFixture({ sid: 'tenant#ABC#1', loginId, release });

describe('createImpersonationSlot', () => {
  it('holds nothing until something opens it', () => {
    expect(createImpersonationSlot(() => Promise.resolve(session('HSanders'))).session()).toBeUndefined();
  });

  it('opens once and hands the same session back', async () => {
    const open = vi.fn(() => Promise.resolve(session('HSanders')));
    const slot = createImpersonationSlot(open);

    const first = await slot.open('HSanders');
    const second = await slot.open('HSanders');

    expect(second).toBe(first);
    expect(slot.session()).toBe(first);
    // A second act_as for the same person must not pay for a handshake, or strand the first.
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('matches the login without regard to case, as Ivanti echoes its own spelling', async () => {
    const open = vi.fn(() => Promise.resolve(session('HSanders')));
    const slot = createImpersonationSlot(open);

    await slot.open('hsanders');
    await slot.open('HSanders');

    expect(open).toHaveBeenCalledTimes(1);
  });

  // The pin refuses a second person first, so this is a backstop against the two disagreeing.
  it('refuses a different person rather than swapping', async () => {
    const slot = createImpersonationSlot((login) => Promise.resolve(session(login)));

    await slot.open('HSanders');

    await expect(slot.open('ACope')).rejects.toThrow(/already acts as HSanders/);
  });

  // A cold conversation firing two tool calls would otherwise open two Ivanti sessions and leak
  // one of them — the same reason the service-account handshake is shared.
  it('shares one handshake between concurrent first calls', async () => {
    const open = vi.fn(
      () => new Promise<ImpersonatedSession>((resolve) => setTimeout(() => { resolve(session('HSanders')); }, 5)),
    );
    const slot = createImpersonationSlot(open);

    const [a, b] = await Promise.all([slot.open('HSanders'), slot.open('HSanders')]);

    expect(a).toBe(b);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('releases what it holds and forgets it', async () => {
    const release = vi.fn(() => Promise.resolve());
    const slot = createImpersonationSlot(() => Promise.resolve(session('HSanders', release)));

    await slot.open('HSanders');
    await slot.release();

    expect(release).toHaveBeenCalledTimes(1);
    expect(slot.session()).toBeUndefined();
  });

  it('is safe to release when nothing is open', async () => {
    const slot = createImpersonationSlot(() => Promise.resolve(session('HSanders')));

    await expect(slot.release()).resolves.toBeUndefined();
  });

  // Teardown is not a place to surface errors: the session expires by itself regardless.
  it('swallows a failing release', async () => {
    const slot = createImpersonationSlot(() =>
      Promise.resolve(session('HSanders', vi.fn(() => Promise.reject(new Error('down'))))),
    );

    await slot.open('HSanders');

    await expect(slot.release()).resolves.toBeUndefined();
  });

  it('can open again after a release', async () => {
    const open = vi.fn((login: string) => Promise.resolve(session(login)));
    const slot = createImpersonationSlot(open);

    await slot.open('HSanders');
    await slot.release();
    await slot.open('ACope');

    expect(open).toHaveBeenCalledTimes(2);
    expect(slot.session()?.loginId).toBe('ACope');
  });
});

/**
 * Two `act_as` calls in flight at once.
 *
 * MCP does not serialise tool calls, and the SDK's `_onrequest` does not await the handler — so a
 * model handed two names, or ticket text asking the conversation to become someone else, can put
 * two opens in flight. The different-person guard sat behind `current !== undefined`, which is
 * only assigned after a handshake RESOLVES, so it could not fire while the first was running, and
 * `pending ??= open(login)` joined the second caller without comparing the login.
 *
 * No data crossed — the pin commits in registration order and refuses the loser — but the slot was
 * left recording the REFUSED person as its owner, after which a later `act_as` for the person who
 * actually is pinned was refused by the slot, naming somebody else.
 */
describe('two opens in flight', () => {
  it('refuses the second login instead of handing it the first person’s session', async () => {
    let release: ((session: ImpersonatedSession) => void) | undefined;
    const opened: string[] = [];
    const slot = createImpersonationSlot((login) => {
      opened.push(login);
      return new Promise<ImpersonatedSession>((resolve) => {
        release = resolve;
      });
    });

    const first = slot.open('ACope');
    const second = slot.open('BReed');

    release?.(impersonatedSessionFixture({ loginId: 'ACope' }));

    await expect(first).resolves.toMatchObject({ loginId: 'ACope' });
    await expect(second).rejects.toThrow(/already acts as ACope/);
    // Only one handshake ran, which is what sharing the pending promise is for.
    expect(opened).toEqual(['ACope']);
  });

  it('still treats a repeat of the same login as a no-op', async () => {
    let release: ((session: ImpersonatedSession) => void) | undefined;
    const opened: string[] = [];
    const slot = createImpersonationSlot((login) => {
      opened.push(login);
      return new Promise<ImpersonatedSession>((resolve) => {
        release = resolve;
      });
    });

    const first = slot.open('ACope');
    const again = slot.open('acope');
    release?.(impersonatedSessionFixture({ loginId: 'ACope' }));

    await expect(first).resolves.toBeDefined();
    await expect(again).resolves.toBeDefined();
    expect(opened).toEqual(['ACope']);
  });

  // A handshake that fails must leave nothing behind: the conversation is not bound to someone it
  // could not open a session as.
  it('lets another login through after a failed handshake', async () => {
    let attempt = 0;
    const slot = createImpersonationSlot((login) => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('Ivanti refused'))
        : Promise.resolve(impersonatedSessionFixture({ loginId: login }));
    });

    await expect(slot.open('ACope')).rejects.toThrow('Ivanti refused');
    await expect(slot.open('BReed')).resolves.toMatchObject({ loginId: 'BReed' });
  });
});

/** A handshake the test lands by hand, and a record of every login the slot opened for. */
function manual() {
  const landings: ((session: ImpersonatedSession) => void)[] = [];
  const opened: string[] = [];
  const slot = createImpersonationSlot((login) => {
    opened.push(login);
    return new Promise<ImpersonatedSession>((resolve) => landings.push(resolve));
  });
  return { slot, opened, land: (index: number, session: ImpersonatedSession) => landings[index]?.(session) };
}

/**
 * A conversation that ends while `act_as` is still opening a session.
 *
 * A stdio re-initialize or an idle expiry ended it with nobody pinned yet, so nothing was released;
 * the handshake then landed and stored the first person's session in the NEXT conversation's slot,
 * where every `act_as` for anyone else was refused — naming someone that conversation had never
 * heard of — until the process restarted. And `release` left the handshake pending, so a later
 * `open` for someone else could join it and be handed the first person's session.
 */
describe('a handshake that outlives its conversation', () => {
  it('is given back when it lands, not kept', async () => {
    const { slot, land } = manual();
    const release = vi.fn(() => Promise.resolve());

    const first = slot.open('ACope');
    const released = slot.release();
    land(0, session('ACope', release));

    await expect(first).rejects.toThrow(/conversation ended/);
    await released;
    expect(release).toHaveBeenCalledTimes(1);
    expect(slot.session()).toBeUndefined();
  });

  it('does not bind the next conversation to the person it was opened for', async () => {
    const { slot, land, opened } = manual();

    const first = slot.open('ACope');
    const released = slot.release();
    land(0, session('ACope'));
    await first.catch(() => undefined);
    await released;

    const next = slot.open('BReed');
    land(1, session('BReed'));

    await expect(next).resolves.toMatchObject({ loginId: 'BReed' });
    expect(opened).toEqual(['ACope', 'BReed']);
  });

  it('is never joined by an open for someone else after the release', async () => {
    const { slot, land, opened } = manual();

    const first = slot.open('ACope');
    void slot.release();
    // Still in flight. The next person gets a handshake of their own, not this one.
    const next = slot.open('BReed');
    land(0, session('ACope'));
    land(1, session('BReed'));

    await expect(first).rejects.toThrow(/conversation ended/);
    await expect(next).resolves.toMatchObject({ loginId: 'BReed' });
    expect(opened).toEqual(['ACope', 'BReed']);
    expect(slot.session()?.loginId).toBe('BReed');
  });

  // Shutdown waits on `release`; it must not resolve before the in-flight session is given back.
  it('releases only once the in-flight session has been given back', async () => {
    const { slot, land } = manual();
    let givenBack = false;
    const release = vi.fn(() => {
      givenBack = true;
      return Promise.resolve();
    });

    const first = slot.open('ACope');
    const released = slot.release();
    setTimeout(() => {
      land(0, session('ACope', release));
    }, 5);
    await released;

    expect(givenBack).toBe(true);
    await first.catch(() => undefined);
  });
});

/**
 * A session Ivanti has stopped honouring.
 *
 * `open` handed back the cached session however dead it was, so a conversation whose session
 * expired or was evicted answered every later call with a 401 — and a repeated `act_as` for the
 * same person handed the dead one back again.
 */
describe('a dead session', () => {
  it('is replaced once Ivanti has refused it', async () => {
    const release = vi.fn(() => Promise.resolve());
    const sessions = [session('HSanders', release), session('HSanders')];
    const open = vi.fn(() => Promise.resolve(sessions.shift() ?? session('HSanders')));
    const slot = createImpersonationSlot(open);

    const dead = await slot.open('HSanders');
    slot.discard(dead);
    const fresh = await slot.open('HSanders');

    expect(fresh).not.toBe(dead);
    expect(open).toHaveBeenCalledTimes(2);
    // The documented teardown still runs for the one replaced.
    expect(release).toHaveBeenCalledTimes(1);
  });

  // A call that started on the old session can report its 401 after the new one is open.
  it('ignores a late refusal of a session already replaced', async () => {
    const open = vi.fn(() => Promise.resolve(session('HSanders')));
    const slot = createImpersonationSlot(open);

    const dead = await slot.open('HSanders');
    slot.discard(dead);
    const fresh = await slot.open('HSanders');
    slot.discard(dead);

    expect(await slot.open('HSanders')).toBe(fresh);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('is replaced by one handshake however many calls notice together', async () => {
    const open = vi.fn(
      () => new Promise<ImpersonatedSession>((resolve) => setTimeout(() => { resolve(session('HSanders')); }, 5)),
    );
    const slot = createImpersonationSlot(open);
    const dead = await slot.open('HSanders');
    slot.discard(dead);

    const [a, b] = await Promise.all([slot.open('HSanders'), slot.open('HSanders')]);

    expect(a).toBe(b);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('is replaced once it is past the expiry CentralConfig gave it', async () => {
    vi.useFakeTimers();
    try {
      const expiring = (): ImpersonatedSession =>
        impersonatedSessionFixture({ expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
      const open = vi.fn(() => Promise.resolve(expiring()));
      const slot = createImpersonationSlot(open);

      const first = await slot.open('HSanders');
      vi.advanceTimersByTime(5 * 60_000);
      expect(await slot.open('HSanders')).toBe(first);

      vi.advanceTimersByTime(5 * 60_000);
      expect(await slot.open('HSanders')).not.toBe(first);
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // The timestamp carries no zone. Read in the wrong one, every fresh session would look expired
  // and every call would open another.
  it('disregards an expiry that had already passed when the session was handed over', async () => {
    const open = vi.fn(() =>
      Promise.resolve(impersonatedSessionFixture({ expiresAt: '2000-01-01T00:00:00' })),
    );
    const slot = createImpersonationSlot(open);

    const first = await slot.open('HSanders');

    expect(await slot.open('HSanders')).toBe(first);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
