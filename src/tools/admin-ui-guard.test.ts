// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

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
  // The target is linked, so unlink_records reaches Ivanti rather than refusing on its own guard.
  IncidentContainsTask: { value: [{ RecId: 't1' }], code: 'ISM_2000' },
  "incidents('abc')": { RecId: 'abc', IncidentNumber: 1, Subject: 'Printer' },
  incidents: { value: [{ RecId: 'abc', IncidentNumber: 1, Subject: 'Printer' }] },
  servicereqs: { value: [] },
  changes: { value: [] },
  employees: { value: [{ RecId: 'e1', LoginID: 'JSmith', DisplayName: 'Jon Smith' }] },
  attachments: { value: [{ RecId: 'a1', ATTACHNAME: 'work-order.log' }] },
  // The fixture serves a file body as text, which is what download_attachment reads.
  'rest/Attachment': 'log line one',
  'POST journal__notess': { RecId: 'n1', NotesBody: 'hello', PublishToWeb: false },
  frs_approvalvotetrackings: {
    value: [
      {
        RecId: 'v1',
        // The guard runs without an identity, so the vote is refused before Ivanti is reached.
        Owner: 'somebody-else',
        Status: 'Pending',
        PrimaryParentObject: 'ServiceReq',
        PrimaryParentID: '10002',
      },
    ],
  },
  frs_knowledges: {
    value: [{ KnowledgeNumber: 10052, Title: 'VPN error 413', Status: 'Published', Details: '<p>Reconnect.</p>' }],
  },
  journal__notess: { value: [{ RecId: 'n1', NotesBody: 'hello', PublishToWeb: false }] },
  // The multipart upload answers with the new attachment's RecId in `Message`, and leaves the
  // parent link unset — the tool patches it afterwards.
  'POST Attachment': [{ FileName: 'x.txt', IsUploaded: true, Message: 'A'.repeat(32) }],
  'PATCH attachments': { code: 'ISM_2000' },
  'DELETE attachments': { code: 'ISM_2000' },
  'Template/': [
    { strSubscriptionId: 'sub-1', strRecId: 'tpl-1', strName: 'New Laptop', strDescription: 'A laptop' },
  ],
  'POST ServiceRequest/new': {
    IsSuccess: true,
    ErrorText: '',
    ServiceRequests: [
      {
        strRequestRecId: 'sr1',
        strRequestNum: '10219',
        strName: 'New Laptop',
        parameterTemplateParameterIds: {},
      },
    ],
  },
  servicereqtemplateparams: { value: [{ RecId: 'p1', Name: 'StartDate' }] },
  ValidationList: [['r1', 'Accounting']],
  // The writes: a create answers with the stored record, a patch and a delete with nothing.
  'POST incidents': { RecId: 'abc', IncidentNumber: 1, Subject: 'stub' },
  'PATCH incidents': { RecId: 'abc', Subject: 'stub' },
  'DELETE incidents': { code: 'ISM_2000' },
};

const ARGUMENTS: Record<string, Record<string, unknown>> = {
  get_version: {},
  act_as: { person: 'JSmith' },
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
  get_pick_list_constraints: { object: 'Incidents' },
  get_link_fields: { object: 'Incidents' },
  list_saved_searches: { object: 'Incidents' },
  saved_search: { object: 'Incidents', name: 'All Active', searchId: 'a1' },
  group_count: { object: 'Incidents', groupBy: 'Status', values: ['Active'] },
  list_quick_actions: { object: 'Incidents' },
  preview_quick_action: { object: 'Incidents', recordId: 'abc', actionId: 'act-1' },
  run_quick_action: { object: 'Incidents', recordId: 'abc', actionId: 'act-1' },
  preview_delete: { object: 'Incidents', recordId: 'abc' },
  create_record: { object: 'Incidents', fields: { Subject: 'stub' } },
  update_record: { object: 'Incidents', recordId: 'abc', fields: { Subject: 'stub' } },
  delete_record: { object: 'Incidents', recordId: 'abc' },
  close_ticket: { object: 'Incidents', recordId: 'abc' },
  reopen_ticket: { object: 'Incidents', recordId: 'abc' },
  search_knowledge: { query: 'vpn' },
  list_approvals: { person: 'JSmith' },
  vote_on_approval: { approvalId: 'v1', decision: 'approve' },
  list_notes: { object: 'Incidents', recordId: 'abc' },
  add_note: { object: 'Incidents', recordId: 'abc', note: 'hello' },
  upload_attachment: {
    object: 'Incidents',
    recordId: 'abc',
    filename: 'x.txt',
    contentBase64: 'aGVsbG8=',
  },
  delete_attachment: { attachmentId: 'a1' },
  download_attachment: { attachmentId: 'a1' },
  list_request_offerings: { person: 'e1' },
  submit_service_request: { subscriptionId: 'sub-1', answers: {}, person: 'e1' },
  link_records: {
    object: 'Incidents',
    recordId: 'abc',
    relationship: 'IncidentContainsTask',
    targetId: 't1',
  },
  unlink_records: {
    object: 'Incidents',
    recordId: 'abc',
    relationship: 'IncidentContainsTask',
    targetId: 't1',
  },
};

