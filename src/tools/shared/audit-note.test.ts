// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { connectionFixture, entityFixture, field } from '../../ivanti/connection.fixture.js';
import { ANONYMOUS } from '../../auth/identity.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import type { Logger } from '../../logger.js';
import { createDeleteRecordTool } from '../records/delete-record.js';
import { createUpdateRecordTool } from '../records/update-record.js';
import { createLinkRecordsTool } from '../relationships/link-records.js';
import type { CallContext } from '../tool-definition.js';
import { OPEN_ACTIONS } from './action-gate.js';
import { auditArguments, describeChange, describeRecord, justificationOf } from './audit-note.js';
import type { IvantiToolDeps } from './deps.js';
import { OPEN_GATE } from './object-gate.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const text = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
};
const body = (result: CallToolResult): Record<string, unknown> =>
  JSON.parse(text(result) || '{}') as Record<string, unknown>;

const JOURNAL = { name: 'IncidentContainsJournal', target: 'journal' };
const FIELDS = [field('RecId'), field('Subject'), field('ParentLink_RecID'), field('ParentLink_Category')];
const WHY = 'The customer confirmed the printer was replaced.';

const NOTE_STORED = {
  journal__notess: { value: [{ RecId: 'n1', ParentLink_RecID: 'abc', PublishToWeb: false }] },
  'POST journal__notess': { RecId: 'n1', NotesBody: 'x' },
};

function setup(
  responses: Record<string, unknown>,
  options: {
    audit?: boolean;
    relationships?: { name: string; target: string }[];
    /** Rows a relationship read answers with, in turn: before the link, then after it. */
    related?: unknown[][];
  } = {},
) {
  const { connection, urls } = connectionFixture({
    entities: {
      incident: entityFixture('incident', { fields: FIELDS, relationships: options.relationships ?? [JOURNAL] }),
      task: entityFixture('task', { fields: FIELDS, relationships: [{ name: 'TaskContainsJournal', target: 'journal' }] }),
      journal__notes: {},
    },
    responses,
  });
  const real = connection.transport.request.bind(connection.transport);
  const posted = vi.spyOn(connection.transport, 'request').mockImplementation(((url: string, init?: { method?: string }) =>
    options.related !== undefined && url.endsWith('/IncidentAssociatesCI') && (init?.method ?? 'GET') === 'GET'
      ? Promise.resolve({ value: options.related.shift() ?? [] })
      : real(url, init)));
  const deps: IvantiToolDeps = {
    connection,
    gate: OPEN_GATE,
    logger: logger(),
    ownRecordsOnly: false,
    actions: OPEN_ACTIONS,
    auditNote: options.audit ?? true,
  };
  /** What was POSTed to the journal, in order. */
  const notes = (): Record<string, unknown>[] =>
    posted.mock.calls
      .filter(([url, init]) => url.includes('journal__notess') && init?.method === 'POST')
      .map(([, init]) => init?.body as Record<string, unknown>);
  return { deps, urls, notes };
}

function pinned(): CallContext {
  const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
  context.pin?.pin({
    recId: 'E1',
    category: 'employee',
    displayName: 'Harold Sanders',
    loginId: 'HSanders',
    matchedOn: 'LoginID',
    provenance: 'asserted',
  });
  return context;
}

describe('the justification argument', () => {
  it('is required and substantial when notes are on, and absent when they are off', () => {
    const { deps } = setup({});
    const schema = z.object(auditArguments(deps));

    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ justification: 'n/a' }).success).toBe(false);
    expect(schema.parse({ justification: `  ${WHY}  ` })).toEqual({ justification: WHY });

    expect(auditArguments({ ...deps, auditNote: false })).toEqual({});
    expect(auditArguments({ ...deps, auditNote: undefined })).toEqual({});
  });

  it('is read back from arguments typed before the setting was known', () => {
    expect(justificationOf({ justification: ` ${WHY} ` })).toBe(WHY);
    expect(justificationOf({ justification: '   ' })).toBeUndefined();
    expect(justificationOf({})).toBeUndefined();
  });
});

