// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { configFixture } from '../config/config.fixture.js';
import { connectionFixture, field } from '../ivanti/connection.fixture.js';
import type { Logger } from '../logger.js';
import { selectTools } from './register-tools.js';
import { createSessionPin } from '../auth/identity-pin.js';
import { ANONYMOUS } from '../auth/identity.js';
import type { CallContext } from './tool-definition.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/**
 * The safety net for `enduser` mode.
 *
 * Scoping is applied tool by tool, which is explicit but forgettable — and a read that quietly
 * forgets it does not fail, it succeeds with somebody else's ticket in it. So every registered
 * tool has to be classified here: either it refuses until the conversation knows who it is
 * helping, or it is listed as one that never returns a record. A tool added to `selectTools`
 * without an entry fails the last assertion rather than passing silently.
 */
const MUST_REFUSE: Record<string, Record<string, unknown>> = {
  get_record: { object: 'Incidents', recordId: 'i1' },
  list_records: { object: 'Incidents' },
  count_records: { object: 'Incidents' },
  get_related_records: {
    object: 'Incidents',
    recordId: 'i1',
    relationship: 'IncidentAssociatedServiceReq',
  },
  fulltext_search_object: { object: 'Incidents', query: 'printer' },
  get_attachment_details: { attachmentId: 'a1' },
  search: { query: 'printer' },
  fetch: { id: 'incidents:i1' },
  group_count: { object: 'Incidents', groupBy: 'Status', values: ['Active'] },
  create_record: { object: 'Incidents', fields: { Subject: 'stub' } },
  update_record: { object: 'Incidents', recordId: 'i1', fields: { Subject: 'stub' } },
  delete_record: { object: 'Incidents', recordId: 'i1' },
  // A note is reached through its ticket, so it is refused exactly as the ticket is.
  list_notes: { object: 'Incidents', recordId: 'i1' },
  add_note: { object: 'Incidents', recordId: 'i1', note: 'hello' },
  upload_attachment: {
    object: 'Incidents',
    recordId: 'i1',
    filename: 'x.txt',
    contentBase64: 'aGVsbG8=',
  },
  delete_attachment: { attachmentId: 'a1' },
  download_attachment: { attachmentId: 'a1' },
  // Per person: an approval queue belongs to its approver, and a vote is cast on one's own row.
  list_approvals: {},
  vote_on_approval: { approvalId: 'v1', decision: 'approve' },
  // Both of these are per person — the catalog a person sees depends on their entitlements, and
  // a request is filed against somebody.
  list_request_offerings: {},
  submit_service_request: { subscriptionId: 's1', answers: {} },
  // A quick action runs the tenant's own close/cancel procedure against ONE record, so it is
  // refused exactly as that record is. Registered only when `ENDUSER_QUICK_ACTIONS` names
  // something, which is why they were missing from this map for a release.
  preview_quick_action: { object: 'Incidents', recordId: 'i1', actionId: 'qa1' },
  run_quick_action: { object: 'Incidents', recordId: 'i1', actionId: 'qa1' },
};

/**
 * Tools that answer about the *schema*, which is tenant configuration and carries no record.
 *
 * `search_knowledge` is here on a judgement rather than a technicality: an article belongs to
 * nobody, and it returns published articles only in this mode, which is what the self-service
 * portal shows.
 *
 * Since 2026-09-17 none of these is reachable before `act_as` either — `registerTools` gates every
 * tool but that one, in both modes. This list is what each tool does *on its own*, which is what
 * a handler called directly in a test meets, and it stays: the gate above it is one check in one
 * place, and a guard that only holds while that check is there is not a guard.
 */
const CARRIES_NO_RECORD = new Set([
  'get_version',
  'act_as',
  // Lists what the gate allows, not what anybody owns — and it is narrowed by the action gate,
  // so a refusal is never the first a caller hears of it.
  'list_quick_actions',
  'search_knowledge',
  'list_business_objects',
  'get_object_metadata',
  'get_pick_list_values',
  'get_pick_list_constraints',
  'get_link_fields',
  'get_service_request_parameters',
  'get_service_request_parameter_options',
]);

const GATED = configFixture({
  MCP_MODE: 'enduser',
  ENDUSER_BUSINESS_OBJECTS: ['incident', 'change', 'servicereq'],
  // Without this, `selectTools` skips `list_quick_actions`, `preview_quick_action` and
  // `run_quick_action` entirely (register-tools.ts:129) — so the "classifies every registered
  // tool" assertion below iterated a set that could not contain them, and this guard's own
  // promise was false for exactly the three tools that run a tenant's close/cancel procedures
  // against a caller's record. The name is the tenant's own text, as CLAUDE.md documents.
  ENDUSER_QUICK_ACTIONS: ['Close From Self Service'],
});

