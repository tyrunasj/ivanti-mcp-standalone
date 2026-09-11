import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger.js';
import type { AdminCatalog } from './admin-catalog.js';
import type { IvantiSession } from './asmx-session.js';
import { probeCapability } from './capability.js';

const admin = (list: AdminCatalog['list']): AdminCatalog => ({ list });
const adminWorks = admin(() => Promise.resolve([]));
const adminRefuses = admin(() => Promise.reject(new Error('404 AdminUI')));

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const session = (identity: IvantiSession['identity']): IvantiSession => ({
  identity,
  identityIfKnown: () => undefined,
      callHandler: () => Promise.reject(new Error('unused')),
  call: () => Promise.reject(new Error('unused')),
});

describe('probeCapability', () => {
  it('reports the admin tier when the console answers too', async () => {
    const capability = await probeCapability(
      session(() => Promise.resolve({ role: 'Admin' })),
      adminWorks,
      logger(),
    );

    expect(capability).toEqual({ tier: 'admin', identity: { role: 'Admin' } });
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
