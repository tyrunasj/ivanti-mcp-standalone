// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import {
  chooseRole,
  parseNamedRoles,
  parseUserRoles,
  readRoles,
  selectRole,
  type IvantiRole,
  type RoleChoiceOptions,
} from './roles.js';

const debugLogger = (): { debug: (message: string, context?: Record<string, unknown>) => void } => ({
  debug: vi.fn(),
});

const options = (overrides: Partial<RoleChoiceOptions> = {}): RoleChoiceOptions => ({
  mode: 'full',
  enduserRole: 'SelfServiceMobile',
  activeRole: '',
  ...overrides,
});

const role = (name: string, selfService?: boolean): IvantiRole => ({
  name,
  displayName: name,
  ...(selfService === undefined ? {} : { selfService }),
});

const ANALYST = role('ServiceDeskAnalyst', false);
const PORTAL = role('SelfServiceMobile', true);
const OTHER_PORTAL = role('SelfServiceIT', true);

describe('parseUserRoles', () => {
  it('reads the flag Ivanti sends, and keeps unknown as unknown', () => {
    const roles = parseUserRoles({
      userRoleList: [
        { Name: 'ServiceDeskAnalyst', DisplayName: 'Service Desk Analyst', SelfServiceRole: false },
        { Name: 'SelfServiceMobile', DisplayName: 'Self Service', SelfServiceRole: true },
        // No flag at all: not the same as false.
        { Name: 'Odd', DisplayName: 'Odd' },
      ],
    });

    expect(roles).toEqual([
      { name: 'ServiceDeskAnalyst', displayName: 'Service Desk Analyst', selfService: false },
      { name: 'SelfServiceMobile', displayName: 'Self Service', selfService: true },
      { name: 'Odd', displayName: 'Odd' },
    ]);
  });

  it('drops entries with no usable id and falls back to the id for a label', () => {
    expect(parseUserRoles({ userRoleList: [{ Name: null }, { Name: 'Admin' }] })).toEqual([
      { name: 'Admin', displayName: 'Admin' },
    ]);
  });

  it('survives a reply with no list at all', () => {
    expect(parseUserRoles({})).toEqual([]);
  });
});

describe('parseNamedRoles', () => {
  // The fallback source carries no flags. Every role must therefore come back `selfService`
  // undefined — claiming false here would hand an enduser deployment an analyst role.
  it('reports no flag rather than guessing one', () => {
    const roles = parseNamedRoles({
      roleList: [{ Name: 'Admin', DisplayName: 'Administrator' }, { Name: 'SelfService' }],
    });

    expect(roles).toEqual([
      { name: 'Admin', displayName: 'Administrator' },
      { name: 'SelfService', displayName: 'SelfService' },
    ]);
    expect(roles.every((entry) => entry.selfService === undefined)).toBe(true);
  });
});

describe('chooseRole in enduser mode', () => {
  const enduser = (overrides: Partial<RoleChoiceOptions> = {}): RoleChoiceOptions =>
    options({ mode: 'enduser', ...overrides });

  it('takes the configured role when the person holds it', () => {
    const choice = chooseRole([ANALYST, PORTAL], enduser({ activeRole: 'ServiceDeskAnalyst' }));

    expect(choice).toEqual({ ok: true, role: 'SelfServiceMobile', mustSelect: true });
  });

  it('does not call SelectRole when the active role is already the one wanted', () => {
    const choice = chooseRole([PORTAL], enduser({ activeRole: 'SelfServiceMobile' }));

    expect(choice).toMatchObject({ ok: true, mustSelect: false });
  });

  it('falls back to another self-service role, saying which and why', () => {
    const choice = chooseRole([ANALYST, OTHER_PORTAL], enduser({ activeRole: 'ServiceDeskAnalyst' }));

    expect(choice).toMatchObject({ ok: true, role: 'SelfServiceIT' });
    expect(choice).toHaveProperty('note', expect.stringContaining('SelfServiceMobile is not held'));
  });

  // Nobody is locked out because an account was never given a portal role — but an enduser
  // deployment running an agent role has to be visible.
  it('keeps the active role when the person holds no self-service role, and says so', () => {
    const choice = chooseRole([ANALYST], enduser({ activeRole: 'ServiceDeskAnalyst' }));

    expect(choice).toMatchObject({ ok: true, role: 'ServiceDeskAnalyst', mustSelect: false });
    expect(choice).toHaveProperty('note', expect.stringContaining('no self-service role'));
  });

  // An unflagged role is unknown, not self-service. Guessing here is what would quietly open an
  // agent role in an end-user deployment.
  it('does not treat an unflagged role as self-service', () => {
    const choice = chooseRole([role('Mystery')], enduser({ activeRole: 'Mystery' }));

    expect(choice).toHaveProperty('note', expect.stringContaining('no self-service role'));
  });

  it('refuses when there is no role at all to fall back to', () => {
    const choice = chooseRole([ANALYST], enduser({ activeRole: '' }));

    expect(choice).toMatchObject({ ok: false });
  });
});

