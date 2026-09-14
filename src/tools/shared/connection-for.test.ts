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