describe('how a change is worded', () => {
  it('shows the old value beside the new, clipped, and says when the old one was not read', () => {
    expect(describeChange('Status', 'Open', 'Resolved')).toBe('Status: Open → Resolved');
    expect(describeChange('Owner', null, 'Ann')).toBe('Owner: (empty) → Ann');
    expect(describeChange('Status', undefined, 'Resolved', false)).toBe('Status → Resolved');
    expect(describeChange('Notes', 'x', 'y'.repeat(500))).toHaveLength('Notes: x → '.length + 120);
  });

  it('names a record by its title when it has one, and always by its id', () => {
    expect(describeRecord('incident', 'abc', { Subject: 'Printer jam' })).toBe('incident abc (Printer jam)');
    expect(describeRecord('incident', 'abc')).toBe('incident abc');
    // The number is what the person reading the ticket knows it by.
    expect(describeRecord('incident', 'abc', { IncidentNumber: 11173, Subject: 'Printer jam' })).toBe(
      'incident 11173 (Printer jam)',
    );
  });
});

describe('update_record with notes on', () => {
  const responses = {
    'PATCH incidents': { RecId: 'abc', Subject: 'Printer replaced' },
    "incidents('abc')": { RecId: 'abc', Subject: 'Printer replaced' },
    ...NOTE_STORED,
  };

  it('leaves an internal note with the reason, once the change is confirmed', async () => {
    const { deps, notes, urls } = setup(responses);

    const result = body(
      await createUpdateRecordTool(deps).handler(
        { object: 'Incidents', recordId: 'abc', fields: { Subject: 'Printer replaced' }, justification: WHY } ,
        pinned(),
      ),
    );

    expect(result).toMatchObject({ changed: ['Subject'], auditNote: { noted: true, noteId: 'n1', visibleToCustomer: false } });
    expect(result['auditWarning']).toBeUndefined();

    const [note] = notes();
    expect(notes()).toHaveLength(1);
    expect(note).toMatchObject({ ParentLink_RecID: 'abc', PublishToWeb: false });
    expect(String(note?.['NotesBody'])).toContain(`Why: ${WHY}`);
    expect(String(note?.['NotesBody'])).toContain('Subject:');
    expect(String(note?.['NotesBody'])).toContain('in conversation with Harold Sanders');

    // After the write, never before: a note for a change that failed would describe nothing.
    const patch = urls.findIndex((url) => url.startsWith('PATCH'));
    const post = urls.findIndex((url) => url.startsWith('POST') && url.includes('journal__notess'));
    expect(post).toBeGreaterThan(patch);
  });

  it('is authored by the key\'s own account: no author is stamped, whoever is pinned', async () => {
    const { deps, notes } = setup(responses);

    await createUpdateRecordTool({ ...deps, ownRecordsOnly: false }).handler(
      { object: 'Incidents', recordId: 'abc', fields: { Subject: 'Printer replaced' }, justification: WHY },
      pinned(),
    );

    // `add_note` stamps the person in `enduser`; the audit note must carry nothing of the kind.
    expect(Object.keys(notes()[0] ?? {}).sort()).toEqual(
      ['NotesBody', 'ParentLink_Category', 'ParentLink_RecID', 'PublishToWeb', 'Subject'].sort(),
    );
  });

  it('reports a note that could not be left, and does not call the change a failure', async () => {
    const { deps } = setup({ ...responses, 'POST journal__notess': new Error('journal is locked') });

    const result = await createUpdateRecordTool(deps).handler(
      { object: 'Incidents', recordId: 'abc', fields: { Subject: 'Printer replaced' }, justification: WHY },
      pinned(),
    );

    expect(result.isError).toBeUndefined();
    expect(body(result)).toMatchObject({ changed: ['Subject'], auditNote: { noted: false } });
    expect(String(body(result)['auditWarning'])).toContain('was NOT left');
    expect(String(body(result)['auditWarning'])).toContain('add_note');
  });

  it('does not report a note that read back as being on a different record', async () => {
    const { deps } = setup({
      ...responses,
      journal__notess: { value: [{ RecId: 'n1', ParentLink_RecID: 'someone-elses' }] },
    });

    const result = body(
      await createUpdateRecordTool(deps).handler(
        { object: 'Incidents', recordId: 'abc', fields: { Subject: 'Printer replaced' }, justification: WHY } ,
        pinned(),
      ),
    );

    expect(result['auditNote']).toMatchObject({ noted: false });
    expect(result['auditWarning']).toBeDefined();
  });

  it('says there was nowhere to leave it, without a warning, on an object with no journal', async () => {
    const { deps, notes } = setup(responses, { relationships: [] });

    const result = body(
      await createUpdateRecordTool(deps).handler(
        { object: 'Incidents', recordId: 'abc', fields: { Subject: 'Printer replaced' }, justification: WHY } ,
        pinned(),
      ),
    );

    expect(result['auditNote']).toMatchObject({ noted: false });
    expect(result['auditWarning']).toBeUndefined();
    expect(notes()).toHaveLength(0);
  });

  it('writes no note and says nothing about one when the setting is off', async () => {
    const { deps, notes } = setup(responses, { audit: false });

    const result = body(
      await createUpdateRecordTool(deps).handler(
        { object: 'Incidents', recordId: 'abc', fields: { Subject: 'Printer replaced' } },
        pinned(),
      ),
    );

    expect(result['auditNote']).toBeUndefined();
    expect(notes()).toHaveLength(0);
  });
});

