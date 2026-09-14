// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import type { IvantiApiError } from '../http/errors.js';
import type { FetchLike } from '../http/transport.js';
import { createIvantiRoutes } from '../odata/url.js';
import { createSession } from './asmx-session.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const reply = (status: number, body: unknown): Awaited<ReturnType<FetchLike>> => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
});

const SID = 'tenant#SESSIONKEY#1';
const STATUS = {
  d: { SessionCsrfToken: 'csrf-1', ActiveRole: 'Admin', ActiveRoleDisplayName: 'Administrator' },
};
const USER = { d: { UserRole: 'ServiceDeskAnalyst', DisplayName: 'Jon Smith' } };

/** Answers the handshake, then whatever `after` says, recording every call. */
function tenant(after: (url: string, body: string) => Awaited<ReturnType<FetchLike>>) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  // The session surface never sends FormData, so a non-string body here is a test bug.
  const bodyOf = (body: string | FormData | undefined): string =>
    typeof body === 'string' ? body : '';
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, body: bodyOf(init.body), headers: init.headers });
    if (url.includes('AuthenticateTenantAPIKey')) return Promise.resolve(reply(200, { d: SID }));
    if (url.includes('InitializeSession')) return Promise.resolve(reply(200, STATUS));
    if (url.includes('GetUserData')) return Promise.resolve(reply(200, USER));
    return Promise.resolve(after(url, bodyOf(init.body)));
  };
  return { calls, fetchImpl };
}

const session = (fetchImpl: FetchLike) =>
  createSession({
    baseUrl: 'https://tenant.example',
    routes: createIvantiRoutes('https://tenant.example', '/HEAT'),
    apiKey: 'super-secret',
    logger: logger(),
    fetchImpl,
  });

describe('createSession', () => {
  it('runs the three-step handshake and reports the EFFECTIVE role', async () => {
    const { calls, fetchImpl } = tenant(() => reply(200, { d: {} }));

    const identity = await session(fetchImpl).identity();

    // Admin was requested; the account is an analyst, and GetUserData is what says so.
    expect(identity).toMatchObject({ role: 'ServiceDeskAnalyst', displayName: 'Jon Smith' });
    expect(calls.map((call) => call.url.split('/').pop())).toEqual([
      'AuthenticateTenantAPIKey',
      'InitializeSession',
      'GetUserData',
    ]);
  });

  it('keeps the session usable when GetUserData fails', async () => {
    const fetchImpl: FetchLike = (url) => {
      if (url.includes('AuthenticateTenantAPIKey')) return Promise.resolve(reply(200, { d: SID }));
      if (url.includes('InitializeSession')) return Promise.resolve(reply(200, STATUS));
      if (url.includes('GetUserData')) return Promise.resolve(reply(500, 'boom'));
      return Promise.resolve(reply(200, { d: 'ok' }));
    };

    // InitializeSession already reported the role, so the identity is still not a guess.
    await expect(session(fetchImpl).identity()).resolves.toMatchObject({ role: 'Admin' });
  });

  it('carries the SID as a cookie and the CSRF token in the body, as .asmx wants', async () => {
    const { calls, fetchImpl } = tenant(() => reply(200, { d: { Workspaces: [] } }));

    await session(fetchImpl).call('Services/Workspace.asmx', 'GetRoleWorkspaces', { sRole: 'x' });

    const last = calls.at(-1);
    expect(last?.url).toBe(
      'https://tenant.example/HEAT/Services/Workspace.asmx/GetRoleWorkspaces',
    );
    expect(last?.headers.Cookie).toBe(`SID=${SID}`);
    expect(JSON.parse(last?.body ?? '{}')).toEqual({ _csrfToken: 'csrf-1', sRole: 'x' });
    expect(last?.headers.Authorization).toBeUndefined();
  });

  it('handshakes once for concurrent callers', async () => {
    const { calls, fetchImpl } = tenant(() => reply(200, { d: 'ok' }));
    const live = session(fetchImpl);

    await Promise.all([live.identity(), live.identity(), live.call('a.asmx', 'b')]);

    expect(calls.filter((call) => call.url.includes('AuthenticateTenantAPIKey'))).toHaveLength(1);
  });

  it('re-handshakes once when the session has expired', async () => {
    let calledOnce = false;
    const { calls, fetchImpl } = tenant(() => {
      if (!calledOnce) {
        calledOnce = true;
        return reply(401, 'session expired');
      }
      return reply(200, { d: 'fresh' });
    });

    await expect(session(fetchImpl).call('a.asmx', 'b')).resolves.toBe('fresh');
    expect(calls.filter((call) => call.url.includes('AuthenticateTenantAPIKey'))).toHaveLength(2);
  });

  it('reaches the admin console when the caller asks for it', async () => {
    // Allowed, but never required: the catalog built on it degrades to the workspace list.
    const { calls, fetchImpl } = tenant(() => reply(200, { d: [{ id: 'Incident#' }] }));

    await session(fetchImpl).call('AdminUI/services/AppDesign.asmx', 'GetBriefBusinessObjects');

    expect(calls.at(-1)?.url).toBe(
      'https://tenant.example/HEAT/AdminUI/services/AppDesign.asmx/GetBriefBusinessObjects',
    );
  });

  it('never lets the API key out through an error body', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(reply(400, 'rejected key super-secret for tenant'));

    await session(fetchImpl)
      .identity()
      .catch((error: unknown) => {
        expect((error as IvantiApiError).body).not.toContain('super-secret');
      });
  });

  it('reports a missing CSRF token rather than pretending to have a session', async () => {
    const fetchImpl: FetchLike = (url) =>
      Promise.resolve(
        url.includes('AuthenticateTenantAPIKey')
          ? reply(200, { d: SID })
          : reply(200, { d: { ActiveRole: 'Admin' } }),
      );

    await expect(session(fetchImpl).identity()).rejects.toThrow(/no CSRF token/);
  });

  it('answers identityIfKnown without opening a session', () => {
    const { calls, fetchImpl } = tenant(() => reply(200, { d: 'ok' }));

    expect(session(fetchImpl).identityIfKnown()).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
