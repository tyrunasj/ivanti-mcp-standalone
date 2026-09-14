// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../auth/identity.js';
import { createImpersonationSlot } from '../../auth/impersonation.js';
import type { IvantiTransport } from '../../ivanti/http/transport.js';
import type { ImpersonatedSession } from '../../ivanti/session/impersonated-session.js';
import type { CallContext } from '../tool-definition.js';
import { transportFor } from './transport-for.js';
import { impersonatedSessionFixture } from '../../ivanti/session/impersonated-session.fixture.js';

const session = (sid: string): ImpersonatedSession => impersonatedSessionFixture({ sid });

const base = (asPerson = vi.fn()): IvantiTransport => ({ asPerson }) as unknown as IvantiTransport;

describe('transportFor', () => {
  // The ordinary deployment: no ConfigDB pair, so nothing about the request path changes.
  it('returns the service-account transport when nothing is impersonated', () => {
    const transport = base();

    expect(transportFor(transport, { identity: ANONYMOUS })).toBe(transport);
  });

  it('returns it unchanged when a slot exists but no session is open', async () => {
    const transport = base();
    const slot = createImpersonationSlot(() => Promise.resolve(session('tenant#A#1')));
    const context: CallContext = { identity: ANONYMOUS, impersonation: slot };

    expect(transportFor(transport, context)).toBe(transport);
    // Sanity: it does change once one is open.
    await slot.open('HSanders');
    expect(transportFor(transport, context)).not.toBe(transport);
  });

  it('swaps in a transport bound to the session SID', async () => {
    const scoped = base();
    const asPerson = vi.fn(() => scoped);
    const transport = base(asPerson);
    const slot = createImpersonationSlot(() => Promise.resolve(session('tenant#SID#1')));
    await slot.open('HSanders');

    const result = transportFor(transport, { identity: ANONYMOUS, impersonation: slot });

    expect(result).toBe(scoped);
    expect(asPerson).toHaveBeenCalledWith('tenant#SID#1');
  });

  // Per session, not per call: a conversation makes many requests and each must not build one.
  it('builds the impersonated transport once per session', async () => {
    const asPerson = vi.fn(() => base());
    const transport = base(asPerson);
    const slot = createImpersonationSlot(() => Promise.resolve(session('tenant#SID#1')));
    await slot.open('HSanders');
    const context: CallContext = { identity: ANONYMOUS, impersonation: slot };

    transportFor(transport, context);
    transportFor(transport, context);
    transportFor(transport, context);

    expect(asPerson).toHaveBeenCalledTimes(1);
  });

  it('builds a new one for a different session', async () => {
    const asPerson = vi.fn(() => base());
    const transport = base(asPerson);
    const slot = createImpersonationSlot((login) =>
      Promise.resolve(session(`tenant#${login}#1`)),
    );

    await slot.open('HSanders');
    transportFor(transport, { identity: ANONYMOUS, impersonation: slot });
    await slot.release();
    await slot.open('ACope');
    transportFor(transport, { identity: ANONYMOUS, impersonation: slot });

    expect(asPerson).toHaveBeenCalledTimes(2);
    expect(asPerson).toHaveBeenLastCalledWith('tenant#ACope#1');
  });
});
