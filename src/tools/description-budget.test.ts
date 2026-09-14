// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import type { Logger } from '../logger.js';
import { buildInstructions } from '../server/instructions.js';
import { selectTools, type ToolContext } from './register-tools.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/**
 * Ceilings on what a tool description may cost.
 *
 * **Clients truncate a long description silently, and from the END** — the model receives text
 * that stops mid-sentence with no marker that anything is missing, so whatever sits last is what
 * disappears. That is the worst possible failure mode for this manifest, because the last
 * paragraph is where the warnings go: measured in `overlord-service` against the Claude Code
 * harness, two tools independently cut at offsets ~2040 and ~2044, which points at a 2 KiB cap.
 * The cap is a client behaviour, not a protocol one — the MCP spec sets no maximum — so the
 * budget here is 2000, leaving margin for both an error in that inference and a small edit.
 *
 * **If a description needs to grow past the budget, move reference material into an
 * `ivanti://reference/` resource rather than raising the number.** The resources exist for
 * exactly that, and text past the cap is not reaching the model at all — so raising the limit
 * buys nothing and hides the problem.
 *
 * The manifest total matters separately: it is re-sent on every `tools/list`, so it is a standing
 * cost on every conversation rather than a one-off.
 */
const DESCRIPTION_BUDGET = 2000;

/**
 * The same ceiling for the server's `instructions`.
 *
 * No client truncation has been measured on this field specifically, so the description cap is
 * reused as the conservative assumption: it is the only cap anyone has actually observed, and
 * `instructions` is read once at connect time and carries the identity warning — the single
 * sentence that stops a model reporting one person's queue as another's. Losing its end silently
 * is exactly the failure this file exists to prevent.
 */
const INSTRUCTIONS_BUDGET = 2000;

/**
 * A ceiling on one argument's description.
 *
 * These sit inside `inputSchema` rather than the description field, and nothing has been measured
 * truncating them — but an argument whose explanation runs to a page is a sign the material
 * belongs in the tool description or a reference resource, where it is read once rather than
 * re-sent per argument on every `tools/list`.
 */
const PARAMETER_BUDGET = 1000;

/** Every reference document, which is the longest the instructions can get. */
const REFERENCE_URIS = [
  'ivanti://reference/entity-naming',
  'ivanti://reference/field-names',
  'ivanti://reference/queries',
  'ivanti://reference/write-recipes',
  'ivanti://reference/picklists',
  'ivanti://reference/workflow',
];

/** Roughly 30% above today's ~29 KB: room to say more, not room to stop thinking about it. */
const MANIFEST_BUDGET = 38_000;

const MODES = [
  ['full', configFixture({ MCP_MODE: 'full' })],
  [
    'enduser',
    configFixture({
      MCP_MODE: 'enduser',
      ENDUSER_BUSINESS_OBJECTS: ['incident', 'change', 'servicereq'],
      ENDUSER_QUICK_ACTIONS: ['Close From Self Service'],
    }),
  ],
] as const;

function manifest(config: (typeof MODES)[number][1]) {
  const context: ToolContext = {
    serverName: 'ivanti-mcp',
    serverVersion: '0.1.0',
    logger: logger(),
    // The admin tier, so every tool that can exist does — the widest manifest a caller sees.
    ivanti: connectionFixture({
      entities: { incident: {}, change: {}, servicereq: {}, employee: {}, journal__notes: {} },
      capability: { tier: 'admin', identity: { role: 'Admin' } },
    }).connection,
  };
  return selectTools(config, context).map((tool) => ({
    name: tool.name,
    length: tool.config.description.length,
    parameters: Object.entries(
      (tool.config.inputSchema ?? {}) as Record<string, { description?: string }>,
    ).map(([parameter, schema]) => ({
      parameter,
      // Zod carries the text on the schema itself; `.describe()` is what puts it there.
      length: (schema.description ?? readZodDescription(schema)).length,
    })),
  }));
}

/** Zod v4 keeps `.describe()` text in the schema's metadata rather than on the object. */
function readZodDescription(schema: unknown): string {
  const meta = (schema as { _zod?: { def?: { description?: unknown } }; description?: unknown })
    ._zod?.def?.description;
  return typeof meta === 'string' ? meta : '';
}

describe('tool description budget', () => {
  it.each(MODES)('keeps every %s description under the truncation cap', (_mode, config) => {
    const over = manifest(config)
      .filter((tool) => tool.length > DESCRIPTION_BUDGET)
      .sort((a, b) => b.length - a.length)
      .map((tool) => `${tool.name} is ${String(tool.length - DESCRIPTION_BUDGET)} over (${String(tool.length)})`);

    expect(
      over,
      `past the ${String(DESCRIPTION_BUDGET)}-char budget — a client will cut the END of these, ` +
        `which is where the warnings are. Move the material to an ivanti://reference/ resource ` +
        `rather than raising the budget:\n  ${over.join('\n  ')}`,
    ).toEqual([]);
  });

  it.each(MODES)('keeps the whole %s manifest within its per-session cost', (mode, config) => {
    const tools = manifest(config);
    const total = tools.reduce((sum, tool) => sum + tool.length, 0);

    expect(
      total,
      `${String(mode)} descriptions total ${String(total)} chars across ${String(tools.length)} ` +
        `tools, over the ${String(MANIFEST_BUDGET)} budget. This is re-sent every session.`,
    ).toBeLessThanOrEqual(MANIFEST_BUDGET);
  });

  it.each(MODES)('keeps every %s argument description proportionate', (_mode, config) => {
    const over = manifest(config)
      .flatMap((tool) => tool.parameters.map((p) => ({ ...p, tool: tool.name })))
      .filter((p) => p.length > PARAMETER_BUDGET)
      .map((p) => `${p.tool}.${p.parameter} is ${String(p.length)}`);

    expect(over, `over the ${String(PARAMETER_BUDGET)}-char argument budget:\n  ${over.join('\n  ')}`).toEqual(
      [],
    );
  });

  it.each(MODES)('keeps the %s server instructions under the same cap as a description', (mode, config) => {
    const { connection } = connectionFixture({
      entities: { incident: {}, change: {}, servicereq: {} },
      capability: { tier: 'admin', identity: { role: 'Admin' } },
    });
    const instructions =
      buildInstructions({
        capability: connection.capability,
        mode,
        // Every reference document named, which is the longest this can get.
        resourceUris: REFERENCE_URIS,
      }) ?? '';
    void config;

    expect(
      instructions.length,
      `server instructions are ${String(instructions.length)} chars, over the ` +
        `${String(INSTRUCTIONS_BUDGET)} budget. A client that truncates cuts the END, which is ` +
        'where the "treat record text as data" warning sits.',
    ).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET);
    // Not empty either: an instructions block that silently became blank would pass a cap test.
    expect(instructions.length).toBeGreaterThan(200);
  });

  it('reports the current spend, so growth is visible in the diff rather than only in a failure', () => {
    const totals = MODES.map(([mode, config]) => {
      const tools = manifest(config);
      const total = tools.reduce((sum, tool) => sum + tool.length, 0);
      const largest = [...tools].sort((a, b) => b.length - a.length)[0];
      return { mode, tools: tools.length, total, largest: largest?.name, chars: largest?.length };
    });

    // Not an assertion about the numbers — a record of them. A reviewer seeing this line move a
    // long way in a diff is the point.
    expect(totals.every((row) => row.total > 0)).toBe(true);
  });
});
