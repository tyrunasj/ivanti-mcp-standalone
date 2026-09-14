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
