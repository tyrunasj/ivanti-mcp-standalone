// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../auth/identity.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import { createImpersonationSlot } from '../../auth/impersonation.js';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import type { ImpersonatedSession } from '../../ivanti/session/impersonated-session.js';
import type { Logger } from '../../logger.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import type { CallContext } from '../tool-definition.js';
import { switchRoleTool } from './switch-role.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const tool = () => {
  const { connection } = connectionFixture({ entities: { incident: {} } });
  return switchRoleTool({
    connection,
    gate: OPEN_GATE,
    logger: logger(),
    ownRecordsOnly: false,
    actions: OPEN_ACTIONS,
  });
};

const ROLES = [
  { name: 'ServiceDeskAnalyst', displayName: 'Service Desk Analyst', selfService: false },
  { name: 'SelfServiceMobile', displayName: 'Self Service', selfService: true },
];

function session(switchTo = vi.fn((role: string) => Promise.resolve(role))): ImpersonatedSession {
  let role = 'ServiceDeskAnalyst';
  return {
    sid: 'tenant#A#1',
    loginId: 'HSanders',
    get role(): string {
      return role;
    },
    roles: ROLES,
    call: () => Promise.reject(new Error('unused')),
    switchTo: async (next: string): Promise<string> => {
      role = await switchTo(next);
      return role;
    },
    release: () => Promise.resolve(),
  } as ImpersonatedSession;
}

async function withSession(target?: ImpersonatedSession): Promise<CallContext> {
  const slot = createImpersonationSlot(() => Promise.resolve(target ?? session()));
  if (target !== undefined || target === undefined) await slot.open('HSanders');
  return { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS), impersonation: slot };
}

const text = (result: { content: { type: string; text?: string }[] }): string =>
  result.content[0]?.text ?? '';
const body = (result: { content: { type: string; text?: string }[] }): Record<string, unknown> =>
  JSON.parse(text(result)) as Record<string, unknown>;

describe('switch_role', () => {
  it('switches to a role the person holds and reports what changed', async () => {
    const context = await withSession();

    const result = await tool().handler({ role: 'SelfServiceMobile' }, context);

    expect(body(result)).toMatchObject({
      role: 'SelfServiceMobile',
      previousRole: 'ServiceDeskAnalyst',
      otherRoles: ['ServiceDeskAnalyst'],
    });
  });

  it('matches the role id without regard to case', async () => {
    const context = await withSession();

    expect(body(await tool().handler({ role: 'selfservicemobile' }, context))['role']).toBe(
      'SelfServiceMobile',
    );
  });

  // Named, not merely refused: a caller told only "no" retries with a synonym.
  it('refuses a role the person does not hold, and lists the ones they do', async () => {
    const context = await withSession();

    const result = await tool().handler({ role: 'Admin' }, context);

    expect(text(result)).toContain("does not hold the role 'Admin'");
    expect(text(result)).toContain('ServiceDeskAnalyst');
  });

  // Two causes, and the caller can act on the difference between them.
  it('distinguishes "nobody is being acted for" from "this deployment cannot"', async () => {
    const slot = createImpersonationSlot(() => Promise.resolve(session()));
    const notYet: CallContext = {
      identity: ANONYMOUS,
      pin: createSessionPin(ANONYMOUS),
      impersonation: slot,
    };
    const never: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };

    expect(text(await tool().handler({ role: 'X' }, notYet))).toContain('Call act_as first');
    expect(text(await tool().handler({ role: 'X' }, never))).toContain(
      'does not open Ivanti sessions',
    );
  });

  // A requested role is a request; Ivanti answers with what it actually applied.
  it('says so when Ivanti applies a different role than asked', async () => {
    const context = await withSession(session(vi.fn(() => Promise.resolve('ServiceDeskAnalyst'))));

    const result = await tool().handler({ role: 'SelfServiceMobile' }, context);

    expect(body(result)['role']).toBe('ServiceDeskAnalyst');
    expect(String(body(result)['note'])).toContain('rather than SelfServiceMobile');
  });
});
