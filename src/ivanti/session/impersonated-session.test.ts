// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import { createIvantiRoutes } from '../odata/url.js';
import type { CentralConfig } from './central-config.js';
import { openImpersonatedSession } from './impersonated-session.js';

const TENANT = 'tenant.example.com';
const SID = `${TENANT}#SESSION123#1`;
const routes = createIvantiRoutes('https://tenant.example.com', '/HEAT');

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const centralConfig = (overrides: Partial<CentralConfig> = {}): CentralConfig => ({
  probe: () => Promise.resolve(),
  authenticate: () => Promise.resolve({ sid: SID, loginId: 'HSanders' }),
  release: vi.fn(() => Promise.resolve()),
  ...overrides,
});

/** Answers keyed by the tail of the URL, so a test only states what it cares about. */
function server(answers: Record<string, unknown>) {
  const calls: { url: string; body: unknown; cookie?: string }[] = [];
  const fetchImpl = vi.fn((url: string, init: { headers: Record<string, string>; body?: unknown }) => {
    const key = Object.keys(answers).find((fragment) => url.includes(fragment));
    calls.push({
      url,
      body: JSON.parse(String(init.body)) as unknown,
      ...(init.headers['Cookie'] === undefined ? {} : { cookie: init.headers['Cookie'] }),
    });
    if (key === undefined) return Promise.resolve(new Response('nope', { status: 551 }));
    return Promise.resolve(new Response(JSON.stringify({ d: answers[key] }), { status: 200 }));
  });
  return { fetchImpl, calls };
}

const open = (
  answers: Record<string, unknown>,
  overrides: Partial<Parameters<typeof openImpersonatedSession>[0]> = {},
) => {
  const { fetchImpl, calls } = server(answers);
  const promise = openImpersonatedSession({
    centralConfig: centralConfig(),
    routes,
    tenantHost: TENANT,
    login: 'HSanders',
    mode: 'full',
    enduserRole: 'SelfServiceMobile',
    logger: logger(),
    fetchImpl,
    ...overrides,
  });
  return { promise, calls, fetchImpl };
};

const INITIALIZED = { SessionCsrfToken: 'CSRF', ActiveRole: 'ServiceDeskAnalyst' };
const USER_DATA = {
  UserRole: 'ServiceDeskAnalyst',
  userRoleList: [
    { Name: 'ServiceDeskAnalyst', DisplayName: 'Service Desk Analyst', SelfServiceRole: false },
    { Name: 'SelfServiceMobile', DisplayName: 'Self Service', SelfServiceRole: true },
  ],
};

