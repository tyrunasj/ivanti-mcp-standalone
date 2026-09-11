import { describe, expect, it, vi } from 'vitest';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import type { Logger } from '../logger.js';
import { selectTools } from './register-tools.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/**
 * Plausible arguments for every tool, so each one actually reaches the network layer. A tool
 * added without an entry here fails the last assertion rather than passing silently.
 */
/** Enough of a tenant that every tool takes its happy path. */
const RESPONSES: Record<string, unknown> = {
  // Matched by substring in declaration order, so the relationship route comes before the record.
  IncidentContainsTask: { value: [] },
  "incidents('abc')": { RecId: 'abc', IncidentNumber: 1, Subject: 'Printer' },
  incidents: { value: [{ RecId: 'abc', IncidentNumber: 1, Subject: 'Printer' }] },
  servicereqs: { value: [] },
  changes: { value: [] },
  employees: { value: [{ LoginID: 'JSmith', DisplayName: 'Jon Smith' }] },
  attachments: { value: [{ RecId: 'a1', ATTACHNAME: 'work-order.png' }] },
  servicereqtemplateparams: { value: [{ RecId: 'p1', Name: 'StartDate' }] },
  ValidationList: [['r1', 'Accounting']],
};

const ARGUMENTS: Record<string, Record<string, unknown>> = {
  get_version: {},
  list_business_objects: {},
  get_object_metadata: { object: 'Incidents' },
  get_record: { object: 'Incidents', recordId: 'abc' },
  list_records: { object: 'Incidents' },
  count_records: { object: 'Incidents' },
  get_related_records: { object: 'Incidents', recordId: 'abc', relationship: 'IncidentContainsTask' },
  fulltext_search_object: { object: 'Incidents', query: 'printer' },
  list_assigned_work: { person: 'JSmith' },
  get_service_request_parameters: { templateId: 't1' },
  get_service_request_parameter_options: { parameterId: 'p1' },
  get_attachment_details: { attachmentId: 'a1' },
  search: { query: 'printer' },
  fetch: { id: 'incidents:abc' },
  get_pick_list_values: { object: 'Incidents', fields: ['Status'] },
};

describe('every tool, over a stubbed tenant', () => {
  it('works on a credential that cannot reach the admin console', async () => {
    // The tier most customers will run: a session, but no admin rights. Nothing may depend on
    // /HEAT/AdminUI/ — every feature built on it has to degrade rather than break.
    const { connection, urls } = connectionFixture({
      entities: {
        incident: { relationships: [{ name: 'IncidentContainsTask', target: 'task' }] },
      },
      responses: RESPONSES,
      capability: { tier: 'session', identity: { role: 'ServiceDeskAnalyst' } },
      sessionCalls: {
        GetRoleWorkspaces: {
          Workspaces: [
            {
              ID: 'Incident#',
              Name: 'Incident',
              LayoutName: 'IncidentLayout.SD',
              Profile: 'ObjectWorkspace',
            },
          ],
        },
        GetWorkspaceData: {
          ObjectId: 'Incident#',
          LayoutData: { newRecordViews: { 'Incident#': 'v' } },
        },
        FindFormViewData: {
          formDef: {
            FormMeta: { Name: 'Incident.Header' },
            TableMeta: { TableRef: 'Incident#', ValidatedFields: { Status: {} } },
          },
        },
        GetFormDefaultData: { Data: { Objects: { t1: { Values: { Status: '' } } } } },
        GetFormValidationListData: { Status: { FieldMap: { Status: 0 }, Data: [['Active']] } },
        GetBriefBusinessObjects: new Error('404 — not an administrator'),
      },
    });

    const tools = selectTools(configFixture(), {
      serverName: 'ivanti-mcp',
      serverVersion: '0.1.0',
      logger: logger(),
      ivanti: connection,
    });

    for (const tool of tools) {
      const args = ARGUMENTS[tool.name];
      expect(args, `no arguments defined for ${tool.name}`).toBeDefined();
      const result = await tool.handler(args ?? {});
      expect(result.isError, `${tool.name} failed without the admin console`).not.toBe(true);
    }

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => /AdminUI/i.test(url))).toEqual([]);
  });

  it('reaches Ivanti only through the two documented surfaces', async () => {
    const { connection, urls } = connectionFixture({
      entities: { incident: {} },
      responses: RESPONSES,
    });

    const tools = selectTools(configFixture(), {
      serverName: 'ivanti-mcp',
      serverVersion: '0.1.0',
      logger: logger(),
      ivanti: connection,
    });

    for (const tool of tools) await tool.handler(ARGUMENTS[tool.name] ?? {});

    for (const url of urls.filter((candidate) => candidate.startsWith('http'))) {
      expect(url, `unexpected surface: ${url}`).toMatch(/\/api\/(odata|rest)\//);
    }
  });
});
