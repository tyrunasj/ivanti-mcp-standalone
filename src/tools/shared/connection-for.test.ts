// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../auth/identity.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import { createImpersonationSlot } from '../../auth/impersonation.js';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import type { IvantiTransport } from '../../ivanti/http/transport.js';
import { impersonatedSessionFixture } from '../../ivanti/session/impersonated-session.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_ACTIONS } from './action-gate.js';
import { connectionFor } from './connection-for.js';
import type { IvantiToolDeps } from './deps.js';
import { OPEN_GATE } from './object-gate.js';
import type { CallContext } from '../tool-definition.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function deps(): IvantiToolDeps {
  const { connection } = connectionFixture({ entities: { incident: {} } });
  // The fixture's transport refuses `asPerson`; a marked stand-in shows which one a tool got.
  const personal = { marker: 'the person' } as unknown as IvantiTransport;
  const transport = { ...connection.transport, asPerson: vi.fn(() => personal) } as IvantiTransport;
  return {
    connection: { ...connection, transport },
    gate: OPEN_GATE,
    actions: OPEN_ACTIONS,
    logger: logger(),
    ownRecordsOnly: false,
  };
}

async function acting(role = 'ServiceDeskAnalyst') {
  const call = vi.fn(() => Promise.resolve({ Workspaces: [] }));
  const session = impersonatedSessionFixture({ role, call: call as never });
  const slot = createImpersonationSlot(() => Promise.resolve(session));
  await slot.open('HSanders');
  const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS), impersonation: slot };
  return { context, session, call };
}

describe('connectionFor', () => {
  it('is the service account when nobody is impersonated', () => {
    const d = deps();
    const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };

    expect(connectionFor(d, context)).toBe(d.connection);
  });

  // The four members that differ per person — and the ones that must not.
  it('swaps the person-scoped members and passes tenant facts through', async () => {
    const d = deps();
    const { context, session } = await acting();

    const scoped = connectionFor(d, context);

    expect(scoped.session).toBe(session);
    expect((scoped.transport as unknown as { marker: string }).marker).toBe('the person');
    expect(scoped.forms).not.toBe(d.connection.forms);
    expect(scoped.workspaces).not.toBe(d.connection.workspaces);
    // Facts about the tenant, not the person: the same objects the service account uses.
    expect(scoped.metadata).toBe(d.connection.metadata);
    expect(scoped.admin).toBe(d.connection.admin);
    expect(scoped.people).toBe(d.connection.people);
    expect(scoped.capability).toBe(d.connection.capability);
  });

  // A workspace catalog describes a ROLE's Ivanti. Built on the service account's session it
  // would describe the wrong one, so it has to be built on the person's.
  it('builds the workspace catalog on the person\'s session and role', async () => {
    const d = deps();
    const { context, call } = await acting('SelfService');

    await connectionFor(d, context).workspaces.list();

    expect(call).toHaveBeenCalledWith('Services/Workspace.asmx', 'GetRoleWorkspaces', {
      sRole: 'SelfService',
    });
  });

  it('builds the view once per session, not once per call', async () => {
    const d = deps();
    const { context } = await acting();

    expect(connectionFor(d, context)).toBe(connectionFor(d, context));
    expect(d.connection.transport.asPerson).toHaveBeenCalledTimes(1);
  });
});

/**
 * A role switch has to invalidate what the role decided.
 *
 * `switchTo` mutates the role inside the session's own closure and returns the same object, so a
 * memo keyed on the session alone survived it — and `workspaces` and `forms` are both built from
 * the role. Every form-derived answer for the rest of the conversation then described the role the
 * conversation had just left, including a cached `undefined` meaning "no form this role can
 * reach", while `switch_role` reported "what records are visible follows this role, from the next
 * call onwards".
 */
describe('connectionFor follows a role switch', () => {
  /** A session whose role changes the way `switchTo` changes it: in place, same object. */
  async function switchable(role = 'ServiceDeskAnalyst') {
    let current = role;
    const base = impersonatedSessionFixture({
      sid: 'tenant#S#1',
      call: vi.fn(() => Promise.resolve({ Workspaces: [] })) as never,
    });
    const session = Object.create(base, {
      role: { get: (): string => current, enumerable: true },
    }) as typeof base;
    const slot = createImpersonationSlot(() => Promise.resolve(session));
    await slot.open('HSanders');
    const context: CallContext = {
      identity: ANONYMOUS,
      pin: createSessionPin(ANONYMOUS),
      impersonation: slot,
    };
    return {
      context,
      switchTo: (next: string): void => {
        current = next;
      },
    };
  }

  it('rebuilds the view when the role changes', async () => {
    const { context, switchTo } = await switchable();
    const d = deps();

    const before = connectionFor(d, context);
    switchTo('ChangeManager');
    const after = connectionFor(d, context);

    expect(after).not.toBe(before);
    expect(after.forms).not.toBe(before.forms);
    expect(after.workspaces).not.toBe(before.workspaces);
  });

  // Still once per role, not once per call: a conversation makes many requests.
  it('keeps returning the same view while the role is unchanged', async () => {
    const { context } = await switchable();
    const d = deps();

    expect(connectionFor(d, context)).toBe(connectionFor(d, context));
  });

  // The SID does not change across a switch, so the transport must not be rebuilt around a new one.
  it('keeps the same SID on the transport across a switch', async () => {
    const { context, switchTo } = await switchable();
    const d = deps();

    connectionFor(d, context);
    switchTo('ChangeManager');

    expect(context.impersonation?.session()?.sid).toBe('tenant#S#1');
  });
});
