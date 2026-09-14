// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { configFixture } from '../../config/config.fixture.js';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { selectTools } from '../register-tools.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { createGetPickListValuesTool } from './get-pick-list-values.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const SESSION_CALLS = {
  GetRoleWorkspaces: {
    Workspaces: [
      { ID: 'Incident#', Name: 'Incident', LayoutName: 'IncidentLayout.SD', Profile: 'ObjectWorkspace' },
    ],
  },
  GetWorkspaceData: { ObjectId: 'Incident#', LayoutData: { newRecordViews: { 'Incident#': 'v' } } },
  FindFormViewData: {
    formDef: {
      FormMeta: { Name: 'Incident.Header' },
      TableMeta: { TableRef: 'Incident#', ValidatedFields: { Status: {} } },
    },
  },
  GetFormDefaultData: { Data: { Objects: { t1: { Values: { Status: '' } } } } },
  GetFormValidationListData: { Status: { FieldMap: { Status: 0 }, Data: [['Active'], ['Closed']] } },
};

const body = (result: CallToolResult): Record<string, never> => {
  const [block] = result.content;
  return JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<string, never>;
};

const fixture = () =>
  connectionFixture({
    entities: { incident: { fields: [field('Status', { validated: true }), field('Subject')] } },
    capability: { tier: 'session', identity: { role: 'Admin' } },
    sessionCalls: SESSION_CALLS,
  });

describe('get_pick_list_values', () => {
  it('answers with the values the field will accept', async () => {
    const { connection } = fixture();

    const result = body(
      await createGetPickListValuesTool({ connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS }).handler({
        object: 'Incidents',
        fields: ['Status'],
      }),
    );

    expect(result).toMatchObject({
      object: 'incident',
      fields: { Status: { validated: true, values: [{ value: 'Active' }, { value: 'Closed' }] } },
    });
  });

  it('names a field the object does not have', async () => {
    const { connection } = fixture();

    const result = body(
      await createGetPickListValuesTool({ connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false, actions: OPEN_ACTIONS }).handler({
        object: 'Incidents',
        fields: ['Status', 'Nope'],
      }),
    );

    expect(result.unknownFields).toEqual(['Nope']);
  });

  it('explains itself when the role has no form for the object', async () => {
    const { connection } = connectionFixture({
      entities: { employee: {} },
      capability: { tier: 'session' },
      sessionCalls: { GetRoleWorkspaces: { Workspaces: [] } },
    });

    const result = await createGetPickListValuesTool({
      connection,
      gate: OPEN_GATE,
      ownRecordsOnly: false,
      actions: OPEN_ACTIONS,
      logger: logger(),
    }).handler({ object: 'Employees', fields: ['Status'] });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('no create form');
  });
});

describe('tool selection by tier', () => {
  const context = (tier: 'odata' | 'session' | 'admin') => ({
    serverName: 'ivanti-mcp',
    serverVersion: '0.1.0',
    logger: logger(),
    ivanti: connectionFixture({ capability: { tier } }).connection,
  });

  it('is absent on the OData tier — it cannot work without a session', () => {
    const names = selectTools(configFixture(), context('odata')).map((tool) => tool.name);

    expect(names).not.toContain('get_pick_list_values');
  });

  it('is present from the session tier up', () => {
    for (const tier of ['session', 'admin'] as const) {
      const names = selectTools(configFixture(), context(tier)).map((tool) => tool.name);
      expect(names, tier).toContain('get_pick_list_values');
    }
  });
});
