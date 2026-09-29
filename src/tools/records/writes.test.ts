// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, entityFixture, field } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { IvantiApiError } from '../../ivanti/http/errors.js';
import { ANONYMOUS } from '../../auth/identity.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import type { CallContext } from '../tool-definition.js';
import { createCreateRecordTool } from './create-record.js';
import { createDeleteRecordTool } from './delete-record.js';
import { createUpdateRecordTool } from './update-record.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const INCIDENT = entityFixture('incident', {
  fields: [
    field('RecId'),
    field('Subject'),
    field('Status', { validated: true }),
    field('LastModBy'),
    field('CreatedBy'),
    field('ProfileLink'),
    field('ProfileLink_RecID'),
    field('ProfileLink_Category'),
  ],
});

const FORM_CHAIN = {
  GetRoleWorkspaces: {
    Workspaces: [
      { ID: 'Incident#', Name: 'Incident', LayoutName: 'L', Profile: 'ObjectWorkspace' },
    ],
  },
  GetWorkspaceData: { ObjectId: 'Incident#', LayoutData: { newRecordViews: { 'Incident#': 'v' } } },
  FindFormViewData: {
    formDef: {
      FormMeta: { Name: 'F' },
      TableMeta: {
        TableRef: 'Incident#',
        ValidatedFields: { Status: { ValidatedIdFieldRef: 'Status_Valid' } },
      },
    },
  },
  GetFormDefaultData: { Data: { Objects: { t1: { Values: { Status: '' } } } } },
  GetFormValidationListData: {
    Status: { FieldMap: { Status: 0, RecId: 1 }, Data: [['Active', 'rec-active']] },
  },
};

const text = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
};
const body = (result: CallToolResult): Record<string, never> =>
  JSON.parse(text(result) || '{}') as Record<string, never>;

const deps = (responses: Record<string, unknown>) => {
  const { connection, urls } = connectionFixture({
    entities: { incident: INCIDENT },
    capability: { tier: 'session', identity: { role: 'Admin' } },
    sessionCalls: FORM_CHAIN,
    responses,
  });
  return { urls, deps: { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS } };
};

