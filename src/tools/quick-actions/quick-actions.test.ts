import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, entityFixture } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { createListQuickActionsTool } from './list-quick-actions.js';
import { createPreviewQuickActionTool } from './preview-quick-action.js';
import { createRunQuickActionTool } from './run-quick-action.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const ACTIONS = [
  ['act-update', 'Escalate', 'UpdateObject'],
  ['act-ui', 'Add Change', 'UIAction'],
];

const FORM_CHAIN = {
  GetRoleWorkspaces: {
    Workspaces: [{ ID: 'Incident#', Name: 'Incident', LayoutName: 'L', Profile: 'ObjectWorkspace' }],
  },
  GetWorkspaceData: { ObjectId: 'Incident#', LayoutData: { newRecordViews: { 'Incident#': 'v' } } },
  FindFormViewData: {
    formDef: {
      FormMeta: { Name: 'Incident.Header' },
      TableMeta: { TableRef: 'Incident#', ValidatedFields: {} },
    },
  },
};

const text = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
};
const body = (result: CallToolResult): Record<string, never> =>
  JSON.parse(text(result) || '{}') as Record<string, never>;

const deps = (sessionCalls: Record<string, unknown>) => {
  const { connection, urls } = connectionFixture({
    entities: { incident: entityFixture('incident') },
    capability: { tier: 'session', identity: { role: 'Admin' } },
    sessionCalls: { GetObjectQuickActions: ACTIONS, ...FORM_CHAIN, ...sessionCalls },
  });
  return { urls, deps: { connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS } };
};

const ARGS = { object: 'Incidents', recordId: 'rec-1', actionId: 'act-update' };

describe('list_quick_actions', () => {
  it('marks the actions that answer OK and change nothing', async () => {
    const { deps: d } = deps({});

    const result = body(await createListQuickActionsTool(d).handler({ object: 'Incidents' }));

    expect(result.actions).toEqual([
      { name: 'Escalate', actionId: 'act-update', actionType: 'UpdateObject' },
      {
        name: 'Add Change',
        actionId: 'act-ui',
        actionType: 'UIAction',
        doesNothingServerSide: true,
      },
    ]);
  });

  it('filters by name', async () => {
    const { deps: d } = deps({});

    const result = body(
      await createListQuickActionsTool(d).handler({ object: 'Incidents', search: 'escal' }),
    );

    expect(result).toMatchObject({ count: 1, of: 2 });
  });
});

describe('preview_quick_action', () => {
  it('probes without saving and reports what the action would ask for', async () => {
    const { deps: d, urls } = deps({
      SaveDataExecuteAction: {
        IsPromptRequired: true,
        promptParams: [
          { FieldName: 'Note', Label: 'Note to add', Required: true },
          { FieldName: 'Hidden1', Hidden: true },
        ],
      },
    });

    const result = body(await createPreviewQuickActionTool(d).handler(ARGS));

    expect(result).toMatchObject({ action: 'Escalate', wouldPrompt: true });
    expect(result.prompts).toEqual([
      { field: 'Note', label: 'Note to add', type: undefined, required: true },
    ]);
    expect(urls.filter((url) => url.includes('SaveDataExecuteAction'))).toHaveLength(1);
  });

  it('refuses an action id this role does not have', async () => {
    const { deps: d, urls } = deps({});

    const result = await createPreviewQuickActionTool(d).handler({ ...ARGS, actionId: 'nope' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('per-tenant and role-scoped');
    expect(urls.some((url) => url.includes('SaveDataExecuteAction'))).toBe(false);
  });

  it('refuses a UIAction rather than previewing something that does nothing', async () => {
    const { deps: d } = deps({});

    const result = await createPreviewQuickActionTool(d).handler({ ...ARGS, actionId: 'act-ui' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('nothing to execute');
  });

  it('refuses to preview when there is no form, because the other path would RUN it', async () => {
    const { connection } = connectionFixture({
      entities: { incident: entityFixture('incident') },
      capability: { tier: 'session' },
      sessionCalls: { GetObjectQuickActions: ACTIONS, GetRoleWorkspaces: { Workspaces: [] } },
    });

    const result = await createPreviewQuickActionTool({
      connection,
      gate: OPEN_GATE,
      ownRecordsOnly: false,
      actions: OPEN_ACTIONS,
      logger: logger(),
    }).handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('would RUN the action');
  });
});

describe('run_quick_action', () => {
  it('probes first, echoes that probe’s token, and reports what it created', async () => {
    let call = 0;
    const { connection, urls } = connectionFixture({
      entities: { incident: entityFixture('incident') },
      capability: { tier: 'session', identity: { role: 'Admin' } },
      sessionCalls: { GetObjectQuickActions: ACTIONS, ...FORM_CHAIN },
    });
    // The fixture cannot vary by call, so drive the protocol directly.
    const original = connection.session.call.bind(connection.session);
    const session: typeof connection.session = {
      ...connection.session,
      call: <T,>(service: string, method: string, args?: Record<string, unknown>): Promise<T> => {
        if (method === 'SaveDataExecuteAction') {
          call += 1;
          return Promise.resolve(
            call === 1
              ? { promptParams: [], parentActionExecutionInstanceId: 'token-1' }
              : {
                  saved: true,
                  newObjectIds: { a: 'b' },
                  echoed: args?.parentActionExecutionInstanceId,
                },
          ) as Promise<T>;
        }
        return original<T>(service, method, args);
      },
    };

    const result = body(
      await createRunQuickActionTool({
        connection: { ...connection, session },
        gate: OPEN_GATE,
        ownRecordsOnly: false,
      actions: OPEN_ACTIONS,
        logger: logger(),
      }).handler(ARGS),
    );

    expect(result).toMatchObject({ action: 'Escalate', ran: true, saved: true });
    expect(call).toBe(2); // a probe, then the commit
    expect(urls.length).toBeGreaterThan(0);
  });

  it('refuses when a required answer is missing, without running anything', async () => {
    const { deps: d } = deps({
      SaveDataExecuteAction: {
        promptParams: [{ FieldName: 'Note', Label: 'Note to add', Required: true }],
      },
    });

    const result = await createRunQuickActionTool(d).handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Nothing was run');
    expect(text(result)).toContain('Note');
  });

  it('surfaces the field that blocked it, not just a status', async () => {
    const { deps: d } = deps({
      SaveDataExecuteAction: {
        errors: {
          validationErrors: {
            'rec-1': { fieldErrors: { Category: { fieldMessages: ['Required field'] } } },
          },
        },
      },
    });

    const result = await createRunQuickActionTool(d).handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Category: Required field');
  });

  it('refuses a UIAction rather than reporting a success that did not happen', async () => {
    const { deps: d } = deps({});

    const result = await createRunQuickActionTool(d).handler({ ...ARGS, actionId: 'act-ui' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('change nothing');
  });
});