describe('chooseRole in full mode', () => {
  it('keeps the role Ivanti made active', () => {
    const choice = chooseRole([ANALYST, PORTAL], options({ activeRole: 'ServiceDeskAnalyst' }));

    expect(choice).toEqual({ ok: true, role: 'ServiceDeskAnalyst', mustSelect: false });
  });

  it('moves off a self-service active role onto a working one', () => {
    const choice = chooseRole([ANALYST, PORTAL], options({ activeRole: 'SelfServiceMobile' }));

    expect(choice).toMatchObject({ ok: true, role: 'ServiceDeskAnalyst', mustSelect: true });
  });

  // The ACope case: Ivanti hands back an empty ActiveRole even for someone holding three roles.
  it('picks a working role when Ivanti opened the session with none', () => {
    const choice = chooseRole([PORTAL, ANALYST], options({ activeRole: '' }));

    expect(choice).toMatchObject({ ok: true, role: 'ServiceDeskAnalyst', mustSelect: true });
  });

  it('takes the pinned role when the person holds it', () => {
    const choice = chooseRole(
      [ANALYST, role('Admin', false)],
      options({ pinnedRole: 'Admin', activeRole: 'ServiceDeskAnalyst' }),
    );

    expect(choice).toMatchObject({ ok: true, role: 'Admin', mustSelect: true });
  });

  // Silently ignoring it would tell a deployment it had one level of access while giving another.
  it('refuses a pinned role the person does not hold, and names what they do', () => {
    const choice = chooseRole(
      [ANALYST],
      options({ pinnedRole: 'Admin', activeRole: 'ServiceDeskAnalyst' }),
    );

    expect(choice).toMatchObject({ ok: false });
    expect(choice).toHaveProperty('refusal', expect.stringContaining('ServiceDeskAnalyst'));
  });

  // A real answer about this person, not a failure: some staff genuinely only have the portal.
  it('runs as a self-service role when that is all the person has', () => {
    const choice = chooseRole([PORTAL], options({ activeRole: 'SelfServiceMobile' }));

    expect(choice).toMatchObject({ ok: true, role: 'SelfServiceMobile' });
    expect(choice).toHaveProperty('note', expect.stringContaining('only self-service'));
  });

  it('refuses when Ivanti reports neither an active role nor any to choose', () => {
    const choice = chooseRole([], options({ activeRole: '' }));

    expect(choice).toMatchObject({ ok: false });
    expect(choice).toHaveProperty('refusal', expect.stringContaining('reads nothing'));
  });

  // Role ids are Ivanti's own text and their casing is not guaranteed to match configuration.
  it('matches role names without regard to case', () => {
    const choice = chooseRole([ANALYST], options({ pinnedRole: 'servicedeskanalyst' }));

    expect(choice).toMatchObject({ ok: true, role: 'ServiceDeskAnalyst' });
  });
});

describe('readRoles', () => {
  it('prefers GetUserData, because it is the only source with the flag', async () => {
    const rolesForUser = vi.fn();

    const roles = await readRoles(
      {
        userData: () =>
          Promise.resolve({ userRoleList: [{ Name: 'SelfServiceMobile', SelfServiceRole: true }] }),
        rolesForUser: rolesForUser as never,
      },
      debugLogger(),
    );

    expect(roles).toEqual([
      { name: 'SelfServiceMobile', displayName: 'SelfServiceMobile', selfService: true },
    ]);
    expect(rolesForUser).not.toHaveBeenCalled();
  });

  // GetUserData answers 500 whenever the session has no active role — exactly the case that most
  // needs a role chosen. Without this fallback the feature would fail on the ACope shape.
  it('falls back when GetUserData throws', async () => {
    const roles = await readRoles(
      {
        userData: () => Promise.reject(new Error('HTTP 500')),
        rolesForUser: () => Promise.resolve({ roleList: [{ Name: 'Admin' }] }),
      },
      debugLogger(),
    );

    expect(roles).toEqual([{ name: 'Admin', displayName: 'Admin' }]);
  });

  it('falls back on an empty list too, which Ivanti also produces', async () => {
    const roles = await readRoles(
      {
        userData: () => Promise.resolve({ userRoleList: [] }),
        rolesForUser: () => Promise.resolve({ roleList: [{ Name: 'Admin' }] }),
      },
      debugLogger(),
    );

    expect(roles).toEqual([{ name: 'Admin', displayName: 'Admin' }]);
  });
});

describe('selectRole', () => {
  it('calls SelectRole on Session.asmx with sRole', async () => {
    const call = vi.fn().mockResolvedValue({ ActiveRole: 'SelfService' });

    const effective = await selectRole({ call: call as never }, 'SelfService');

    expect(call).toHaveBeenCalledWith('Services/Session.asmx', 'SelectRole', {
      sRole: 'SelfService',
    });
    expect(effective).toBe('SelfService');
  });

  // A requested role is a request. Ivanti answers with what it actually gave, and a caller that
  // assumed its own argument would report access the session does not have.
  it('reports the role Ivanti actually applied, not the one asked for', async () => {
    const call = vi.fn().mockResolvedValue({ ActiveRole: 'SelfService' });

    expect(await selectRole({ call: call as never }, 'Admin')).toBe('SelfService');
  });

  it('falls back to the requested role when Ivanti names none', async () => {
    const call = vi.fn().mockResolvedValue({ ActiveRole: null });

    expect(await selectRole({ call: call as never }, 'Admin')).toBe('Admin');
  });
});