describe('delete_record with notes on', () => {
  it('leaves the note on the parent, because the record\'s own journal went with it', async () => {
    const { deps, notes } = setup({
      "tasks('t1')": {
        RecId: 't1',
        Subject: 'Swap toner',
        ParentLink_RecID: 'abc',
        ParentLink_Category: 'Incident',
      },
      ...NOTE_STORED,
    });

    const result = body(
      await createDeleteRecordTool(deps).handler(
        { object: 'Tasks', recordId: 't1', justification: 'Raised twice by mistake.' } ,
        pinned(),
      ),
    );

    expect(result).toMatchObject({ deleted: true, auditNote: { noted: true } });
    expect(notes()[0]).toMatchObject({ ParentLink_RecID: 'abc' });
    expect(String(notes()[0]?.['NotesBody'])).toContain('Deleted task t1 (Swap toner)');
  });

  it('has nowhere to leave it when the record had no parent, and says so', async () => {
    const { deps, notes } = setup({ "incidents('abc')": { RecId: 'abc', Subject: 'x' } });

    const result = body(
      await createDeleteRecordTool(deps).handler(
        { object: 'Incidents', recordId: 'abc', justification: 'Test data, cleaned up.' } ,
        pinned(),
      ),
    );

    expect(result).toMatchObject({ deleted: true, auditNote: { noted: false } });
    expect(result['auditWarning']).toBeUndefined();
    expect(notes()).toHaveLength(0);
  });
});

describe('link_records with notes on', () => {
  it('names the relationship and the record that was attached', async () => {
    const { deps, notes } = setup(
      { ...NOTE_STORED, 'PATCH IncidentAssociatesCI': { code: 'ISM_2000' } },
      { relationships: [JOURNAL, { name: 'IncidentAssociatesCI', target: 'ci' }], related: [[], [{ RecId: 'ci9' }]] },
    );
    const result = body(
      await createLinkRecordsTool(deps).handler(
        {
          object: 'Incidents',
          recordId: 'abc',
          relationship: 'IncidentAssociatesCI',
          targetId: 'ci9',
          justification: 'The outage is on this server.',
        } ,
        pinned(),
      ),
    );

    expect(result).toMatchObject({ linked: 'ci9', auditNote: { noted: true } });
    expect(String(notes()[0]?.['NotesBody'])).toContain('IncidentAssociatesCI: ci9 added');
  });
});
