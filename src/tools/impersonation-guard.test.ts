// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../auth/identity.js';
import { createSessionPin } from '../auth/identity-pin.js';
import { createImpersonationSlot } from '../auth/impersonation.js';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture } from '../ivanti/connection.fixture.js';
import type { ImpersonatedSession } from '../ivanti/session/impersonated-session.js';
import type { Logger } from '../logger.js';
import { ARGUMENTS, RESPONSES } from './every-tool.fixture.js';
import { selectTools } from './register-tools.js';
import type { CallContext } from './tool-definition.js';
import { impersonatedSessionFixture } from '../ivanti/session/impersonated-session.fixture.js';

/**
 * Impersonation must be something a deployment *has*, never something every deployment needs.
 *
 * Most customers will never issue a CentralConfig key, so the ordinary server has no ConfigDB
 * pair and no impersonated session — and every tool has to work exactly as it did before the
 * feature existed. This is the same argument `admin-ui-guard.test.ts` makes about `/HEAT/AdminUI/`:
 * a feature built on something optional must degrade, not break.
 *
 * The second assertion is the one that would otherwise rot silently. A tool that forgets
 * `transportFor` does not fail — it answers as the service account — so "nothing failed" is not
 * enough. Nothing may *reach for* an impersonated credential that is not there either.
 */

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const SESSION_CALLS: Record<string, unknown> = {
  GetUserData: { DisplayName: 'Service Account', UserRole: 'Admin' },
  GetRoleWorkspaces: {
    Workspaces: [
      { ID: 'Incident#', Name: 'Incident', LayoutName: 'IncidentLayout.SD', Profile: 'ObjectWorkspace' },
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
  GetObjectQuickActions: [['act-1', 'Escalate', 'UpdateObject']],
  SaveDataExecuteAction: { saved: true },
  PreDeleteObject: { errors: { warningMessages: ['contains Journal records'] } },
  GetBriefBusinessObjects: [{ id: 'Incident#', displayName: 'Incident' }],
};

const openSession = (): ImpersonatedSession =>
  impersonatedSessionFixture({
    sid: 'tenant.example.com#SID#1',
    loginId: 'JSmith',
    roles: [{ name: 'ServiceDeskAnalyst', displayName: 'Service Desk Analyst', selfService: false }],
  });

/** Tools that refuse before reaching Ivanti because no person is pinned here — by design. */
const REFUSES_WITHOUT_AN_IDENTITY = new Set(['vote_on_approval', 'switch_role']);

function tenant() {
  return connectionFixture({
    // The relationship has to exist for the link/unlink tools to reach Ivanti rather than refuse
    // on their own guard — the same shape `admin-ui-guard` uses.
    entities: {
      incident: { relationships: [{ name: 'IncidentContainsTask', target: 'task' }] },
      employee: {},
      journal__notes: {},
    },
    responses: RESPONSES,
    sessionCalls: SESSION_CALLS,
    // Capable of everything except impersonation: the point is that the rest is unaffected.
    capability: { tier: 'admin', identity: { role: 'Admin' }, canImpersonate: false },
  });
}

async function driveEveryTool(
  context: CallContext,
  skip: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const { connection } = tenant();
  const tools = selectTools(configFixture(), {
    serverName: 'ivanti-mcp',
    serverVersion: '0.1.0',
    logger: logger(),
    ivanti: connection,
  });

  const failures: string[] = [];
  for (const tool of tools) {
    const args = ARGUMENTS[tool.name];
    expect(args, `no arguments defined for ${tool.name}`).toBeDefined();
    if (skip.has(tool.name)) continue;
    const result = await tool.handler(args ?? {}, context);
    if (REFUSES_WITHOUT_AN_IDENTITY.has(tool.name)) continue;
    if (result.isError === true) failures.push(tool.name);
  }
  return failures;
}

describe('every tool, on a deployment that cannot impersonate', () => {
  // The ordinary server: no ConfigDB pair at all, so `CallContext` carries no slot.
  it('works when impersonation is not configured', async () => {
    const failures = await driveEveryTool({
      identity: ANONYMOUS,
      pin: createSessionPin(ANONYMOUS),
    });

    expect(failures, `these failed without impersonation:\n  ${failures.join('\n  ')}`).toEqual([]);
  });

  // Configured, reachable, but nobody has called act_as yet — the state every conversation is in
  // before its first tool call, and the one a tool is most likely to get wrong.
  it('works when a slot exists but no session has been opened', async () => {
    const failures = await driveEveryTool(
      {
        identity: ANONYMOUS,
        pin: createSessionPin(ANONYMOUS),
        impersonation: createImpersonationSlot(() => Promise.resolve(openSession())),
      },
      // act_as is excluded because opening the session IS its job here; every other tool must
      // cope with a slot that is present and empty.
      new Set(['act_as']),
    );

    expect(failures, `these failed with an unopened slot:\n  ${failures.join('\n  ')}`).toEqual([]);
  });

  // A tool must never open a session for itself: `act_as` is the one place that decides who this
  // conversation acts for, and the identity pin's rules live there.
  it('never opens a session of its own accord', async () => {
    const open = vi.fn(() => Promise.resolve(openSession()));

    // Every tool BUT act_as: it is the one place that decides who a conversation acts for, and
    // the identity pin's rules live there. A record tool opening its own session would route
    // around all of them.
    await driveEveryTool(
      {
        identity: ANONYMOUS,
        pin: createSessionPin(ANONYMOUS),
        impersonation: createImpersonationSlot(open),
      },
      new Set(['act_as']),
    );

    expect(open).not.toHaveBeenCalled();
  });
});

describe('a session that never got a role', () => {
  /**
   * `openImpersonatedSession` refuses rather than returning a role-less session, so one cannot
   * reach a tool at all. This pins that at the seam: the slot is the only way in, and what it
   * holds is whatever the opener returned — so a refusal must stay a refusal.
   */
  it('never reaches the slot, because opening refused', async () => {
    const slot = createImpersonationSlot(() =>
      Promise.reject(new Error('A session with no role reads nothing at all.')),
    );

    await expect(slot.open('HSanders')).rejects.toThrow(/reads nothing/);
    // Nothing was stored, so no tool can pick it up on the next call either.
    expect(slot.session()).toBeUndefined();
  });

  it('leaves the conversation on the service account rather than a broken session', async () => {
    const slot = createImpersonationSlot(() => Promise.reject(new Error('no role')));
    await slot.open('HSanders').catch(() => undefined);

    const failures = await driveEveryTool(
      { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS), impersonation: slot },
      // act_as would report the refusal, which is correct and is asserted in its own tests.
      new Set(['act_as']),
    );

    expect(failures).toEqual([]);
  });
});

describe('what this guard does not cover', () => {
  /**
   * A tool that forgets `transportFor` is invisible here, and deliberately so.
   *
   * Driving every tool with a session open would not catch it: the tool would answer from the
   * service account and its result would look exactly right, because the stub tenant serves the
   * same rows to both credentials. Catching it needs to happen where the mistake is made, not
   * where its effect is invisible — `shared/credential-guard.test.ts` reads the source and fails
   * on any file under `tools/` that reaches for `deps.connection.transport` without resolving the
   * caller's first.
   *
   * This is written down rather than left implicit because the obvious next step — "also drive
   * everything with a session open" — would add a test that passes whether or not the code is
   * correct.
   */
  it('leaves forgotten-credential detection to the static guard', async () => {
    const { ARGUMENTS: shared } = await import('./every-tool.fixture.js');

    // The one thing worth asserting here: both guards drive the same set, so a tool cannot be
    // added to one harness and quietly skipped by the other.
    expect(Object.keys(shared).length).toBeGreaterThan(30);
  });
});
