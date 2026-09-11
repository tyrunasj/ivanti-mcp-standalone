import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { createFetchTool } from './fetch.js';
import { decodeRecordId, encodeRecordId, recordSummary, recordTitle } from './record-identity.js';
import { createSearchTool } from './search.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const body = (result: CallToolResult): Record<string, never> => {
  const [block] = result.content;
  return JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<string, never>;
};

const ENTITIES = { incident: {}, servicereq: {}, change: {} };

const tools = (responses: Record<string, unknown>) => {
  const { connection, urls } = connectionFixture({ entities: ENTITIES, responses });
  const deps = { connection, logger: logger() };
  return { urls, search: createSearchTool(deps), fetch: createFetchTool(deps) };
};

describe('record identity', () => {
  it('round-trips an id that says which object the record is in', () => {
    const id = encodeRecordId('incidents', 'abc');

    expect(id).toBe('incidents:abc');
    expect(decodeRecordId(id)).toEqual({ entitySet: 'incidents', recId: 'abc' });
  });

  it('refuses ids that are not one', () => {
    expect(decodeRecordId('abc')).toBeUndefined();
    expect(decodeRecordId(':abc')).toBeUndefined();
    expect(decodeRecordId('incidents:')).toBeUndefined();
  });

  it('titles a record by number and subject, whichever it has', () => {
    expect(recordTitle({ IncidentNumber: 10244, Subject: 'Printer' })).toBe('#10244 Printer');
    expect(recordTitle({ Subject: 'Printer' })).toBe('Printer');
    expect(recordTitle({ AssignmentID: 'T-9' })).toBe('#T-9');
    expect(recordTitle({})).toBe('Untitled record');
  });

  it('summarises with the fields that tell two similar records apart', () => {
    expect(recordSummary({ Status: 'Active', Priority: 3, Owner: '' })).toBe(
      'Status: Active · Priority: 3',
    );
  });
});

describe('search', () => {
  it('fans out across objects and returns fetchable ids', async () => {
    const { search } = tools({
      incidents: { value: [{ RecId: 'i1', IncidentNumber: 1, Subject: 'Printer', Status: 'Active' }] },
      servicereqs: { value: [{ RecId: 's1', ServiceReqNumber: 7, Subject: 'New printer' }] },
    });

    const result = body(await search.handler({ query: 'printer' }));

    expect(result.results).toEqual([
      { id: 'incidents:i1', title: '#1 Printer', text: 'Status: Active' },
      { id: 'servicereqs:s1', title: '#7 New printer', text: '' },
    ]);
  });

  it('searches the three default objects', async () => {
    const { search, urls } = tools({});

    const result = body(await search.handler({ query: 'x' }));

    expect(result.searched).toEqual(['incidents', 'servicereqs', 'changes']);
    expect(urls.filter((url) => url.includes('$search=x'))).toHaveLength(3);
  });

  it('reports an object it could not read instead of hiding the others', async () => {
    const { search } = tools({
      incidents: { value: [{ RecId: 'i1', Subject: 'Printer' }] },
      changes: new Error('403 forbidden'),
    });

    const result = body(await search.handler({ query: 'printer' }));

    expect(result.results).toHaveLength(1);
    expect(JSON.stringify(result.skipped)).toContain('403');
  });

  it('drops a row with no RecId — it could not be fetched back', async () => {
    const { search } = tools({ incidents: { value: [{ Subject: 'orphan' }] } });

    expect(body(await search.handler({ query: 'orphan' })).results).toEqual([]);
  });
});

describe('fetch', () => {
  it('reads the record a search id points at', async () => {
    const { fetch: fetchTool } = tools({
      "incidents('i1')": { RecId: 'i1', IncidentNumber: 1, Subject: 'Printer' },
    });

    const result = body(await fetchTool.handler({ id: 'incidents:i1' }));

    expect(result).toMatchObject({
      id: 'incidents:i1',
      title: '#1 Printer',
      metadata: { object: 'incidents', recId: 'i1' },
    });
  });

  it('explains an id that did not come from search', async () => {
    const { fetch: fetchTool } = tools({});

    const result = await fetchTool.handler({ id: '8E71E727DD5045C7B11EF634233437F1' });

    expect(result.isError).toBe(true);
  });

  it('reports a record that is not there', async () => {
    const { fetch: fetchTool } = tools({});

    const result = await fetchTool.handler({ id: 'incidents:gone' });

    expect(result.isError).toBe(true);
  });
});
