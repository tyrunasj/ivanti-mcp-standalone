import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { createCountRecordsTool } from './count-records.js';
import { createGetRecordTool } from './get-record.js';
import { createGetRelatedRecordsTool } from './get-related-records.js';
import { createListRecordsTool } from './list-records.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const INCIDENT = {
  fields: [field('RecId'), field('Subject'), field('Status')],
  relationships: [
    { name: 'IncidentContainsTask', target: 'task' },
    { name: 'IncidentContainsJournal', target: 'journal' },
  ],
};

const ROW = { RecId: 'abc', IncidentNumber: 10244, Subject: 'Printer', Status: 'Active' };

const fixture = (responses: Record<string, unknown> = {}) => {
  const { connection, urls } = connectionFixture({ entities: { incident: INCIDENT }, responses });
  return { deps: { connection, logger: logger() }, urls };
};

const text = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
};

const body = (result: CallToolResult): Record<string, unknown> =>
  JSON.parse(text(result) || '{}') as Record<string, unknown>;

describe('get_record', () => {
  it('reads by key and projects the requested fields', async () => {
    const { deps, urls } = fixture({ "incidents('abc')": ROW });

    const result = await createGetRecordTool(deps).handler({
      object: 'Incident#',
      recordId: 'abc',
      fields: 'Subject,Status',
    });

    expect(body(result)).toEqual({
      object: 'incidents',
      record: { Subject: 'Printer', Status: 'Active' },
    });
    expect(urls[0]).toContain("incidents('abc')");
  });

  it('treats an empty body as "not there" rather than as a record', async () => {
    const { deps } = fixture({});

    const result = await createGetRecordTool(deps).handler({
      object: 'Incidents',
      recordId: 'missing',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No incidents record with RecId missing');
  });

  it('rejects an unknown Business Object before asking Ivanti', async () => {
    const { deps, urls } = fixture({});

    const result = await createGetRecordTool(deps).handler({
      object: 'Elephants',
      recordId: 'abc',
    });

    expect(result.isError).toBe(true);
    expect(urls).toHaveLength(0);
  });
});

describe('list_records', () => {
  it('returns rows with the total and whether more remain', async () => {
    const { deps } = fixture({ incidents: { value: [ROW, ROW], '@odata.count': 545 } });

    const result = await createListRecordsTool(deps).handler({ object: 'Incidents', top: 2 });

    expect(body(result)).toMatchObject({
      object: 'incidents',
      returned: 2,
      total: 545,
      totalIsExact: true,
      hasMore: true,
    });
  });

  it('refuses a filter Ivanti would silently ignore', async () => {
    const { deps, urls } = fixture({ incidents: { value: [ROW] } });

    const result = await createListRecordsTool(deps).handler({
      object: 'Incidents',
      filter: "contains(Subject,'printer')",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/silently ignored/);
    // Nothing was sent: the point is to refuse before Ivanti answers 200 with everything.
    expect(urls).toHaveLength(0);
  });

  it('reads an empty body as no rows', async () => {
    const { deps } = fixture({});

    const result = await createListRecordsTool(deps).handler({
      object: 'Incidents',
      filter: "Status eq 'Nope'",
    });

    expect(body(result)).toMatchObject({ returned: 0, rows: [] });
  });

  it('passes filter, search and order through to the query', async () => {
    const { deps, urls } = fixture({ incidents: { value: [] } });

    await createListRecordsTool(deps).handler({
      object: 'Incidents',
      filter: "Status eq 'Active'",
      search: 'printer',
      orderBy: 'CreatedDateTime desc',
      skip: 10,
    });

    expect(urls[0]).toContain('$filter=Status%20eq%20');
    expect(urls[0]).toContain('$search=printer');
    expect(urls[0]).toContain('$orderby=CreatedDateTime%20desc');
    expect(urls[0]).toContain('$skip=10');
  });
});

describe('count_records', () => {
  it('reports a count that agrees with its rows as exact', async () => {
    const { deps } = fixture({ incidents: { value: [ROW], '@odata.count': 545 } });

    const result = await createCountRecordsTool(deps).handler({ object: 'Incidents' });

    expect(body(result)).toEqual({ object: 'incidents', count: 545, exact: true });
  });

  it('reports a self-contradicting count as a floor', async () => {
    const { deps } = fixture({ incidents: { value: [ROW, ROW, ROW], '@odata.count': 1 } });

    expect(body(await createCountRecordsTool(deps).handler({ object: 'Incidents' }))).toEqual({
      object: 'incidents',
      count: 3,
      exact: false,
    });
  });

  it('reads Ivanti\'s empty body as an exact zero', async () => {
    const { deps } = fixture({});

    expect(body(await createCountRecordsTool(deps).handler({ object: 'Incidents' }))).toEqual({
      object: 'incidents',
      count: 0,
      exact: true,
    });
  });
});

describe('get_related_records', () => {
  it('follows a relationship and projects the rows', async () => {
    const { deps, urls } = fixture({
      IncidentContainsTask: { value: [{ RecId: 't1', Subject: 'Replace toner' }] },
    });

    const result = await createGetRelatedRecordsTool(deps).handler({
      object: 'Incidents',
      recordId: 'abc',
      relationship: 'incidentcontainstask',
      fields: 'Subject',
    });

    expect(body(result)).toMatchObject({
      relationship: 'IncidentContainsTask',
      target: 'task',
      returned: 1,
      rows: [{ Subject: 'Replace toner' }],
    });
    expect(urls[0]).toContain("incidents('abc')/IncidentContainsTask");
  });

  it('absorbs the sentinel string Ivanti sends for an empty relationship', async () => {
    // `{"value": "No instances found."}` answers .length with 19 and [0] with "N".
    const { deps } = fixture({ IncidentContainsTask: { value: 'No instances found.' } });

    const result = await createGetRelatedRecordsTool(deps).handler({
      object: 'Incidents',
      recordId: 'abc',
      relationship: 'IncidentContainsTask',
    });

    expect(body(result)).toMatchObject({ returned: 0, rows: [] });
  });

  it('rejects an unknown relationship with the ones that exist', async () => {
    const { deps, urls } = fixture({});

    const result = await createGetRelatedRecordsTool(deps).handler({
      object: 'Incidents',
      recordId: 'abc',
      relationship: 'Tasks',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('IncidentContainsTask');
    expect(urls).toHaveLength(0);
  });
});
