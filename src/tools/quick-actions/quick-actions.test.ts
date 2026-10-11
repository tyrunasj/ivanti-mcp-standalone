// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, entityFixture } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { configFixture } from '../../config/config.fixture.js';
import { OPEN_ACTIONS, createActionGate } from '../shared/action-gate.js';
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

/** Drives the protocol call by call, recording what each SaveDataExecuteAction was sent. */
function protocol(options: {
  prompts: unknown[];
  records?: unknown[];
  actions?: typeof OPEN_ACTIONS;
}) {
  const { connection } = connectionFixture({
    entities: { incident: entityFixture('incident') },
    capability: { tier: 'session', identity: { role: 'Admin' } },
    sessionCalls: { GetObjectQuickActions: ACTIONS, ...FORM_CHAIN },
  });
  const saves: Record<string, unknown>[] = [];
  const original = connection.session.call.bind(connection.session);
  const session: typeof connection.session = {
    ...connection.session,
    call: <T,>(service: string, method: string, args?: Record<string, unknown>): Promise<T> => {
      if (method !== 'SaveDataExecuteAction') return original<T>(service, method, args);
      saves.push(args ?? {});
      return Promise.resolve(
        args?.shouldSave === true
          ? { saved: true }
          : { promptParams: options.prompts, parentActionExecutionInstanceId: 'token-1' },
      ) as Promise<T>;
    },
  };
  // The first read is the writable check on the record; the rest are before and after.
  const rows: unknown[] = [{ RecId: 'rec-1' }, ...(options.records ?? [])];
  vi.spyOn(connection.transport, 'request').mockImplementation((() =>
    rows.length === 0
      ? Promise.reject(new Error('record read refused'))
      : Promise.resolve(rows.shift())));
  return {
    saves,
    deps: {
      connection: { ...connection, session },
      gate: OPEN_GATE,
      logger: logger(),
      ownRecordsOnly: false,
      actions: options.actions ?? OPEN_ACTIONS,
    },
  };
}

const committed = (saves: Record<string, unknown>[]): Array<{ FieldName: string; Value: unknown }> =>
  (saves.find((call) => call.shouldSave === true)?.promptParams ?? []) as Array<{
    FieldName: string;
    Value: unknown;
  }>;

describe('run_quick_action answers', () => {
  const NOTES = [{ FieldName: 'Notes', Label: 'Notes' }];

  it('settles a mis-cased key to the prompt’s own spelling, so the value is sent', async () => {
    const { deps: d, saves } = protocol({ prompts: NOTES });

    const result = await createRunQuickActionTool(d).handler({ ...ARGS, answers: { notes: 'x' } });

    expect(result.isError).toBeUndefined();
    expect(committed(saves)).toEqual([{ FieldName: 'Notes', Label: 'Notes', Value: 'x' }]);
  });

  it('refuses a key that matches no prompt, naming it and the real ones, and commits nothing', async () => {
    const { deps: d, saves } = protocol({ prompts: NOTES });

    const result = await createRunQuickActionTool(d).handler({
      ...ARGS,
      answers: { Notes: 'x', Nonexistent: 'y' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Nonexistent');
    expect(text(result)).toContain('Notes');
    expect(text(result)).toContain('Nothing was run');
    expect(saves.some((call) => call.shouldSave === true)).toBe(false);
  });

  it('refuses any answer when the action asks for nothing', async () => {
    const { deps: d, saves } = protocol({ prompts: [] });

    const result = await createRunQuickActionTool(d).handler({ ...ARGS, answers: { Notes: 'x' } });

    expect(result.isError).toBe(true);
    expect(saves.some((call) => call.shouldSave === true)).toBe(false);
  });

  it('refuses two keys that differ only by case', async () => {
    const { deps: d, saves } = protocol({ prompts: NOTES });

    const result = await createRunQuickActionTool(d).handler({
      ...ARGS,
      answers: { Notes: 'a', notes: 'b' },
    });

    expect(result.isError).toBe(true);
    expect(saves.some((call) => call.shouldSave === true)).toBe(false);
  });

  it('counts a required prompt answered under another case as answered', async () => {
    const { deps: d } = protocol({ prompts: [{ FieldName: 'Note', Required: true }] });

    const result = await createRunQuickActionTool(d).handler({ ...ARGS, answers: { note: 'hi' } });

    expect(result.isError).toBeUndefined();
  });
});

describe('run_quick_action reads the record around the commit', () => {
  it('reports no changedFields when the record is identical before and after', async () => {
    const row = { RecId: 'rec-1', Status: 'Active' };
    const { deps: d } = protocol({ prompts: [], records: [row, { ...row }] });

    const result = body(await createRunQuickActionTool(d).handler(ARGS));

    expect(result).toMatchObject({ ran: true, saved: true });
    expect(result).not.toHaveProperty('changedFields');
  });

  it('names the fields that differ, and never their values', async () => {
    const { deps: d } = protocol({
      prompts: [],
      records: [
        { RecId: 'rec-1', Status: 'Active', Subject: 'secret' },
        { RecId: 'rec-1', Status: 'Resolved', Subject: 'secret' },
      ],
    });

    const result = await createRunQuickActionTool(d).handler(ARGS);

    expect(body(result).changedFields).toEqual(['Status']);
    expect(text(result)).not.toContain('Resolved');
  });

  it('still runs when the record cannot be read', async () => {
    const { deps: d } = protocol({ prompts: [], records: [] });

    const result = body(await createRunQuickActionTool(d).handler(ARGS));

    expect(result).toMatchObject({ ran: true });
    expect(result).not.toHaveProperty('changedFields');
  });
});

describe('the enduser quick-action allowlist', () => {
  const gate = createActionGate(
    configFixture({ MCP_MODE: 'enduser', ENDUSER_QUICK_ACTIONS: ['Add Change'] }),
  );

  it('list_quick_actions shows only the allowed actions', async () => {
    const { deps: d } = deps({});

    const result = body(await createListQuickActionsTool({ ...d, actions: gate }).handler({ object: 'Incidents' }));

    expect(result.actions).toEqual([
      expect.objectContaining({ name: 'Add Change', actionId: 'act-ui' }),
    ]);
  });

  it('preview_quick_action refuses an action outside the list, with the text of what is allowed', async () => {
    const { deps: d, urls } = deps({});

    const result = await createPreviewQuickActionTool({ ...d, actions: gate }).handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('It allows: Add Change');
    expect(urls.some((url) => url.includes('SaveDataExecuteAction'))).toBe(false);
  });

  it('run_quick_action refuses an action outside the list and commits nothing', async () => {
    const { deps: d, saves } = protocol({ prompts: [], actions: gate });

    const result = await createRunQuickActionTool(d).handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('It allows: Add Change');
    expect(saves).toEqual([]);
  });

  it('run_quick_action says no action is allowed when the list is empty', async () => {
    const none = createActionGate(configFixture({ MCP_MODE: 'enduser', ENDUSER_QUICK_ACTIONS: [] }));
    const { deps: d, saves } = protocol({ prompts: [], actions: none });

    const result = await createRunQuickActionTool(d).handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('or any other quick action');
    expect(saves).toEqual([]);
  });
});
