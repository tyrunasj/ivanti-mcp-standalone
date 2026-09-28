// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import type { Logger } from '../logger.js';
import { selectTools, type ToolContext } from './register-tools.js';
import { declaredArguments, strictInput, unknownArgumentMessage } from './strict-input.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const everyTool = (mode: 'full' | 'enduser') =>
  selectTools(configFixture({ MCP_MODE: mode, ...(mode === 'enduser' ? { ENDUSER_BUSINESS_OBJECTS: ['incident'] } : {}) }), {
    serverName: 'ivanti-mcp',
    serverVersion: '0.1.0',
    logger: logger(),
    ivanti: connectionFixture({
      entities: { incident: {}, change: {}, servicereq: {}, employee: {}, journal__notes: {} },
      capability: { tier: 'admin', identity: { role: 'Admin' }, canImpersonate: true },
    }).connection,
  } satisfies ToolContext);

describe('strictInput', () => {
  it('names the argument that differs only in case, which is the one that cost an answer', () => {
    const schema = strictInput({ object: z.string(), orderBy: z.string().optional() });
    const parsed = (schema as z.ZodObject).safeParse({ object: 'Incidents', orderby: 'CreatedDateTime desc' });

    expect(parsed.success).toBe(false);
    const message = parsed.error?.issues.map((issue) => issue.message).join(' ') ?? '';
    expect(message).toContain("Unknown argument 'orderby'");
    expect(message).toContain("Did you mean 'orderBy'?");
    // The valid names, because a caller told only "no" retries with another guess.
    expect(message).toContain('This tool takes: object, orderBy.');
  });

  it('says the argument was dropped rather than applied — the part that made it dangerous', () => {
    expect(unknownArgumentMessage(['orderby'], ['orderBy'])).toContain('DROPPED, not applied');
  });

  it('lists the arguments when nothing is close', () => {
    const message = unknownArgumentMessage(['wibble'], ['object', 'filter']);
    expect(message).toContain("Unknown argument 'wibble'");
    expect(message).not.toContain('Did you mean');
    expect(message).toContain('This tool takes: object, filter.');
  });

  it('names every unknown argument when several arrive', () => {
    expect(unknownArgumentMessage(['a', 'b'], ['object'])).toContain("Unknown arguments 'a', 'b'");
  });

  /**
   * A client that sends `{ random_string: '…' }` to a tool taking nothing is asking for exactly
   * what the tool offers. Closing that shape would refuse a correct call.
   */
  it('leaves a zero-argument tool open', () => {
    const schema = strictInput({});
    expect(schema).toEqual({});
  });

  it('reads the declared arguments back out of either form', () => {
    expect(Object.keys(declaredArguments(strictInput({ object: z.string() })))).toEqual(['object']);
    expect(declaredArguments(strictInput({}))).toEqual({});
    expect(declaredArguments(undefined)).toEqual({});
  });
});

describe('every registered tool', () => {
  /**
   * The point of closing the shapes in `defineTool` rather than at each definition site: a tool
   * added later is covered without anyone remembering to cover it. A tool that forgot would not
   * fail — it would answer, with the argument thrown away.
   */
  it.each(['full', 'enduser'] as const)('refuses an argument it does not declare (%s)', (mode) => {
    const open = everyTool(mode)
      .filter((tool) => Object.keys(declaredArguments(tool.config.inputSchema)).length > 0)
      .filter((tool) => {
        const parsed = (tool.config.inputSchema as z.ZodObject).safeParse({ __not_an_argument: 1 });
        return parsed.success || !parsed.error.issues.some((i) => i.code === 'unrecognized_keys');
      })
      .map((tool) => tool.name);

    expect(open, `these tools silently drop an unknown argument: ${open.join(', ')}`).toEqual([]);
  });

  it('still declares its real arguments — the guard reads a closed schema, not zod internals', () => {
    const listRecords = everyTool('full').find((tool) => tool.name === 'list_records');

    expect(Object.keys(declaredArguments(listRecords?.config.inputSchema))).toEqual([
      'object', 'filter', 'search', 'orderBy', 'fields', 'top', 'skip',
    ]);
  });
});
