// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import type { Logger } from '../../logger.js';
import { createFulltextSearchObjectTool } from './fulltext-search-object.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const ROW = {
  RecId: 'a',
  IncidentNumber: 10480,
  Subject: 'Printer jams',
  Status: 'Active',
  Symptom: 'long text nobody asked for',
};

const body = (result: CallToolResult): Record<string, never> => {
  const [block] = result.content;
  return JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<string, never>;
};

const tool = (responses: Record<string, unknown>) => {
  const { connection, urls } = connectionFixture({
    entities: { incident: { fields: [field('RecId'), field('Subject')] } },
    responses,
  });
  return { urls, tool: createFulltextSearchObjectTool({ connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS }) };
};

describe('fulltext_search_object', () => {
  it('searches with $search — the only substring mechanism Ivanti honours', async () => {
    const { tool: search, urls } = tool({ incidents: { value: [ROW], '@odata.count': 48 } });

    const result = body(await search.handler({ object: 'Incidents', query: 'printer' }));

    expect(urls[0]).toContain('$search=printer');
    expect(result).toMatchObject({ query: 'printer', returned: 1, total: 48, totalIsExact: true });
  });

  it('returns a compact identifying set rather than the whole record', async () => {
    const { tool: search } = tool({ incidents: { value: [ROW] } });

    const rows = body(await search.handler({ object: 'Incidents', query: 'printer' }))
      .rows as unknown as Record<string, unknown>[];

    expect(Object.keys(rows[0] ?? {})).toEqual(['RecId', 'IncidentNumber', 'Subject', 'Status']);
  });

  it('composes with a filter, so "open incidents mentioning printer" is one call', async () => {
    const { tool: search, urls } = tool({ incidents: { value: [] } });

    await search.handler({ object: 'Incidents', query: 'printer', filter: "Status eq 'Active'" });

    expect(urls[0]).toContain('$search=printer');
    expect(urls[0]).toContain('$filter=Status%20eq%20');
  });

  it('returns whole records for "*", as the description promises', async () => {
    // `"*"` reached the projection as a field NAME no row has, so every hit was its RecId alone.
    const { tool: search } = tool({ incidents: { value: [ROW] } });

    const rows = body(await search.handler({ object: 'Incidents', query: 'printer', fields: '*' }))
      .rows as unknown as Record<string, unknown>[];

    expect(rows[0]).toEqual(ROW);
  });

  it('shows a tenant’s own object by its own fields, not as bare RecIds', async () => {
    // Nothing on the preference list, so the fixed default had nothing to show but the id.
    const { connection } = connectionFixture({
      entities: { workorder: { fields: [field('RecId'), field('WorkOrderRef'), field('Summary')] } },
      responses: {
        workorders: { value: [{ RecId: 'w1', WorkOrderRef: 'WO-7', Summary: 'Fix the printer' }] },
      },
    });
    const search = createFulltextSearchObjectTool({
      connection,
      gate: OPEN_GATE,
      logger: logger(),
      ownRecordsOnly: false,
      actions: OPEN_ACTIONS,
    });

    const result = body(await search.handler({ object: 'workorders', query: 'printer' }));

    expect((result.rows as unknown as Record<string, unknown>[])[0]).toMatchObject({
      WorkOrderRef: 'WO-7',
      Summary: 'Fix the printer',
    });
    expect(String(result.fields)).toContain('NOT ONE OF THE ONES THE DEFAULT KNOWS');
  });

  it('still refuses a filter Ivanti would silently drop', async () => {
    const { tool: search } = tool({ incidents: { value: [] } });

    const result = await search.handler({
      object: 'Incidents',
      query: 'printer',
      filter: "contains(Subject,'x')",
    });

    expect(result.isError).toBe(true);
  });
});
