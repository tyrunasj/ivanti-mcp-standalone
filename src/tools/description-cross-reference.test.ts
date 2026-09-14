// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import type { Capability } from '../ivanti/session/capability.js';
import type { Logger } from '../logger.js';
import { selectTools, type ToolContext } from './register-tools.js';

/**
 * A description must not send the model to a tool this deployment does not have.
 *
 * `resources.test.ts` already enforces exactly this for the six reference DOCUMENTS, on the
 * stated grounds that a model cannot tell "not registered here" from "you called it wrong" and
 * will retry with synonyms. The higher-traffic surface — the tool descriptions themselves, re-sent
 * every session — had no such guard, and carried it in both directions: `list_approvals` pointed
 * at `vote_on_approval`, which is gated on the session tier, and `create_record` and
 * `delete_attachment` pointed at `link_records` and `unlink_records`, which `enduser` never
 * registers at ANY tier.
 *
 * Every name is spelled the same way a model reads it, so the match is on the tool's own name.
 */

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** Every tool this codebase can register, so a mention can be recognised as a tool name at all. */
const EVERY_TOOL = new Set(
  selectTools(configFixture({ MCP_MODE: 'full' }), context('admin')).map((tool) => tool.name),
);

function context(tier: Capability['tier']): ToolContext {
  return {
    serverName: 'ivanti-mcp',
    serverVersion: '0.1.0',
    logger: logger(),
    ivanti: connectionFixture({
      entities: { incident: {}, change: {}, servicereq: {}, employee: {}, journal__notes: {} },
      capability:
        tier === 'odata'
          ? { tier: 'odata', reason: 'fixture' }
          : { tier, identity: { role: 'Admin' }, canImpersonate: true },
    }).connection,
  };
}

function deployment(mode: 'full' | 'enduser', tier: Capability['tier']) {
  const config = configFixture(
    mode === 'enduser'
      ? {
          MCP_MODE: 'enduser',
          ENDUSER_BUSINESS_OBJECTS: ['incident', 'change', 'servicereq'],
          ENDUSER_QUICK_ACTIONS: ['Close From Self Service'],
        }
      : { MCP_MODE: 'full' },
  );
  return selectTools(config, context(tier));
}

const DEPLOYMENTS = [
  ['full', 'admin'],
  ['full', 'session'],
  ['full', 'odata'],
  ['enduser', 'admin'],
  ['enduser', 'session'],
  ['enduser', 'odata'],
] as const;

describe('tool descriptions name only tools this deployment registers', () => {
  it.each(DEPLOYMENTS)('%s / %s', (mode, tier) => {
    const tools = deployment(mode, tier);
    const registered = new Set(tools.map((tool) => tool.name));

    const dangling: string[] = [];
    for (const tool of tools) {
      const text = tool.config.description;
      for (const name of EVERY_TOOL) {
        if (registered.has(name)) continue;
        // Word-boundary, so `search` inside `fulltext_search_object` is not a hit.
        if (new RegExp(`\\b${name}\\b`, 'u').test(text)) {
          dangling.push(`${tool.name} names ${name}`);
        }
      }
    }

    expect(
      dangling,
      `these descriptions point at tools this deployment does not register — a model cannot tell ` +
        `that from "you called it wrong", so it retries with synonyms:\n  ${dangling.join('\n  ')}`,
    ).toEqual([]);
  });
});
