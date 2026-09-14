// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { buildHealth, MINIMAL_HEALTH, type HealthDeps } from './health.js';

const deps = (overrides: Partial<HealthDeps> = {}): HealthDeps => ({
  name: 'test-server',
  version: '1.2.3',
  protocolVersion: '2025-11-25',
  sdkVersion: '1.30.0',
  sessions: () => 2,
  now: () => new Date('2026-09-10T12:00:00.000Z'),
  uptimeSeconds: () => 100,
  ...overrides,
});

describe('MINIMAL_HEALTH', () => {
  it('discloses liveness and nothing else', () => {
    expect(MINIMAL_HEALTH).toEqual({ status: 'ok' });
  });

  it('leaks no version, usage or timing detail', () => {
    expect(Object.keys(MINIMAL_HEALTH)).toEqual(['status']);
  });
});

describe('buildHealth', () => {
  it('reports identity and a timestamp for an authorized caller', () => {
    expect(buildHealth(deps())).toEqual({
      status: 'ok',
      name: 'test-server',
      version: '1.2.3',
      protocolVersion: '2025-11-25',
      sdkVersion: '1.30.0',
      timestamp: '2026-09-10T12:00:00.000Z',
      uptimeSeconds: 100,
      sessions: 2,
    });
  });

  it('never reports memory or CPU, which would guide an attacker tuning load', () => {
    const keys = Object.keys(buildHealth(deps()));

    expect(keys).not.toContain('memory');
    expect(keys).not.toContain('cpu');
  });

  it('reflects the live session count rather than a snapshot', () => {
    let count = 0;
    const shared = deps({ sessions: () => count });

    expect(buildHealth(shared).sessions).toBe(0);
    count = 5;
    expect(buildHealth(shared).sessions).toBe(5);
  });

  it('rounds uptime to a tenth of a second', () => {
    expect(buildHealth(deps({ uptimeSeconds: () => 12.3456 })).uptimeSeconds).toBe(12.3);
  });
});