describe('create_record', () => {
  it('writes the identifier beside a validated value and confirms what stored', async () => {
    const { deps: d, urls } = deps({
      'POST incidents': { RecId: 'new-1', Subject: 'Printer jam', Status: 'Active' },
      "incidents('new-1')": { RecId: 'new-1', Status: 'Active', Status_Valid: 'rec-active' },
    });

    const result = body(
      await createCreateRecordTool(d).handler({
        object: 'Incidents',
        fields: { Subject: 'Printer jam', Status: 'Active' },
      }),
    );

    expect(result).toMatchObject({ object: 'incidents', recId: 'new-1' });
    expect(urls.some((url) => url.startsWith('POST'))).toBe(true);
    // The read-back is the point: a write Ivanti accepted but did not store is not a success.
    expect(urls.some((url) => url.startsWith('GET') && url.includes("incidents('new-1')"))).toBe(true);
  });

  it('refuses a value that is not on the list, before writing anything', async () => {
    const { deps: d, urls } = deps({ 'POST incidents': { RecId: 'new-1' } });

    const result = await createCreateRecordTool(d).handler({
      object: 'Incidents',
      fields: { Status: 'Nearly Done' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Allowed: Active');
    expect(urls.some((url) => url.startsWith('POST'))).toBe(false);
  });

  it('reports a create that came back without a RecId rather than claiming success', async () => {
    const { deps: d } = deps({});

    const result = await createCreateRecordTool(d).handler({
      object: 'Incidents',
      fields: { Subject: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no evidence a record was stored');
  });

  it('fails when the validated value did not take', async () => {
    const { deps: d } = deps({
      'POST incidents': { RecId: 'new-1' },
      // Ivanti accepted the write and stored the old value.
      "incidents('new-1')": { RecId: 'new-1', Status: 'Logged' },
    });

    const result = await createCreateRecordTool(d).handler({
      object: 'Incidents',
      fields: { Status: 'Active' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("wrote 'Active', stored 'Logged'");
  });
});

describe('update_record', () => {
  it('patches only what it was given and says so', async () => {
    const { deps: d, urls } = deps({
      'PATCH incidents': { RecId: 'abc', Subject: 'Changed' },
      "incidents('abc')": { RecId: 'abc', Subject: 'Changed' },
    });

    const result = body(
      await createUpdateRecordTool(d).handler({
        object: 'Incidents',
        recordId: 'abc',
        fields: { Subject: 'Changed' },
      }),
    );

    expect(result).toMatchObject({ recId: 'abc', changed: ['Subject'] });
    expect(urls.filter((url) => url.startsWith('PATCH'))).toHaveLength(1);
  });

  it('reads the form once and reuses it, rather than per write', async () => {
    const { deps: d, urls } = deps({ 'PATCH incidents': { RecId: 'abc' } });

    await createUpdateRecordTool(d).handler({
      object: 'Incidents',
      recordId: 'abc',
      fields: { Subject: 'Changed' },
    });
    await createUpdateRecordTool(d).handler({
      object: 'Incidents',
      recordId: 'abc',
      fields: { Subject: 'Again' },
    });

    // The form is the authority on what is validated, so it is consulted — but only once.
    expect(urls.filter((url) => url.includes('FindFormViewData'))).toHaveLength(1);
  });
});

describe('a closed record', () => {
  it('is refused, because Ivanti marks it read-only and then writes to it anyway', async () => {
    // Measured: a PATCH against a closed incident answered 200 and stored the change. `ReadOnly`
    // is true for Closed and false for Resolved, which is the lifecycle rule — a resolved ticket
    // can still be reopened.
    const { deps: d } = deps({
      "incidents('abc')": { RecId: 'abc', Status: 'Closed', ReadOnly: true },
    });

    const update = await createUpdateRecordTool(d).handler({
      object: 'Incidents',
      recordId: 'abc',
      fields: { Subject: 'edited after closing' },
    });
    const remove = await createDeleteRecordTool(d).handler({
      object: 'Incidents',
      recordId: 'abc',
    });

    for (const result of [update, remove]) {
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('closed');
    }
  });

  it('is still writable while merely resolved', async () => {
    const { deps: d } = deps({
      "incidents('abc')": { RecId: 'abc', Status: 'Resolved', ReadOnly: false },
      'PATCH incidents': { RecId: 'abc', Subject: 'reopened work' },
    });

    const result = await createUpdateRecordTool(d).handler({
      object: 'Incidents',
      recordId: 'abc',
      fields: { Subject: 'reopened work' },
    });

    expect(result.isError).toBeUndefined();
  });
});

describe('delete_record', () => {
  it('deletes, then checks the record is actually gone', async () => {
    const { deps: d, urls } = deps({ "incidents('abc')": { RecId: 'abc', Subject: 'x' } });

    const result = body(
      await createDeleteRecordTool(d).handler({ object: 'Incidents', recordId: 'abc' }),
    );

    expect(result).toMatchObject({ recId: 'abc', deleted: true });
    expect(urls.filter((url) => url.startsWith('DELETE'))).toHaveLength(1);
  });

  it('says the record was never there rather than reporting a delete', async () => {
    const { deps: d, urls } = deps({});

    const result = await createDeleteRecordTool(d).handler({
      object: 'Incidents',
      recordId: 'gone',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('nothing was deleted');
    expect(urls.some((url) => url.startsWith('DELETE'))).toBe(false);
  });
});

/**
 * In `enduser`, whose record it is belongs to the server. Reads were scoped and creates stamped —
 * and then an update wrote whatever it was handed, so an end user could set their own ticket's
 * customer to a colleague and hand it over, or rewrite who filed it.
 */
describe('the fields that say whose record it is, in enduser', () => {
  const PERSON = {
    recId: 'E1',
    category: 'employee',
    displayName: 'Harold Sanders',
    loginId: 'HSanders',
    matchedOn: 'LoginID',
    provenance: 'asserted',
  } as const;

  const MINE = { RecId: 'i1', Subject: 'Mine', ProfileLink_RecID: 'E1', ProfileLink_Category: 'Employee' };

  function enduser(ownRecordsOnly = true) {
    const { connection, urls } = connectionFixture({
      entities: { incident: INCIDENT, employee: {} },
      responses: {
        'POST incidents': { RecId: 'new-1' },
        'PATCH incidents': MINE,
        "incidents('new-1')": { RecId: 'new-1', Subject: 'x' },
        "incidents('i1')": MINE,
        // The customer link is discovered from sampled rows; this one points at an employee.
        incidents: { value: [MINE] },
        employees: { value: [] },
      },
    });
    const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
    context.pin?.pin({ ...PERSON });
    const d = { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly, actions: OPEN_ACTIONS };
    return { d, urls, context };
  }

  it.each([
    ['the customer link, handed to someone else', { ProfileLink_RecID: 'E2', ProfileLink_Category: 'Employee' }],
    ['the customer link, in another spelling', { profilelink_recid: 'E2' }],
    ['the link by its bare name', { ProfileLink: 'Becky Smith' }],
    ['who filed it', { CreatedBy: 'BSmith' }],
    // Even their own id: the record is already theirs, and there is nothing there to change.
    ['the customer link, set to themselves', { ProfileLink_RecID: 'E1' }],
  ])('refuses an update to %s, and writes nothing', async (_label, fields) => {
    const { d, urls, context } = enduser();

    const result = await createUpdateRecordTool(d).handler(
      { object: 'Incidents', recordId: 'i1', fields: { Subject: 'x', ...fields } },
      context,
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('whose record this is');
    expect(text(result)).toContain('Nothing was written');
    expect(urls.some((url) => url.startsWith('PATCH'))).toBe(false);
  });

  it('still lets them change the rest of their own record', async () => {
    const { d, urls, context } = enduser();

    const result = await createUpdateRecordTool(d).handler(
      { object: 'Incidents', recordId: 'i1', fields: { Subject: 'Mine' } },
      context,
    );

    expect(result.isError).toBeUndefined();
    expect(urls.some((url) => url.startsWith('PATCH'))).toBe(true);
  });

  it('leaves the ownership fields to an analyst in full mode', async () => {
    const { d, urls, context } = enduser(false);

    await createUpdateRecordTool(d).handler(
      { object: 'Incidents', recordId: 'i1', fields: { ProfileLink_RecID: 'E1' } },
      context,
    );

    expect(urls.some((url) => url.startsWith('PATCH'))).toBe(true);
  });

  // The stamp was merged over the caller's fields by exact key, so `profilelink_recid` rode
  // alongside `ProfileLink_RecID` and which one Ivanti kept was Ivanti's choice.
  it.each([
    ['in another spelling', { profilelink_recid: 'E2' }],
    ['by the exact key', { ProfileLink_RecID: 'E2' }],
    ['as the author', { CreatedBy: 'BSmith' }],
  ])('refuses a create that names someone else %s', async (_label, fields) => {
    const { d, urls, context } = enduser();

    const result = await createCreateRecordTool(d).handler(
      { object: 'Incidents', fields: { Subject: 'x', ...fields } },
      context,
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('filed for the person you are acting for automatically');
    expect(urls.some((url) => url.startsWith('POST'))).toBe(false);
  });

  it('accepts a create that names them, and sends the stamp once', async () => {
    const { d, context } = enduser();
    const sent = bodies(d);

    const result = await createCreateRecordTool(d).handler(
      { object: 'Incidents', fields: { Subject: 'x', profilelink_recid: 'e1' } },
      context,
    );

    expect(result.isError).toBeUndefined();
    expect(sent.find((entry) => entry.method === 'POST')?.body).toEqual({
      Subject: 'x',
      ProfileLink_RecID: 'E1',
      ProfileLink_Category: 'Employee',
      CreatedBy: 'HSanders',
    });
  });
});

/** Every request body the tool sent, by method — the fixture records URLs only. */
function bodies(d: ReturnType<typeof deps>['deps']): { method: string; body: unknown }[] {
  const sent: { method: string; body: unknown }[] = [];
  const request = d.connection.transport.request.bind(d.connection.transport);
  vi.spyOn(d.connection.transport, 'request').mockImplementation((url, init) => {
    if (init?.body !== undefined) sent.push({ method: init.method ?? 'GET', body: init.body });
    return request(url, init);
  });
  return sent;
}

/**
 * A field name in the wrong case used to pass the name check and miss everything after it: the
 * picklist, the identifier beside the value, and the read-back. `status: 'Bogus'` went out
 * unresolved and was reported as a success.
 */
describe('a field name in the wrong case', () => {
  it('is resolved like the right one, so a value not on the list is refused', async () => {
    const { deps: d, urls } = deps({ 'PATCH incidents': { RecId: 'abc' } });

    const result = await createUpdateRecordTool(d).handler({
      object: 'Incidents',
      recordId: 'abc',
      fields: { status: 'Bogus' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Allowed: Active');
    expect(urls.some((url) => url.startsWith('PATCH'))).toBe(false);
  });

  it('is sent in the schema spelling, with its identifier beside it', async () => {
    const { deps: d } = deps({
      'PATCH incidents': { RecId: 'abc' },
      "incidents('abc')": { RecId: 'abc', Status: 'Active', Status_Valid: 'rec-active' },
    });
    const sent = bodies(d);

    const result = await createUpdateRecordTool(d).handler({
      object: 'Incidents',
      recordId: 'abc',
      fields: { status: 'active' },
    });

    expect(result.isError).toBeUndefined();
    expect(body(result)).toMatchObject({ changed: ['Status'] });
    expect(sent.find((entry) => entry.method === 'PATCH')?.body).toEqual({
      Status: 'Active',
      Status_Valid: 'rec-active',
    });
  });

  it('is refused when the same field arrives twice in two spellings', async () => {
    const { deps: d, urls } = deps({ 'POST incidents': { RecId: 'new-1' } });

    const result = await createCreateRecordTool(d).handler({
      object: 'Incidents',
      fields: { Subject: 'one', subject: 'two' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('`Subject` and `subject` name ONE field');
    expect(urls.some((url) => url.startsWith('POST'))).toBe(false);
  });
});

/**
 * Both descriptions promise a write Ivanti accepted but did not store is reported. Only validated
 * fields used to be read back, so a free field Ivanti replaced was reported as written.
 */
describe('reading back a free field', () => {
  it('fails a create whose free field did not store, saying the record exists', async () => {
    const { deps: d } = deps({
      'POST incidents': { RecId: 'new-1', Subject: 'Printer jam' },
      "incidents('new-1')": { RecId: 'new-1', Subject: 'Something else' },
    });

    const result = await createCreateRecordTool(d).handler({
      object: 'Incidents',
      fields: { Subject: 'Printer jam' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Subject: wrote 'Printer jam', stored 'Something else'");
    expect(text(result)).toContain('The record exists');
  });

  it('fails an update whose free field did not store', async () => {
    const { deps: d } = deps({
      'PATCH incidents': { RecId: 'abc', Subject: 'Changed' },
      "incidents('abc')": { RecId: 'abc', Subject: 'Unchanged' },
    });

    const result = await createUpdateRecordTool(d).handler({
      object: 'Incidents',
      recordId: 'abc',
      fields: { Subject: 'Changed' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Subject: wrote 'Changed', stored 'Unchanged'");
  });

  // Measured: the PATCH response reports `LastModBy` changed while the record keeps the session
  // account. So the confirmation shows the read-back, and names the field rather than failing.
  it('reports a field Ivanti stamps itself, and shows what the record holds', async () => {
    const { deps: d } = deps({
      'PATCH incidents': { RecId: 'abc', Subject: 'x', LastModBy: 'jdoe' },
      "incidents('abc')": { RecId: 'abc', Subject: 'x', LastModBy: 'svc-account' },
    });

    const result = body(
      await createUpdateRecordTool(d).handler({
        object: 'Incidents',
        recordId: 'abc',
        fields: { Subject: 'x', LastModBy: 'jdoe' },
      }),
    );

    expect(result).toMatchObject({
      ignoredByIvanti: { LastModBy: 'svc-account' },
      record: { LastModBy: 'svc-account' },
    });
  });

  it('says which written fields it could not confirm', async () => {
    const { deps: d } = deps({
      'POST incidents': { RecId: 'new-1' },
      "incidents('new-1')": { RecId: 'new-1', Subject: 'x' },
    });

    const result = body(
      await createCreateRecordTool(d).handler({
        object: 'Incidents',
        fields: { Subject: 'x', CreatedBy: 'jdoe' },
      }),
    );

    expect(result).toMatchObject({
      notConfirmed: ['CreatedBy — the read-back does not return this field'],
    });
  });
});

/** The refusals Ivanti gives a write, each turned into what the caller should do next. */
describe('a write Ivanti refuses', () => {
  const required = new IvantiApiError(
    { status: 400, method: 'POST', url: 'incidents', body: 'Required field Incident.Category value must be provided' },
  );

  it('names the required field a create was refused for', async () => {
    const { deps: d } = deps({ 'POST incidents': required });

    const result = await createCreateRecordTool(d).handler({
      object: 'Incidents',
      fields: { subject: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('it requires');
    expect(text(result)).toContain('Category');
  });

  it('names the required field an update was refused for', async () => {
    const { deps: d } = deps({ 'PATCH incidents': required });

    const result = await createUpdateRecordTool(d).handler({
      object: 'Incidents',
      recordId: 'abc',
      fields: { Subject: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Category');
  });

  it('names the subtypes when a create aimed at a base type is refused', async () => {
    const { connection } = connectionFixture({
      entities: { task: {}, task__assignment: {} },
      responses: {
        'POST tasks': new IvantiApiError({ status: 500, method: 'POST', url: 'tasks', body: '' }),
      },
    });
    const d = { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS };

    const result = await createCreateRecordTool(d).handler({
      object: 'Tasks',
      fields: { Subject: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('task__assignment');
  });

  it('passes any other refusal through as Ivanti gave it', async () => {
    const { deps: d } = deps({
      'POST incidents': new IvantiApiError({ status: 403, method: 'POST', url: 'incidents', body: 'no' }),
    });

    const result = await createCreateRecordTool(d).handler({
      object: 'Incidents',
      fields: { Subject: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('(403)');
  });
});

describe('delete_record, when it does not go to plan', () => {
  const record = { RecId: 'abc', Subject: 'x' };

  /** Answers each GET in turn from `reads`, and swallows the DELETE without doing it. */
  function scripted(reads: (Record<string, unknown> | Error | undefined)[]) {
    const { deps: d, urls } = deps({});
    vi.spyOn(d.connection.transport, 'request').mockImplementation((url, init) => {
      const method = init?.method ?? 'GET';
      urls.push(`${method} ${url}`);
      if (method !== 'GET') return Promise.resolve(undefined as never);
      const next = reads.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as never);
    });
    return { d, urls };
  }

  const failure = (status: number, detail = 'boom') =>
    new IvantiApiError({ status, method: 'GET', url: "incidents('abc')", body: detail });

  it('reports a delete Ivanti accepted but did not do', async () => {
    const { d } = scripted([record, record, record]);

    const result = await createDeleteRecordTool(d).handler({ object: 'Incidents', recordId: 'abc' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('still there');
  });

  it('calls a record gone when the check afterwards answers not-found', async () => {
    const { d } = scripted([record, record, failure(404)]);

    const result = body(
      await createDeleteRecordTool(d).handler({ object: 'Incidents', recordId: 'abc' }),
    );

    expect(result).toMatchObject({ deleted: true });
  });

  it('does not delete when the record cannot be read for a reason other than absence', async () => {
    const { d, urls } = scripted([record, failure(500)]);

    const result = await createDeleteRecordTool(d).handler({ object: 'Incidents', recordId: 'abc' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('(500)');
    expect(urls.some((url) => url.startsWith('DELETE'))).toBe(false);
  });

  it('does not claim a delete it could not check afterwards', async () => {
    const { d } = scripted([record, record, failure(502)]);

    const result = await createDeleteRecordTool(d).handler({ object: 'Incidents', recordId: 'abc' });

    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain('deleted');
  });

  it('reads a record that is gone before the delete as gone, and deletes nothing', async () => {
    const { d, urls } = scripted([record, failure(404)]);

    const result = await createDeleteRecordTool(d).handler({ object: 'Incidents', recordId: 'abc' });

    expect(text(result)).toContain('nothing was deleted');
    expect(urls.some((url) => url.startsWith('DELETE'))).toBe(false);
  });
});
