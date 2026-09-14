// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import type { AdminCatalog } from './admin-catalog.js';
import type { IvantiSession } from './asmx-session.js';
import { probeCapability } from './capability.js';
import type { CentralConfig } from './central-config.js';

const admin = (list: AdminCatalog['list']): AdminCatalog => ({ list });
const adminWorks = admin(() => Promise.resolve([]));
const adminRefuses = admin(() => Promise.reject(new Error('404 AdminUI')));

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const session = (identity: IvantiSession['identity']): IvantiSession => ({
  identity,
  identityIfKnown: () => undefined,
      callHandler: () => Promise.reject(new Error('unused')),
      uploadToHandler: () => Promise.reject(new Error('no handler in this fixture')),
  call: () => Promise.reject(new Error('unused')),
});

describe('probeCapability', () => {
  it('reports the admin tier when the console answers too', async () => {
    const capability = await probeCapability(
      session(() => Promise.resolve({ role: 'Admin' })),
      adminWorks,
      logger(),
    );

    expect(capability).toEqual({
      tier: 'admin',
      identity: { role: 'Admin' },
      // The normal state for a deployment without the ConfigDB pair — not a degradation.
      canImpersonate: false,
    });
  });

  it('falls back to the session tier when the admin console refuses', async () => {
    // The common case: a key whose role opens a session but is not an administrator.
    const capability = await probeCapability(
      session(() => Promise.resolve({ role: 'ServiceDeskAnalyst' })),
      adminRefuses,
      logger(),
    );

    expect(capability).toMatchObject({ tier: 'session', reason: '404 AdminUI' });
  });

  it('degrades to OData rather than failing the server', async () => {
    // A key whose role cannot open a session still serves every read tool, which is the tier
    // most customers will run.
    const warnings: string[] = [];
    const log = { ...logger(), warn: (message: string) => warnings.push(message) };

    const capability = await probeCapability(
      session(() => Promise.reject(new Error('401 ISM_4001'))),
      adminRefuses,
      log,
    );

    expect(capability).toMatchObject({ tier: 'odata', reason: '401 ISM_4001' });
    expect(warnings.join()).toContain('session unavailable');
  });
});

describe('IVANTI_MAX_TIER', () => {
  it('caps at odata without even opening a session', async () => {
    let handshakes = 0;
    const counting = session(() => {
      handshakes += 1;
      return Promise.resolve({ role: 'Admin' });
    });

    const capability = await probeCapability(counting, adminWorks, logger(), 'odata');

    expect(capability).toMatchObject({ tier: 'odata', reason: 'capped by IVANTI_MAX_TIER' });
    expect(handshakes).toBe(0);
  });

  it('caps at session without touching the admin console', async () => {
    let adminCalls = 0;
    const countingAdmin = admin(() => {
      adminCalls += 1;
      return Promise.resolve([]);
    });

    const capability = await probeCapability(
      session(() => Promise.resolve({ role: 'Admin' })),
      countingAdmin,
      logger(),
      'session',
    );

    expect(capability).toMatchObject({ tier: 'session', reason: 'capped by IVANTI_MAX_TIER' });
    expect(adminCalls).toBe(0);
  });
});

const centralConfig = (probe: CentralConfig['probe']): CentralConfig => ({
  probe,
  authenticate: () => Promise.reject(new Error('unused')),
  release: () => Promise.resolve(),
});

describe('the impersonation probe', () => {
  it('reports it unavailable, and says so at info, when it is not configured', async () => {
    const info = vi.fn<Logger['info']>();
    const warn = vi.fn<Logger['warn']>();

    const capability = await probeCapability(
      session(() => Promise.resolve({ role: 'Admin' })),
      adminWorks,
      { debug: vi.fn(), info, warn, error: vi.fn() },
    );

    expect(capability.canImpersonate).toBe(false);
    expect(capability.impersonationReason).toBeUndefined();
    expect(info.mock.calls.map(([message]) => message).join(' | ')).toContain(
      'impersonation not configured',
    );
    // Not configured is a normal deployment, not a degradation to warn about.
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports it available when CentralConfig answers', async () => {
    const capability = await probeCapability(
      session(() => Promise.resolve({ role: 'Admin' })),
      adminWorks,
      logger(),
      'admin',
      centralConfig(() => Promise.resolve()),
    );

    expect(capability.canImpersonate).toBe(true);
  });

  // A ConfigDB that is down must not take the server with it: the deployment is still useful,
  // and act_as falls back to deciding who "my" means.
  it('warns and keeps serving when CentralConfig refuses', async () => {
    const warn = vi.fn<Logger['warn']>();

    const capability = await probeCapability(
      session(() => Promise.resolve({ role: 'Admin' })),
      adminWorks,
      { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      'admin',
      centralConfig(() => Promise.reject(new Error('401 Unauthorized'))),
    );

    // The tier is untouched: a ConfigDB outage costs impersonation and nothing else.
    expect(capability.tier).toBe('admin');
    expect(capability.canImpersonate).toBe(false);
    expect(capability.impersonationReason).toContain('401');
    expect(warn.mock.calls[0]?.[0]).toContain('impersonation configured but unavailable');
  });

  // Impersonation drives OData, and every tier has OData — including one capped below the ASMX
  // session. Tying it to the tier would refuse it for no reason.
  it('is available at the odata tier, which is all it needs', async () => {
    const capability = await probeCapability(
      session(() => Promise.reject(new Error('no session'))),
      adminRefuses,
      logger(),
      'odata',
      centralConfig(() => Promise.resolve()),
    );

    expect(capability.tier).toBe('odata');
    expect(capability.canImpersonate).toBe(true);
  });
});
