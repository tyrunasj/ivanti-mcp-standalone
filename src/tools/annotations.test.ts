// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import type { Logger } from '../logger.js';
import { selectTools } from './register-tools.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const registered = (mode: 'full' | 'enduser') =>
  selectTools(
    configFixture({ MCP_MODE: mode, ...(mode === 'enduser' ? { ENDUSER_BUSINESS_OBJECTS: ['incident'] } : {}) }),
    {
      serverName: 'ivanti-mcp',
      serverVersion: '0.1.0',
      logger: logger(),
      ivanti: connectionFixture({
        entities: { incident: {}, change: {}, servicereq: {}, employee: {}, journal__notes: {} },
        capability: { tier: 'admin', identity: { role: 'Admin' }, canImpersonate: true },
      }).connection,
    },
  );

/**
 * "Annotate every tool explicitly." The SDK's annotation type is all-optional and an unannotated
 * tool defaults to destructive and open-world, so a tool that forgot a hint would not fail — it
 * would be advertised as the most dangerous thing it could be, or (worse) as read-only.
 */
describe.each(['full', 'enduser'] as const)('tool annotations, %s mode', (mode) => {
  const tools = registered(mode);

  it('registers tools to check', () => {
    expect(tools.length).toBeGreaterThan(30);
  });

  it('states readOnlyHint and openWorldHint on every tool', () => {
    for (const tool of tools) {
      const { annotations } = tool.config;
      expect(typeof annotations.readOnlyHint, `${tool.name}: readOnlyHint`).toBe('boolean');
      expect(typeof annotations.openWorldHint, `${tool.name}: openWorldHint`).toBe('boolean');
    }
  });

  it('states destructiveHint and idempotentHint on every tool that writes', () => {
    for (const tool of tools) {
      const { annotations } = tool.config;
      if (annotations.readOnlyHint === true) continue;
      expect(typeof annotations.destructiveHint, `${tool.name}: destructiveHint`).toBe('boolean');
      expect(typeof annotations.idempotentHint, `${tool.name}: idempotentHint`).toBe('boolean');
    }
  });
});
