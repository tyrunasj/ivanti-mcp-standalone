import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, entityFixture } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { createGetLinkFieldsTool } from './get-link-fields.js';
import { createGetPickListConstraintsTool } from './get-pick-list-constraints.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const FORM_CHAIN = {
  GetRoleWorkspaces: {
    Workspaces: [{ ID: 'Incident#', Name: 'Incident', LayoutName: 'L', Profile: 'ObjectWorkspace' }],
  },
  GetWorkspaceData: { ObjectId: 'Incident#', LayoutData: { newRecordViews: { 'Incident#': 'v' } } },
  FindFormViewData: {
    formDef: {
      FormMeta: { Name: 'F' },
      LinkIdMap: { ProfileLink_RecID: 'ProfileLink', OwnerLink_RecID: 'OwnerLink' },
      TableMeta: {
        TableRef: 'Incident#',
        Fields: {
          ProfileLink: { DisplayName: 'Customer' },
          Symptom: { DisplayName: 'Description' },
        },
        ValidatedFields: {
          Status: { ValidatedIdFieldRef: 'Status_Valid' },
          Category: { Condition: { FieldRefs: ['(other)[CI#Service.Rev2]Name', 'Service'] } },
          Owner: { Condition: { FieldRefs: ['OwnerTeam'] } },
        },
      },
    },
  },
};

const body = (result: CallToolResult): Record<string, never> => {
  const [block] = result.content;
  return JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<string, never>;
};

const deps = (sessionCalls = FORM_CHAIN) => {
  const { connection } = connectionFixture({
    entities: { incident: entityFixture('incident') },
    capability: { tier: 'session', identity: { role: 'Admin' } },
    sessionCalls,
  });
  return { connection, gate: OPEN_GATE, logger: logger() };
};

describe('get_link_fields', () => {
  it('names the pair a link is written through, and what a person calls it', async () => {
    const result = body(await createGetLinkFieldsTool(deps()).handler({ object: 'Incidents' }));

    expect(result.links).toEqual([
      {
        field: 'OwnerLink',
        displayName: 'OwnerLink',
        recIdField: 'OwnerLink_RecID',
        categoryField: 'OwnerLink_Category',
      },
      {
        // Ivanti's refusals call this "Customer", which is neither field.
        field: 'ProfileLink',
        displayName: 'Customer',
        recIdField: 'ProfileLink_RecID',
        categoryField: 'ProfileLink_Category',
      },
    ]);
  });
});

describe('get_pick_list_constraints', () => {
  it('reports only the fields something actually filters', async () => {
    const result = body(
      await createGetPickListConstraintsTool(deps()).handler({ object: 'Incidents' }),
    );

    // Status is validated but unfiltered, so listing it would bury the two that matter.
    expect(result.constrained).toEqual([
      { field: 'Category', constrainedBy: ['Service'] },
      { field: 'Owner', constrainedBy: ['OwnerTeam'] },
    ]);
    expect(result.validatedFields).toBe(3);
  });

  it('drops the (other)-prefixed refs, which are not this record’s fields', async () => {
    const result = body(
      await createGetPickListConstraintsTool(deps()).handler({
        object: 'Incidents',
        field: 'Category',
      }),
    );

    expect(JSON.stringify(result)).not.toContain('(other)');
  });

  it('says so when the field is not validated at all', async () => {
    const result = await createGetPickListConstraintsTool(deps()).handler({
      object: 'Incidents',
      field: 'Subject',
    });

    expect(result.isError).toBe(true);
  });
});
