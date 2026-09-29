// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import {
  CHARACTERS,
  compare,
  headline,
  markdown,
  measure,
  toApiTool,
  type Counter,
  type ListedTool,
  type Snapshot,
} from './manifest-size.js';

const tool = (name: string, description: string): ListedTool => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {} },
});

/**
 * A stand-in for a vendor's counter: one unit per character of name and description, plus a fixed
 * preamble whenever any tool is present — the cost `measure` has to subtract.
 */
const VENDOR: Counter = {
  unit: 'tokens',
  count: (request) =>
    Promise.resolve(
      (request.tools.length > 0 ? 500 : 0) +
        (request.system?.length ?? 0) +
        request.tools.reduce((sum, t) => sum + t.name.length + (t.description?.length ?? 0), 0) +
        (request.text?.length ?? 0),
    ),
};

describe('measure', () => {
  it('reports what the server adds, never the preamble a vendor charges for having tools', async () => {
    const result = await measure(
      VENDOR,
      [
        { label: 'narrow', tools: [tool('a', 'x'.repeat(10))], instructions: 'y'.repeat(7) },
        { label: 'wide', tools: [tool('a', 'x'.repeat(10)), tool('bb', 'z'.repeat(20))], instructions: '' },
      ],
      [{ uri: 'ivanti://reference/queries', text: 'q'.repeat(30) }],
    );

    expect(result).toEqual({
      unit: 'tokens',
      deployments: [
        { label: 'narrow', tools: 1, manifest: 11, instructions: 7 },
        { label: 'wide', tools: 2, manifest: 33, instructions: 0 },
      ],
      widest: 'wide',
      // Dearest first, the description split out from the name and schema.
      tools: [
        { name: 'bb', total: 22, description: 20 },
        { name: 'a', total: 11, description: 10 },
      ],
      resources: [{ uri: 'ivanti://reference/queries', cost: 30 }],
    });
  });

  it('counts characters by default, schema included', async () => {
    const listed = tool('list_records', 'Lists records.');
    const result = await measure(CHARACTERS, [{ label: 'd', tools: [listed], instructions: 'Be careful.' }], []);

    // The tool as JSON, plus the comma that joins it to the probe.
    expect(result.deployments[0]).toEqual({
      label: 'd',
      tools: 1,
      manifest: JSON.stringify(toApiTool(listed)).length + 1,
      instructions: 'Be careful.'.length,
    });
    expect(result.tools[0]?.description).toBeGreaterThanOrEqual('Lists records.'.length);
  });
});

const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  unit: 'characters',
  deployments: [{ label: 'full/admin/plain', tools: 2, manifest: 1000, instructions: 400 }],
  widest: 'full/admin/plain',
  tools: [
    { name: 'list_records', total: 600, description: 400 },
    { name: 'get_record', total: 400, description: 200 },
  ],
  resources: [{ uri: 'ivanti://reference/queries', cost: 900 }],
  ...overrides,
});

const grown = snapshot({
  deployments: [{ label: 'full/admin/plain', tools: 2, manifest: 1240, instructions: 400 }],
  tools: [
    { name: 'list_records', total: 840, description: 640 },
    { name: 'get_record', total: 400, description: 200 },
  ],
});

describe('compare', () => {
  it('lists only what moved', () => {
    expect(compare(snapshot(), grown)).toEqual([
      'per request, full/admin/plain: 1,400 → 1,640 (+240)',
      'tool list_records: 600 → 840 (+240)',
    ]);
  });

  it('marks a tool that appeared or went away', () => {
    const after = snapshot({ tools: [{ name: 'list_records', total: 600, description: 400 }] });

    expect(compare(snapshot(), after)).toEqual(['tool get_record: 400 → 0 (-400) (gone)']);
  });

  it('refuses to compare two units', () => {
    expect(compare(snapshot(), snapshot({ unit: 'tokens' }))[0]).toMatch(/^Not comparable/);
  });
});

describe('the pull-request summary', () => {
  it('leads with what the dearest deployment now costs every request', () => {
    expect(headline(snapshot(), grown)).toBe(
      'Manifest + instructions: 1,400 → 1,640 characters per request (+240, full/admin/plain).',
    );
    expect(headline(snapshot(), snapshot())).toMatch(/^Manifest \+ instructions unchanged: 1,400/);
  });

  it('tabulates every deployment and only the tools that moved', () => {
    const summary = markdown(grown, snapshot());

    expect(summary).toContain('| full/admin/plain | 1,400 | 1,640 | +240 |');
    expect(summary).toContain('| list_records | 600 | 840 | +240 |');
    expect(summary).not.toContain('get_record');
  });

  it('says so when nothing moved', () => {
    expect(markdown(snapshot(), snapshot())).toContain('No tool or document changed size.');
  });

  it('still reports the figures when there is no base to compare with', () => {
    expect(markdown(snapshot())).toContain('| full/admin/plain | 2 | 1,000 | 400 | 1,400 |');
  });
});