describe('every tool, over a stubbed tenant', () => {
  it('works on a credential that cannot reach the admin console', async () => {
    // The tier most customers will run: a session, but no admin rights. Nothing may depend on
    // /HEAT/AdminUI/ — every feature built on it has to degrade rather than break.
    const { connection, urls } = connectionFixture({
      entities: {
        incident: { relationships: [{ name: 'IncidentContainsTask', target: 'task' }] },
        employee: {},
        journal__notes: {},
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
          SearchData: { favorites: [{ Id: 'a1', Name: 'All Active', isDefault: true }] },
        },
        FindFormViewData: {
          formDef: {
            FormMeta: { Name: 'Incident.Header' },
            TableMeta: { TableRef: 'Incident#', ValidatedFields: { Status: {} } },
          },
        },
        GetFormDefaultData: { Data: { Objects: { t1: { Values: { Status: '' } } } } },
        GetFormValidationListData: { Status: { FieldMap: { Status: 0 }, Data: [['Active']] } },
        GetObjectQuickActions: [
          ['act-1', 'Escalate', 'UpdateObject'],
          ['act-2', 'Close From Self Service', 'UpdateObject'],
          ['act-3', 'Reopen Incident (Self Service)', 'UpdateObject'],
        ],
        SaveDataExecuteAction: { saved: true },
        PreDeleteObject: { errors: { warningMessages: ['contains Journal records'] } },
        GetBriefBusinessObjects: new Error('404 — not an administrator'),
      },
    });

    const tools = selectTools(configFixture(), {
      serverName: 'ivanti-mcp',
      serverVersion: '0.1.0',
      logger: logger(),
      ivanti: connection,
    });

    /**
     * Tools that refuse before reaching Ivanti at all, for a reason that has nothing to do with
     * the admin console: they cast or scope a decision for a person, and no person is pinned
     * here. The assertion that matters for them is the one below — that no AdminUI URL was
     * requested — which holds precisely because they refused.
     */
    const refusesWithoutAnIdentity = new Set(['vote_on_approval']);

    for (const tool of tools) {
      const args = ARGUMENTS[tool.name];
      expect(args, `no arguments defined for ${tool.name}`).toBeDefined();
      const result = await tool.handler(args ?? {});
      if (refusesWithoutAnIdentity.has(tool.name)) continue;
      expect(result.isError, `${tool.name} failed without the admin console`).not.toBe(true);
    }

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => /AdminUI/i.test(url))).toEqual([]);
  });

  it('reaches Ivanti only through the two documented surfaces', async () => {
    const { connection, urls } = connectionFixture({
      entities: { incident: {}, employee: {}, journal__notes: {} },
      responses: RESPONSES,
    });

    const tools = selectTools(configFixture(), {
      serverName: 'ivanti-mcp',
      serverVersion: '0.1.0',
      logger: logger(),
      ivanti: connection,
    });

    for (const tool of tools) await tool.handler(ARGUMENTS[tool.name] ?? {});

    for (const url of urls.map((entry) => entry.replace(/^[A-Z]+ /, '')).filter((candidate) => candidate.startsWith('http'))) {
      expect(url, `unexpected surface: ${url}`).toMatch(/\/api\/(odata|rest)\//);
    }
  });
});
