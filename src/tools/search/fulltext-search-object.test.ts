import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
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
  return { urls, tool: createFulltextSearchObjectTool({ connection, logger: logger() }) };
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