function enduserTools() {
  const { connection, urls } = connectionFixture({
    entities: {
      incident: {
        fields: [
          field('RecId'),
          field('Subject'),
          field('ProfileLink_RecID'),
          field('ProfileLink_Category'),
        ],
        // A relationship to an ALLOWED object, so what is under test here is the identity
        // check rather than the gate — the gate on relationship targets has its own test.
        relationships: [{ name: 'IncidentAssociatedServiceReq', target: 'servicereq' }],
      },
      change: {},
      servicereq: {},
      employee: {},
    },
    capability: { tier: 'session', identity: { role: 'SelfService' } },
    responses: {
      "incidents('i1')": {
        RecId: 'i1',
        Subject: 'Printer',
        ProfileLink_RecID: 'SOMEONE-ELSE',
        ProfileLink_Category: 'Employee',
      },
      incidents: {
        value: [
          {
            RecId: 'i1',
            Subject: 'Printer',
            ProfileLink_RecID: 'SOMEONE-ELSE',
            ProfileLink_Category: 'Employee',
          },
        ],
      },
      attachments: {
        value: [{ RecId: 'a1', ATTACHNAME: 'x.png', ParentLink_Category: 'Incident', ParentLink_RecID: 'i1' }],
      },
      employees: { value: [{ RecId: 'e1', LoginID: 'JSmith', DisplayName: 'Jon Smith' }] },
    },
  });

  return {
    urls,
    tools: selectTools(GATED, {
      serverName: 'ivanti-mcp',
      serverVersion: '0.1.0',
      logger: logger(),
      ivanti: connection,
    }),
  };
}

const text = (result: { content: { type: string; text?: string }[] }): string =>
  result.content[0]?.text ?? '';

describe('enduser mode never answers with records before it knows who is asking', () => {
  it('refuses every record-returning tool until an identity is pinned', async () => {
    const { tools } = enduserTools();
    const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };

    for (const [name, args] of Object.entries(MUST_REFUSE)) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool, `${name} is not registered in enduser mode`).toBeDefined();

      const result = await tool!.handler(args, context);

      expect(result.isError, `${name} answered without an identity`).toBe(true);
      expect(text(result), `${name} did not explain itself`).toContain('act_as');
    }
  });

  it('leaves no tool answering for a named person when nobody has identified themselves', () => {
    // The blind spot the other tests cannot see: a tool that takes a `person` argument "works"
    // without a pin, so it never trips the no-identity path above. None of these may be
    // registered in enduser mode unless it also refuses a person who is not the pinned one —
    // the rule submit_service_request already follows.
    const { tools } = enduserTools();
    const takesAPerson = [
      'list_assigned_work',
      'list_request_offerings',
      'submit_service_request',
      'list_approvals',
      'vote_on_approval',
    ];
    const registered = new Set(tools.map((tool) => tool.name));

    for (const name of takesAPerson) {
      if (!registered.has(name)) continue;
      expect(
        MUST_REFUSE[name] !== undefined,
        `${name} takes a person and is registered in enduser mode, so it must be in ` +
          'MUST_REFUSE — and its handler must refuse a person other than the pinned one.',
      ).toBe(true);
    }
  });

  /**
   * The same rule, DRIVEN rather than declared.
   *
   * The test above asserts that each name is a key of a hand-written map, which is a property of
   * this file rather than of the code: reverting `resolveSubject` to the shape its own docstring
   * calls wrong — "if a person is pinned AND the name differs, refuse", so pinning nobody skipped
   * it — left it passing, because `MUST_REFUSE['list_approvals']` is still defined and its entry
   * still carries no `person`. Nothing named `NotYourQueue` anywhere in the suite.
   *
   * So: pin somebody, then hand each of these a DIFFERENT person and require a refusal naming the
   * one who is pinned.
   */
  it('refuses a named person who is not the pinned one', async () => {
    const { tools } = enduserTools();
    const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
    context.pin?.pin({
      recId: 'e1',
      category: 'employee',
      displayName: 'Jon Smith',
      loginId: 'JSmith',
      matchedOn: 'LoginID',
      provenance: 'asserted',
    });

    const takesAPerson = ['list_request_offerings', 'submit_service_request', 'list_approvals'];

    for (const name of takesAPerson) {
      const tool = tools.find((entry) => entry.name === name);
      if (tool === undefined) continue;

      const result = await tool.handler(
        { ...MUST_REFUSE[name], person: 'SOMEBODY-ELSE' },
        context,
      );

      expect(result.isError, `${name} answered for a person who is not the pinned one`).toBe(true);
      expect(text(result), `${name} refused without naming who it acts for`).toContain('Jon Smith');
    }
  });

  it('classifies every registered tool', () => {
    const { tools } = enduserTools();

    for (const tool of tools) {
      expect(
        MUST_REFUSE[tool.name] !== undefined || CARRIES_NO_RECORD.has(tool.name),
        `${tool.name} is registered in enduser mode but nothing says whether it may answer ` +
          'without an identity. Add it to MUST_REFUSE, or to CARRIES_NO_RECORD if it returns ' +
          'no record data.',
      ).toBe(true);
    }
  });

  it('refuses a record that belongs to someone else, and says nothing about whether it exists', async () => {
    const { tools } = enduserTools();
    const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
    const tool = (name: string) => tools.find((entry) => entry.name === name)!;

    await tool('act_as').handler({ person: 'JSmith' }, context);

    // The fixture's incident belongs to SOMEONE-ELSE, not to e1.
    const mine = await tool('get_record').handler({ object: 'Incidents', recordId: 'i1' }, context);

    expect(mine.isError).toBe(true);
    expect(text(mine)).toBe('No such record is available to you.');
    // Not "someone else's" and not "does not exist": incident numbers are sequential, and a
    // message that told the two apart would be a ticket-enumeration oracle.
    expect(text(mine)).not.toMatch(/exist|another|someone/i);
  });
});
