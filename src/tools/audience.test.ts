// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import type { Config } from '../config/env-schema.js';
import { audienceFor } from './audience.js';

const mode = (MCP_MODE: 'full' | 'enduser'): Config => ({ MCP_MODE }) as Config;

describe('audienceFor', () => {
  it('gives staff everything their tier reaches', () => {
    expect(audienceFor(mode('full'), 'session', 0)).toEqual({
      ownRecordsOnly: false,
      switchRole: true,
      assignedWork: true,
      sessionTools: true,
      quickActions: true,
      staffSurfaces: true,
      linking: true,
    });
  });

  it('keeps session tools off the OData tier in both modes', () => {
    for (const m of ['full', 'enduser'] as const) {
      const a = audienceFor(mode(m), 'odata', 5);
      expect([a.sessionTools, a.quickActions, a.staffSurfaces]).toEqual([false, false, false]);
    }
  });

  it('gives an end user quick actions only where some were named, and no staff surfaces', () => {
    expect(audienceFor(mode('enduser'), 'session', 0).quickActions).toBe(false);
    const named = audienceFor(mode('enduser'), 'session', 2);
    expect(named).toMatchObject({
      ownRecordsOnly: true,
      quickActions: true,
      staffSurfaces: false,
      switchRole: false,
      assignedWork: false,
      linking: false,
    });
  });
});
