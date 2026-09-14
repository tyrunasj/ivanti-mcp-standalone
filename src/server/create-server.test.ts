// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../auth/identity.js';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import type { Logger } from '../logger.js';
import { createServerFactory } from './create-server.js';

const config = configFixture();

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const deps = (): { logger: Logger } => ({ logger: logger() });

const CALL = { identity: ANONYMOUS };

describe('createServerFactory', () => {
  it('reports the tools every server will expose', () => {
    expect(createServerFactory(config, deps()).toolNames).toEqual(['get_version']);
  });

  it('hands out a distinct server per connection', () => {
    const factory = createServerFactory(config, deps());

    expect(factory.create(CALL)).not.toBe(factory.create(CALL));
  });

  it('exposes the same tool set in enduser mode', () => {
    expect(createServerFactory({ ...config, MCP_MODE: 'enduser' }, deps()).toolNames).toEqual([
      'get_version',
    ]);
  });

  it('builds servers that are usable independently', () => {
    const factory = createServerFactory(config, deps());

    expect(factory.create(CALL)).toBeDefined();
    expect(factory.create(CALL)).toBeDefined();
  });

  it('exposes the Ivanti tools when a tenant is connected', () => {
    const { connection } = connectionFixture();

    const factory = createServerFactory(config, { logger: logger(), ivanti: connection });

    expect(factory.toolNames).toContain('list_business_objects');
  });
});