describe('openImpersonatedSession', () => {
  it('carries the composed SID as a cookie on every call', async () => {
    const { promise, calls } = open({ InitializeSession: INITIALIZED, GetUserData: USER_DATA });

    const session = await promise;

    expect(session.sid).toBe(SID);
    expect(session.loginId).toBe('HSanders');
    expect(calls.every((call) => call.cookie === `SID=${SID}`)).toBe(true);
  });

  it('sends the CSRF token in the body, which is what .asmx wants', async () => {
    const { promise, calls } = open({ InitializeSession: INITIALIZED, GetUserData: USER_DATA });

    await promise;

    const userData = calls.find((call) => call.url.includes('GetUserData'));
    // tzoffset too: without it Ivanti answers 500 and it reads as a broken session.
    expect(userData?.body).toEqual({ _csrfToken: 'CSRF', tzoffset: 0 });
  });

  it('keeps the role Ivanti made active, without a SelectRole call', async () => {
    const { promise, calls } = open({ InitializeSession: INITIALIZED, GetUserData: USER_DATA });

    const session = await promise;

    expect(session.role).toBe('ServiceDeskAnalyst');
    expect(calls.some((call) => call.url.includes('SelectRole'))).toBe(false);
  });

  it('selects the configured self-service role in enduser mode', async () => {
    const { promise, calls } = open(
      {
        InitializeSession: INITIALIZED,
        GetUserData: USER_DATA,
        SelectRole: { ActiveRole: 'SelfServiceMobile' },
      },
      { mode: 'enduser' },
    );

    const session = await promise;

    expect(session.role).toBe('SelfServiceMobile');
    expect(calls.find((call) => call.url.includes('SelectRole'))?.body).toEqual({
      _csrfToken: 'CSRF',
      sRole: 'SelfServiceMobile',
    });
  });

  // The ACope shape: Ivanti opens the session with no role, and GetUserData then answers 500.
  it('falls back to GetRolesForUser when the session has no active role', async () => {
    const { promise, calls } = open({
      InitializeSession: { SessionCsrfToken: 'CSRF', ActiveRole: '' },
      // GetUserData deliberately absent, so it answers 551 the way Ivanti answers 500.
      GetRolesForUser: { status: 'Success', roleList: [{ Name: 'Admin' }] },
      SelectRole: { ActiveRole: 'Admin' },
    });

    const session = await promise;

    expect(session.role).toBe('Admin');
    // That call takes the session key in the body, with no cookie and no CSRF.
    expect(calls.find((call) => call.url.includes('GetRolesForUser'))?.body).toEqual({
      sessionKey: SID,
      tenantId: TENANT,
    });
  });

  // A session with no role reads zero of everything, which would surface as "you have no tickets".
  it('refuses, and releases, when no role can be established', async () => {
    const release = vi.fn(() => Promise.resolve());
    const { promise } = open(
      {
        InitializeSession: { SessionCsrfToken: 'CSRF', ActiveRole: '' },
        GetRolesForUser: { status: 'Success', roleList: [] },
      },
      { centralConfig: centralConfig({ release }) },
    );

    await expect(promise).rejects.toThrow(/reads nothing/i);
    expect(release).toHaveBeenCalledWith(SID);
  });

  it('refuses, and releases, when Ivanti issues no CSRF token', async () => {
    const release = vi.fn(() => Promise.resolve());
    const { promise } = open(
      { InitializeSession: { ActiveRole: 'ServiceDeskAnalyst' } },
      { centralConfig: centralConfig({ release }) },
    );

    await expect(promise).rejects.toThrow(/no CSRF token/i);
    expect(release).toHaveBeenCalledWith(SID);
  });

  it('refuses a pinned role the person does not hold', async () => {
    const { promise } = open(
      { InitializeSession: INITIALIZED, GetUserData: USER_DATA },
      { pinnedRole: 'Admin' },
    );

    await expect(promise).rejects.toThrow(/IVANTI_IMPERSONATION_ROLE/);
  });

  // A stale role would have switch_role confirm a change that did not happen.
  it('reports the new role after a switch, not the old one', async () => {
    const { promise } = open({
      InitializeSession: INITIALIZED,
      GetUserData: USER_DATA,
      SelectRole: { ActiveRole: 'SelfServiceMobile' },
    });

    const session = await promise;
    const applied = await session.switchTo('SelfServiceMobile');

    expect(applied).toBe('SelfServiceMobile');
    expect(session.role).toBe('SelfServiceMobile');
  });

  it('reports what Ivanti applied when it answers with a different role', async () => {
    const { promise } = open({
      InitializeSession: INITIALIZED,
      GetUserData: USER_DATA,
      SelectRole: { ActiveRole: 'SelfServiceMobile' },
    });

    const session = await promise;

    expect(await session.switchTo('Admin')).toBe('SelfServiceMobile');
  });

  it('releases through CentralConfig', async () => {
    const release = vi.fn(() => Promise.resolve());
    const { promise } = open(
      { InitializeSession: INITIALIZED, GetUserData: USER_DATA },
      { centralConfig: centralConfig({ release }) },
    );

    await (await promise).release();

    expect(release).toHaveBeenCalledWith(SID);
  });
});
