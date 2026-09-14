// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import { IvantiApiError } from '../http/errors.js';
import type { FetchLike } from '../http/transport.js';
import { composeSid, createCentralConfig } from './central-config.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const API_KEY = 'central-config-key';
const TENANT = 'tenant.example.com';

/** A real reply's shape, including the two fields that must never escape this module. */
const SUCCESS = `<?xml version="1.0" encoding="utf-8"?>
<TenantDbAuth>
  <TenantId>tenant.example.com</TenantId>
  <LoginId>HSanders</LoginId>
  <SessionId>QVPKB4KSDL8CHBAUAQC5S2NOFKA9HR8B</SessionId>
  <ConnectionString>Server=db;User Id=sa;Password=hunter2;</ConnectionString>
  <ProviderName>System.Data.SqlClient</ProviderName>
  <SessionKey>SK-123</SessionKey>
  <SessionKeyExpire>2026-09-15T00:00:00</SessionKeyExpire>
  <AuthenticationStatus>Success</AuthenticationStatus>
</TenantDbAuth>`;

const refusal = (status: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<TenantDbAuth><AuthenticationStatus>${status}</AuthenticationStatus></TenantDbAuth>`;

function centralConfig(respond: (url: string) => { status?: number; body: string }) {
  const calls: string[] = [];
  const fetchImpl = vi.fn<FetchLike>((url) => {
    calls.push(url);
    const { status = 200, body } = respond(url);
    return Promise.resolve(new Response(body, { status }));
  });
  const config = createCentralConfig({
    configUrl: 'https://config-tenant.example.com/',
    tenantHost: TENANT,
    apiKey: API_KEY,
    logger: logger(),
    fetchImpl,
  });
  return { config, calls, fetchImpl };
}

describe('composeSid', () => {
  // The single string that decides whether the whole feature works. CentralConfig returns only
  // the middle segment, and the bare form is rejected by InitializeSession.
  it('wraps the bare session id in the form Ivanti keys its session store on', () => {
    expect(composeSid(TENANT, 'ABC123')).toBe('tenant.example.com#ABC123#1');
  });
});

describe('authenticate', () => {
  it('returns the composed SID and the login Ivanti matched', async () => {
    const { config } = centralConfig(() => ({ body: SUCCESS }));

    const session = await config.authenticate('hsanders');

    expect(session.sid).toBe(`${TENANT}#QVPKB4KSDL8CHBAUAQC5S2NOFKA9HR8B#1`);
    // Echoed back rather than assumed: the caller's spelling is not necessarily Ivanti's.
    expect(session.loginId).toBe('HSanders');
    expect(session.expiresAt).toBe('2026-09-15T00:00:00');
  });

  // The reply carries the tenant's database credentials. Nothing may keep it.
  it('drops the connection string and session key rather than returning them', async () => {
    const { config } = centralConfig(() => ({ body: SUCCESS }));

    const session = await config.authenticate('HSanders');

    expect(JSON.stringify(session)).not.toContain('hunter2');
    expect(JSON.stringify(session)).not.toContain('Password');
    expect(JSON.stringify(session)).not.toContain('SK-123');
  });

  it('sends the key as an ApiKey header, never as Authorization', async () => {
    const { config, fetchImpl } = centralConfig(() => ({ body: SUCCESS }));

    await config.authenticate('HSanders');

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers['ApiKey']).toBe(API_KEY);
    expect(init?.headers['Authorization']).toBeUndefined();
  });

  // "Can't find user name X" sends people hunting for a typo. It means DISABLED.
  it('explains that an unfound user means a disabled one, not a wrong name', async () => {
    const { config } = centralConfig(() => ({
      body: refusal("Can't find user name PChang"),
    }));

    await expect(config.authenticate('PChang')).rejects.toThrow(/disabled/i);
  });

  it('explains AccessDenied the same way', async () => {
    const { config } = centralConfig(() => ({ body: refusal('AccessDenied') }));

    await expect(config.authenticate('ACope')).rejects.toThrow(/disabled/i);
  });

  it('keeps the database credentials out of an error body', async () => {
    const { config } = centralConfig(() => ({ status: 500, body: SUCCESS }));

    const error = await config.authenticate('HSanders').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IvantiApiError);
    expect((error as IvantiApiError).body).not.toContain('hunter2');
    expect((error as IvantiApiError).body).toContain('[REDACTED]');
  });

  // The login is in the query string, and query strings are the one thing this codebase does not
  // log — for the same reason a $filter is not logged.
  it('keeps the impersonated login out of the logged URL', async () => {
    const { config } = centralConfig(() => ({ status: 500, body: refusal('boom') }));

    const error = await config.authenticate('HSanders').catch((caught: unknown) => caught);

    expect((error as IvantiApiError).url).not.toContain('HSanders');
  });

  it('reports an unreachable ConfigDB as such rather than as a refusal', async () => {
    const config = createCentralConfig({
      configUrl: 'https://config-tenant.example.com/',
      tenantHost: TENANT,
      apiKey: API_KEY,
      logger: logger(),
      fetchImpl: () => Promise.reject(new Error('ENOTFOUND')),
    });

    await expect(config.authenticate('HSanders')).rejects.toThrow(/unreachable/i);
  });
});

describe('release', () => {
  // Tidy-up must never become the error a caller sees; an unreleased session expires anyway.
  it('swallows a failure', async () => {
    const { config } = centralConfig(() => ({ status: 500, body: 'no' }));

    await expect(config.release(`${TENANT}#ABC#1`)).resolves.toBeUndefined();
  });
});
