import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, entityFixture, field } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { createCreateRecordTool } from './create-record.js';
import { createDeleteRecordTool } from './delete-record.js';
import { createUpdateRecordTool } from './update-record.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const INCIDENT = entityFixture('incident', {
  fields: [field('Subject'), field('Status', { validated: true })],
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
  return { urls, deps: { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false } };
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
