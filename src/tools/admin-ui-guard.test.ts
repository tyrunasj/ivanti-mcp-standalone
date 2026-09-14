// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import type { Logger } from '../logger.js';
import { ARGUMENTS, RESPONSES } from './every-tool.fixture.js';
import { selectTools } from './register-tools.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

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
    // `switch_role` joins them for a second reason: with no impersonated session there is no
    // role to change, and saying so is the correct answer rather than a failure.
    const refusesWithoutAnIdentity = new Set(['vote_on_approval', 'switch_role']);

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
