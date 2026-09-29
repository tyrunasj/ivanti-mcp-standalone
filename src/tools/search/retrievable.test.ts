// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
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
  const deps = { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS };
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

  /**
   * Ten hits an object and twenty-five in all, cut with nothing saying so: a list of ten reads as
   * "the matches". Ivanti's count is asked for and reported per object.
   */
  it('reports how much each object matched, and that the answer was cut', async () => {
    const hits = (prefix: string) =>
      Array.from({ length: 10 }, (_, i) => ({ RecId: `${prefix}${String(i)}`, Subject: 'Printer' }));
    const { search, urls } = tools({
      incidents: { value: hits('i'), '@odata.count': 48 },
      servicereqs: { value: hits('s'), '@odata.count': 10 },
      changes: { value: hits('c'), '@odata.count': 12 },
    });

    const result = body(await search.handler({ query: 'printer' }));

    expect(urls.every((url) => url.includes('$count=true'))).toBe(true);
    expect(result.results).toHaveLength(25);
    expect(result.perObject).toEqual([
      { object: 'incidents', matched: 48, shown: 10 },
      { object: 'servicereqs', matched: 10, shown: 10 },
      // The overall cap took five of these, and that is said too.
      { object: 'changes', matched: 12, shown: 5 },
    ]);
    expect(result.truncated).toBe(true);
    expect(String(result.truncatedNote)).toContain('NOT ALL THE MATCHES');
  });

  it('says nothing was cut when nothing was', async () => {
    const { search } = tools({
      incidents: { value: [{ RecId: 'i1', Subject: 'Printer' }], '@odata.count': 1 },
    });

    const result = body(await search.handler({ query: 'printer' }));

    expect(result.truncated).toBe(false);
    expect(result).not.toHaveProperty('truncatedNote');
  });

  it('marks a count Ivanti did not send as the rows alone', async () => {
    const { search } = tools({ incidents: { value: [{ RecId: 'i1', Subject: 'Printer' }] } });

    const perObject = body(await search.handler({ query: 'printer' })).perObject as unknown as {
      object: string;
      matchedIsExact?: boolean;
    }[];

    expect(perObject.find((entry) => entry.object === 'incidents')?.matchedIsExact).toBe(false);
    // Ivanti's empty body is its way of saying "nothing matched" — a real zero, not a floor.
    expect(perObject.find((entry) => entry.object === 'changes')).toEqual({
      object: 'changes',
      matched: 0,
      shown: 0,
    });
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

  /**
   * The object half of an id is the caller's text, and the route interpolates an entity set raw:
   * this id passed an open gate and sent an authenticated GET to `/api/rest/X('1')`.
   */
  it.each([
    ['../../rest/X:1'],
    ['incidents/../../rest/X:1'],
    ["incidents:i1')/x"],
  ])('refuses %s without sending anything', async (id) => {
    const { fetch: fetchTool, urls } = tools({ "incidents('i1')": { RecId: 'i1' } });

    const result = await fetchTool.handler({ id });

    expect(result.isError).toBe(true);
    expect(urls).toEqual([]);
  });

  it('resolves the object before building a URL from it', async () => {
    // A well-formed name that is not an object is refused by the catalog, with suggestions,
    // rather than becoming a path segment.
    const { fetch: fetchTool, urls } = tools({});

    const result = await fetchTool.handler({ id: 'incidentz:abc' });

    expect(result.isError).toBe(true);
    expect(urls).toEqual([]);
  });

  it('reads the catalog’s entity set, whatever spelling the id used', async () => {
    const { fetch: fetchTool, urls } = tools({ "incidents('i1')": { RecId: 'i1', Subject: 'x' } });

    await fetchTool.handler({ id: 'Incident:i1' });

    expect(urls[0]).toContain("/businessobject/incidents('i1')");
  });
});
