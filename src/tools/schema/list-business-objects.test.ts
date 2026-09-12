import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import type { Logger } from '../../logger.js';
import { createListBusinessObjectsTool } from './list-business-objects.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

interface Catalog {
  source: string;
  knownObjects: number;
  returned: number;
  truncated?: number;
  note?: string;
  objects: {
    object: string;
    entitySet: string;
    displayName?: string;
    commonlyUsed?: boolean;
    onWorkspace?: boolean;
  }[];
}

const payload = (result: CallToolResult): Catalog => {
  const [block] = result.content;
  return JSON.parse(block?.type === 'text' ? block.text : '{}') as Catalog;
};

const ADMIN_ROWS = [
  { id: 'Incident#', displayName: 'Incident', commonlyUsed: 'True', pureValidationObject: 'False' },
  { id: 'IncidentStatus#', displayName: 'Incident Status', pureValidationObject: 'True' },
  { id: 'Account#', displayName: 'Account', description: 'Customer accounts' },
  { id: 'XLJ_Car#', displayName: 'Car' },
];

const WORKSPACES = {
  Workspaces: [{ ID: 'XLJ_Car#', Name: 'Car', Profile: 'ObjectWorkspace' }],
};

const tool = (options: Parameters<typeof connectionFixture>[0] = {}) => {
  const { connection } = connectionFixture(options);
  return createListBusinessObjectsTool({ connection, gate: OPEN_GATE, logger: logger(), ownRecordsOnly: false });
};

const ADMIN_TENANT = {
  entities: { incident: {}, account: {}, audit_incident: {} },
  capability: { tier: 'admin' as const, identity: { role: 'Admin' } },
  sessionCalls: { GetBriefBusinessObjects: ADMIN_ROWS, GetRoleWorkspaces: WORKSPACES },
};

describe('list_business_objects', () => {
  it('answers with what people work in, not a thousand rows of schema', async () => {
    const body = payload(await tool(ADMIN_TENANT).handler({}));

    // Incident is flagged commonlyUsed by Ivanti; Car has a workspace. Account has neither.
    expect(body.objects.map((row) => row.object).sort()).toEqual(['incident', 'xlj_car']);
    expect(body.knownObjects).toBeGreaterThan(body.returned);
    expect(body.note).toContain('Pass `search`');
  });

  it('reaches the whole catalog once a search is given', async () => {
    const body = payload(await tool(ADMIN_TENANT).handler({ search: 'account' }));

    expect(body.objects).toEqual([
      {
        object: 'account',
        entitySet: 'accounts',
        displayName: 'Account',
        description: 'Customer accounts',
      },
    ]);
  });

  it('matches the display name as well as the technical one', async () => {
    const body = payload(await tool(ADMIN_TENANT).handler({ search: 'car' }));

    expect(body.objects[0]).toMatchObject({ object: 'xlj_car', displayName: 'Car' });
  });

  it('leaves out validation lists and audit tables unless asked', async () => {
    const hidden = payload(await tool(ADMIN_TENANT).handler({ search: 'incident' }));
    expect(hidden.objects.map((row) => row.object)).toEqual(['incident']);

    const shown = payload(
      await tool(ADMIN_TENANT).handler({
        search: 'incident',
        includeValidationLists: true,
        includeAuditTables: true,
      }),
    );
    expect(shown.objects.map((row) => row.object).sort()).toEqual([
      'audit_incident',
      'incident',
      'incidentstatus',
    ]);
  });

  it('says which source it used, because completeness differs by credential', async () => {
    expect(payload(await tool(ADMIN_TENANT).handler({})).source).toContain('admin console');

    const sessionOnly = payload(
      await tool({
        entities: { incident: {} },
        capability: { tier: 'session' },
        sessionCalls: { GetRoleWorkspaces: WORKSPACES },
      }).handler({}),
    );
    expect(sessionOnly.source).toContain('role workspaces');

    const odataOnly = payload(await tool({ entities: { incident: {} } }).handler({ search: 'inc' }));
    expect(odataOnly.source).toContain('OData metadata only');
  });

  it('still answers when the admin catalog fails mid-flight', async () => {
    const body = payload(
      await tool({
        entities: { incident: {} },
        capability: { tier: 'admin' },
        sessionCalls: { GetBriefBusinessObjects: new Error('403'), GetRoleWorkspaces: WORKSPACES },
      }).handler({ search: 'incident' }),
    );

    expect(body.objects.map((row) => row.object)).toEqual(['incident']);
  });

  it('gives every object the entity-set name the record tools take', async () => {
    const body = payload(await tool(ADMIN_TENANT).handler({ search: 'incidentstatus', includeValidationLists: true }));

    // A literal `s`, not an English plural.
    expect(body.objects[0]?.entitySet).toBe('incidentstatuss');
  });
});
