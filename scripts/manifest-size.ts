// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * What this server costs a conversation before any tool is called, in characters.
 *
 *   pnpm manifest:size                                   # every deployment, each tool, each document
 *   pnpm manifest:size --json > /tmp/before.json         # a snapshot, before a change …
 *   pnpm manifest:size --compare /tmp/before.json        # … and after it: only what moved
 *   pnpm manifest:size --compare base.json --markdown    # the pull-request summary CI writes
 *   pnpm manifest:size --compare base.json --headline    # its one-line annotation
 *
 * Characters, not tokens — see `lib/manifest-size.ts` for why, and for how a vendor's own counter
 * would plug in. No network, no credential, the same answer every run.
 *
 * The manifest is built the way a client receives it — `tools/list` over an in-memory transport,
 * so the zod-to-JSON-Schema conversion is included — for every mode × tier × impersonation, because
 * descriptions vary on all three and the widest is not the obvious one.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../src/config/env-schema.js';
import { configFixture } from '../src/config/config.fixture.js';
import { connectionFixture } from '../src/ivanti/connection.fixture.js';
import type { Capability } from '../src/ivanti/session/capability.js';
import { selectResources } from '../src/resources/register-resources.js';
import { buildInstructions } from '../src/server/instructions.js';
import { selectTools, type ToolContext } from '../src/tools/register-tools.js';
import {
  CHARACTERS,
  compare,
  headline,
  markdown,
  measure,
  type Deployment,
  type ListedTool,
  type Snapshot,
} from './lib/manifest-size.js';

const { values } = parseArgs({
  options: {
    json: { type: 'boolean', default: false },
    compare: { type: 'string' },
    markdown: { type: 'boolean', default: false },
    headline: { type: 'boolean', default: false },
  },
});

const silent = { debug: (): void => {}, info: (): void => {}, warn: (): void => {}, error: (): void => {} };

const MODES: [string, Config][] = [
  ['full', configFixture({ MCP_MODE: 'full' })],
  [
    'enduser',
    configFixture({
      MCP_MODE: 'enduser',
      ENDUSER_BUSINESS_OBJECTS: ['incident', 'change', 'servicereq'],
      ENDUSER_QUICK_ACTIONS: ['Close From Self Service'],
    }),
  ],
];

function contextFor(tier: Capability['tier'], canImpersonate: boolean): ToolContext {
  return {
    serverName: 'ivanti-mcp',
    serverVersion: '0.0.0',
    logger: silent,
    ivanti: connectionFixture({
      entities: { incident: {}, change: {}, servicereq: {}, employee: {}, journal__notes: {} },
      capability: {
        tier,
        // A display name of realistic length: the instructions interpolate it twice.
        ...(tier === 'odata'
          ? {}
          : { identity: { role: 'ServiceDeskAnalyst', displayName: 'Alexandra Montgomery' } }),
        canImpersonate,
      },
    }).connection,
  };
}

async function listTools(config: Config, context: ToolContext): Promise<ListedTool[]> {
  const server = new McpServer({ name: 'ivanti-mcp', version: '0.0.0' });
  // Listed, never called: the handler is not part of what a client is sent.
  for (const tool of selectTools(config, context)) {
    server.registerTool(tool.name, tool.config, () => ({ content: [] }));
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'manifest-size', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

async function deployments(): Promise<{
  deployments: Deployment[];
  resources: { uri: string; text: string }[];
}> {
  const built: Deployment[] = [];
  let resources: { uri: string; text: string }[] = [];
  for (const [mode, config] of MODES) {
    for (const tier of ['odata', 'session', 'admin'] as const) {
      for (const canImpersonate of tier === 'odata' ? [false] : [false, true]) {
        const context = contextFor(tier, canImpersonate);
        const documents = selectResources(config, context);
        if (documents.length > resources.length) resources = documents;
        built.push({
          label: `${mode}/${tier}/${canImpersonate ? 'impersonating' : 'plain'}`,
          tools: await listTools(config, context),
          instructions:
            buildInstructions({
              capability: context.ivanti?.capability,
              mode: config.MCP_MODE,
              resourceUris: documents.map((document) => document.uri),
            }) ?? '',
        });
      }
    }
  }
  return { deployments: built, resources: resources.map(({ uri, text }) => ({ uri, text })) };
}

const { deployments: built, resources } = await deployments();
const snapshot = await measure(CHARACTERS, built, resources);
const before =
  values.compare === undefined
    ? undefined
    : (JSON.parse(readFileSync(values.compare, 'utf8')) as Snapshot);

if (values.json) {
  console.log(JSON.stringify(snapshot, null, 2));
} else if (values.markdown) {
  console.log(markdown(snapshot, before));
} else if (values.headline && before !== undefined) {
  console.log(headline(before, snapshot));
} else if (before !== undefined) {
  const moved = compare(before, snapshot);
  console.log(moved.length === 0 ? 'Nothing moved.' : moved.join('\n'));
} else {
  print(snapshot);
}

function print(result: Snapshot): void {
  const n = (value: number): string => value.toLocaleString('en-US');
  console.log(
    `In ${result.unit}. The manifest and the instructions are sent with EVERY request of every ` +
      'conversation — each turn and each step of a tool loop; prompt caching discounts that, it ' +
      'does not remove it. Characters rather than tokens because each vendor tokenizes ' +
      'differently; schemas and ids pack fewer characters per token than prose.\n',
  );

  table(
    ['deployment', 'tools', 'manifest', 'instructions', 'per request'],
    result.deployments.map((d) => [
      d.label,
      String(d.tools),
      n(d.manifest),
      n(d.instructions),
      n(d.manifest + d.instructions),
    ]),
  );

  console.log(`\nPer tool, in ${result.widest} (the dearest deployment):`);
  table(
    ['tool', 'total', 'description', 'name + schema'],
    result.tools.map((t) => [t.name, n(t.total), n(t.description), n(t.total - t.description)]),
  );

  console.log('\nReference documents, paid each time one is read:');
  table(
    ['uri', result.unit],
    result.resources.map((r) => [r.uri, n(r.cost)]),
  );
}

function table(header: string[], rows: string[][]): void {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  // The first column is a name and reads left to right; the rest are figures.
  const line = (row: string[]): string =>
    row
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
      )
      .join('  ');
  console.log(line(header));
  for (const row of rows) console.log(line(row));
}
