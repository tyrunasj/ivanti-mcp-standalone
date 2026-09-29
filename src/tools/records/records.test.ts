// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import type { Logger } from '../../logger.js';
import { createCountRecordsTool } from './count-records.js';
import { createGetRecordTool } from './get-record.js';
import { createGetRelatedRecordsTool } from './get-related-records.js';
import { createListRecordsTool } from './list-records.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import { ANONYMOUS } from '../../auth/identity.js';
import type { CallContext } from '../tool-definition.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const INCIDENT = {
  fields: [field('RecId'), field('Subject'), field('Status'), field('CreatedDateTime')],
  relationships: [
    { name: 'IncidentContainsTask', target: 'task' },
    { name: 'IncidentContainsJournal', target: 'journal' },
  ],
};

const ROW = { RecId: 'abc', IncidentNumber: 10244, Subject: 'Printer', Status: 'Active' };

const fixture = (responses: Record<string, unknown> = {}) => {
  const { connection, urls } = connectionFixture({ entities: { incident: INCIDENT }, responses });
  return { deps: { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS }, urls };
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

describe('get_record field echo', () => {
  it('says which requested names the record does not have, rather than dropping them', async () => {
    // Measured: a tester asked employee for `Manager` — which is `ManagerLink_RecID` here — and
    // the key simply vanished, which reads as "this record has no manager".
    const { deps } = fixture({ "incidents('abc')": ROW });

    const result = body(
      await createGetRecordTool(deps).handler({
        object: 'Incidents',
        recordId: 'abc',
        fields: 'Subject,NotAField',
      }),
    );

    expect(result['ignoredFields']).toEqual(['NotAField']);
    expect(String(result['note'])).toContain('do not report the value as absent');
  });

  it('stays quiet when every requested field is real', async () => {
    const { deps } = fixture({ "incidents('abc')": ROW });

    const result = body(
      await createGetRecordTool(deps).handler({
        object: 'Incidents',
        recordId: 'abc',
        fields: 'Subject,Status',
      }),
    );

    expect(result).not.toHaveProperty('ignoredFields');
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

  it('projects to a compact set by default — whole records are enormous', async () => {
    const wide = { ...ROW, Symptom: 'x'.repeat(500), OwnerTeam: 'Service Desk' };
    const { deps } = fixture({ incidents: { value: [wide] } });

    const result = body(await createListRecordsTool(deps).handler({ object: 'Incidents' }));

    expect(Object.keys((result.rows as Record<string, unknown>[])[0] ?? {})).toEqual([
      'RecId',
      'IncidentNumber',
      'Subject',
      'Status',
      'OwnerTeam',
    ]);
    expect(String(result.fields)).toContain('compact default set');
  });

  it('returns whole records when the caller asks for them outright', async () => {
    const wide = { ...ROW, Symptom: 'the whole story' };
    const { deps } = fixture({ incidents: { value: [wide] } });

    const result = body(await createListRecordsTool(deps).handler({ object: 'Incidents', fields: '*' }));

    expect((result.rows as Record<string, unknown>[])[0]).toEqual(wide);
    expect(result.fields).toBeUndefined();
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

  it('refuses an unknown orderBy field rather than letting Ivanti answer 204', async () => {
    // Measured live: `$orderby=CreatedDate asc` answers 204 on a set of 548 incidents, which
    // readCollection correctly reads as no rows. Nothing downstream can tell that apart from
    // "there are none", so it has to be caught here.
    const { deps, urls } = fixture({ incidents: { value: [] } });

    const result = await createListRecordsTool(deps).handler({
      object: 'Incidents',
      orderBy: 'CreatedDate asc',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('CreatedDateTime');
    // Nothing was sent: the point is to refuse before the request, not to explain afterwards.
    expect(urls).toHaveLength(0);
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

    const result = body(await createCountRecordsTool(deps).handler({ object: 'Incidents' }));

    expect(result).toMatchObject({ object: 'incidents', count: 0, exact: true });
    // And it says what the zero means, because this is the path a real zero takes — Ivanti
    // answers an empty body rather than a count, and a bare `{count: 0}` reads exactly as
    // authoritative as one that was filtered against validated field names.
    expect(String(result['note'])).toContain('THIS IS A REAL ZERO');
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

describe('get_related_records caps what it reads', () => {
  it('reads one row past the cap and says the answer is not all of them', async () => {
    // There was no `$top` at all, and no `skip` to page with: a relationship with a thousand rows
    // came back whole, and a bare cap would have cut it silently.
    const many = Array.from({ length: 60 }, (_, i) => ({ RecId: `t${String(i)}`, Subject: 'x' }));
    const { deps, urls } = fixture({ IncidentContainsTask: { value: many } });

    const result = body(
      await createGetRelatedRecordsTool(deps).handler({
        object: 'Incidents',
        recordId: 'abc',
        relationship: 'IncidentContainsTask',
      }),
    );

    expect(decodeURIComponent(urls[0] ?? '')).toContain('$top=51');
    expect(result).toMatchObject({ returned: 50, hasMore: true });
    expect(String(result['truncated'])).toContain('NOT ALL OF THEM');
  });

  it('says there is no more when there is not', async () => {
    const { deps } = fixture({ IncidentContainsTask: { value: [{ RecId: 't1' }] } });

    const result = body(
      await createGetRelatedRecordsTool(deps).handler({
        object: 'Incidents',
        recordId: 'abc',
        relationship: 'IncidentContainsTask',
      }),
    );

    expect(result).toMatchObject({ returned: 1, hasMore: false });
    expect(result).not.toHaveProperty('truncated');
  });
});

/**
 * The parent being the caller's says nothing about whose records a relationship reaches, and a
 * navigation property cannot be filtered — so the rows themselves are scoped, by a rule decided
 * from the TARGET before anything is read.
 */
describe('get_related_records in enduser mode', () => {
  const PERSON = {
    recId: 'E1',
    category: 'employee',
    displayName: 'Harold Sanders',
    loginId: 'HSanders',
    matchedOn: 'LoginID',
    provenance: 'asserted',
  } as const;

  const pinned = (): CallContext => {
    const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
    context.pin?.pin({ ...PERSON });
    return context;
  };

  const scoped = (responses: Record<string, unknown> = {}) => {
    const { connection, urls } = connectionFixture({
      entities: {
        incident: {
          fields: [
            field('RecId'),
            field('Subject'),
            field('ProfileLink_RecID'),
            field('ProfileLink_Category'),
          ],
          relationships: [
            { name: 'IncidentContainsTask', target: 'task' },
            { name: 'IncidentLinksIncident', target: 'incident' },
            { name: 'IncidentAssociatesCI', target: 'ci' },
            { name: 'IncidentContainsJournal', target: 'journal' },
          ],
        },
        task: {
          fields: [
            field('RecId'),
            field('Subject'),
            field('ParentLink_RecID'),
            field('ParentLink_Category'),
          ],
        },
        ci: { fields: [field('RecId'), field('Name')] },
        journal: { fields: [field('RecId'), field('Subject'), field('ParentLink_RecID')] },
        employee: {},
      },
      responses: {
        // Each relationship before the bare record: the fixture matches by URL substring, in
        // declaration order. An override keeps its key's place and replaces only the value.
        "incidents('i1')/IncidentContainsTask": {
          value: [
            { RecId: 't1', Subject: 'Replace toner', ParentLink_RecID: 'I1' },
            { RecId: 't2', Subject: 'Elsewhere', ParentLink_RecID: 'OTHER' },
          ],
        },
        "incidents('i1')/IncidentLinksIncident": {
          value: [
            { RecId: 'i2', Subject: 'Mine too', ProfileLink_RecID: 'e1', ProfileLink_Category: 'Employee' },
            { RecId: 'i3', Subject: 'Not mine', ProfileLink_RecID: 'OTHER', ProfileLink_Category: 'Employee' },
          ],
        },
        "incidents('i1')/IncidentAssociatesCI": { value: [{ RecId: 'c1', Name: 'Printer 7' }] },
        "incidents('i1')/IncidentContainsJournal": { value: [{ RecId: 'j1', Subject: 'internal' }] },
        "incidents('i1')": { RecId: 'i1', ProfileLink_RecID: 'E1', ProfileLink_Category: 'Employee' },
        incidents: {
          value: [{ RecId: 'i1', ProfileLink_RecID: 'E1', ProfileLink_Category: 'Employee' }],
        },
        employees: { value: [] },
        ...responses,
      },
    });
    return {
      urls,
      tool: createGetRelatedRecordsTool({
        connection,
        gate: OPEN_GATE,
        logger: logger(),
        ownRecordsOnly: true,
        actions: OPEN_ACTIONS,
      }),
    };
  };

  it('keeps only the caller’s own rows when the target belongs to people', async () => {
    const { tool } = scoped();

    const result = body(
      await tool.handler(
        { object: 'Incidents', recordId: 'i1', relationship: 'IncidentLinksIncident', fields: 'Subject' },
        pinned(),
      ),
    );

    expect(result['rows']).toEqual([{ RecId: 'i2', Subject: 'Mine too' }]);
    expect(result).toMatchObject({ scopedTo: 'Harold Sanders', returned: 1 });
    expect(String(result['showing'])).toContain('own');
  });

  it('keeps only the rows that hang off this record when the target is a child', async () => {
    const { tool } = scoped();

    const result = body(
      await tool.handler(
        { object: 'Incidents', recordId: 'i1', relationship: 'IncidentContainsTask', fields: 'Subject' },
        pinned(),
      ),
    );

    expect(result['rows']).toEqual([{ RecId: 't1', Subject: 'Replace toner' }]);
    expect(result).toMatchObject({ scopedTo: 'Harold Sanders' });
  });

  it('refuses a target that neither belongs to a person nor hangs off the record, unread', async () => {
    const { tool, urls } = scoped();

    const result = await tool.handler(
      { object: 'Incidents', recordId: 'i1', relationship: 'IncidentAssociatesCI' },
      pinned(),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Refusing rather than showing all of them');
    expect(urls.some((url) => url.includes('IncidentAssociatesCI'))).toBe(false);
  });

  it('refuses the journal even where the gate allows it, and points to list_notes', async () => {
    // A traversal cannot tell a note written for the customer from an agent's internal one.
    const { tool, urls } = scoped();

    const result = await tool.handler(
      { object: 'Incidents', recordId: 'i1', relationship: 'IncidentContainsJournal' },
      pinned(),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('list_notes');
    expect(urls.some((url) => url.includes('IncidentContainsJournal'))).toBe(false);
  });

  it('does not call a zero it produced by filtering a real zero', async () => {
    const { tool } = scoped({
      "incidents('i1')/IncidentLinksIncident": {
        value: [{ RecId: 'i3', ProfileLink_RecID: 'OTHER', ProfileLink_Category: 'Employee' }],
      },
    });

    const result = body(
      await tool.handler(
        { object: 'Incidents', recordId: 'i1', relationship: 'IncidentLinksIncident' },
        pinned(),
      ),
    );

    expect(result).toMatchObject({ returned: 0, rows: [] });
    expect(String(result['note'])).toContain('not the same as none existing');
    expect(String(result['note'])).not.toContain('REAL ZERO');
  });
});
