import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, entityFixture, field } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { createGroupCountTool } from './group-count.js';
import { createPreviewDeleteTool } from './preview-delete.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const FORM_CHAIN = {
  GetRoleWorkspaces: {
    Workspaces: [{ ID: 'Incident#', Name: 'Incident', LayoutName: 'L', Profile: 'ObjectWorkspace' }],
  },
  GetWorkspaceData: { ObjectId: 'Incident#', LayoutData: { newRecordViews: { 'Incident#': 'v' } } },
  FindFormViewData: {
    formDef: {
      FormMeta: { Name: 'F' },
      TableMeta: { TableRef: 'Incident#', ValidatedFields: { Status: {} } },
    },
  },
  GetFormDefaultData: { Data: { Objects: { t1: { Values: { Status: '' } } } } },
  GetFormValidationListData: {
    Status: { FieldMap: { Status: 0 }, Data: [['Active'], ['Closed']] },
  },
};

const text = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
};
const body = (result: CallToolResult): Record<string, never> =>
  JSON.parse(text(result) || '{}') as Record<string, never>;

const deps = (
  responses: Record<string, unknown> = {},
  sessionCalls: Record<string, unknown> = FORM_CHAIN,
) => {
  const { connection, urls } = connectionFixture({
    entities: { incident: entityFixture('incident', { fields: [field('Status', { validated: true })] }) },
    capability: { tier: 'session', identity: { role: 'Admin' } },
    sessionCalls,
    responses,
  });
  return { urls, deps: { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS } };
};

describe('group_count', () => {
  it('counts each value of a validated field, biggest first', async () => {
    const { deps: d, urls } = deps({ incidents: { value: [{}], '@odata.count': 7 } });

    const result = body(
      await createGroupCountTool(d).handler({ object: 'Incidents', groupBy: 'Status' }),
    );

    expect(result).toMatchObject({ groupBy: 'Status', valuesFrom: 'the field’s own list' });
    expect(result.groups).toEqual([
      { value: 'Active', count: 7, exact: true },
      { value: 'Closed', count: 7, exact: true },
    ]);
    // One count per value: Ivanti has no aggregation endpoint.
    expect(urls.filter((url) => url.includes('$count=true'))).toHaveLength(2);
  });

  it('takes the values from the caller when it is given them', async () => {
    const { deps: d, urls } = deps({ incidents: { value: [], '@odata.count': 0 } });

    const result = body(
      await createGroupCountTool(d).handler({
        object: 'Incidents',
        groupBy: 'Status',
        values: ['Active'],
      }),
    );

    expect(result).toMatchObject({ valuesFrom: 'caller' });
    // No form chain: the caller said what to count.
    expect(urls.some((url) => url.includes('GetFormValidationListData'))).toBe(false);
  });

  it('says what to do when the field has no list to group over', async () => {
    const { deps: d } = deps({}, { ...FORM_CHAIN, GetFormValidationListData: {} });

    const result = await createGroupCountTool(d).handler({ object: 'Incidents', groupBy: 'Subject' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Pass `values`');
  });

  it('narrows every bucket with a filter', async () => {
    const { deps: d, urls } = deps({ incidents: { value: [], '@odata.count': 0 } });

    await createGroupCountTool(d).handler({
      object: 'Incidents',
      groupBy: 'Status',
      values: ['Active'],
      filter: 'Priority eq 1',
    });

    expect(decodeURIComponent(urls[0] ?? '')).toContain("Status eq 'Active' and (Priority eq 1)");
  });
});

describe('preview_delete', () => {
  it('reads the blockers rather than the status, which lies', async () => {
    // A clean preview reports an error status while carrying only warnings.
    const { deps: d } = deps({}, {
      ...FORM_CHAIN,
      PreDeleteObject: {
        status: 'error',
        errors: { warningMessages: ["Incident '1' contains one or more Journal records"] },
      },
    });

    const result = body(
      await createPreviewDeleteTool(d).handler({ object: 'Incidents', recordId: 'rec-1' }),
    );

    expect(result).toMatchObject({ wouldDelete: true });
    expect(String(JSON.stringify(result.cascades))).toContain('Journal');
  });

  it('reports a real blocker', async () => {
    const { deps: d } = deps({}, {
      ...FORM_CHAIN,
      PreDeleteObject: { errors: { errorMessages: ['Record is in change control'] } },
    });

    const result = body(
      await createPreviewDeleteTool(d).handler({ object: 'Incidents', recordId: 'rec-1' }),
    );

    expect(result).toMatchObject({ wouldDelete: false });
    expect(JSON.stringify(result.blockers)).toContain('change control');
  });
});
