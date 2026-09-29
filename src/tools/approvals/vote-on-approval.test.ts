// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../auth/identity.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import { connectionFixture } from '../../ivanti/connection.fixture.js';
import type { Logger } from '../../logger.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import type { CallContext } from '../tool-definition.js';
import { createVoteOnApprovalTool } from './vote-on-approval.js';

/**
 * Who owns an approval row, which is the whole safety argument of this tool.
 *
 * The check has to be exactly as wide as `list_approvals`' filter and no wider. Narrower, and a row
 * the listing has just called theirs is refused with a message naming the same person on both sides
 * of "not" — measured live on this tenant, where `Owner` held `tyrunasj@synergy.eu` while the
 * pinned login was `tyrunasj`. Wider, and somebody votes as somebody else, which is the one thing
 * this tool exists to prevent.
 *
 * So both directions are tested here, and the refusals matter more than the acceptances.
 */

const PERSON = {
  recId: 'E1',
  category: 'employee',
  displayName: 'Tyrunas Jokubauskas',
  loginId: 'tyrunasj',
  primaryEmail: 'tyrunasj@synergy.eu',
  matchedOn: 'LoginID',
  provenance: 'asserted',
} as const;

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** One vote row as Ivanti returns it, with only the owner fields varying per test. */
function setup(row: Record<string, unknown>) {
  const { connection } = connectionFixture({
    entities: { frs_approvalvotetracking: {} },
    capability: { tier: 'session' },
    responses: { frs_approvalvotetrackings: { value: [{ RecId: 'V1', Status: 'Pending', ...row }] } },
  });

  const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
  context.pin?.pin({ ...PERSON });

  return {
    tool: createVoteOnApprovalTool({
      connection,
      gate: OPEN_GATE,
      logger: logger(),
      ownRecordsOnly: false,
      actions: OPEN_ACTIONS,
    }),
    context,
  };
}

const text = (result: { content: { type: string; text?: string }[] }): string =>
  result.content[0]?.text ?? '';

/** The refusal this tool gives when the row is not the pinned person's. */
const REFUSED = "A vote can only be cast on one's own approval";

describe('vote_on_approval — whose row it is', () => {
  // Ivanti spells the approver differently per row. Each of these is the same person.
  it.each([
    ['a login in Owner', { Owner: 'tyrunasj' }],
    ['an EMAIL in Owner', { Owner: 'tyrunasj@synergy.eu', Owner_Valid: 'E1' }],
    ['a display name in Owner', { Owner: 'Tyrunas Jokubauskas' }],
    ['only Owner_Valid, with Owner naming something else', { Owner: '', Owner_Valid: 'E1' }],
    ['case that does not match', { Owner: 'TYRUNASJ' }],
    // Ivanti assembles the display name and leaves the gap where a middle name is not set.
    ['a display name with the middle-name gap', { Owner: 'Tyrunas   Jokubauskas' }],
  ])('accepts a row identified by %s', async (_label, row) => {
    const { tool, context } = setup(row);

    const result = await tool.handler({ approvalId: 'V1', decision: 'approve' }, context);

    // It gets past ownership and fails later, on a tenant fixture with no quick actions — which is
    // the point: the assertion is that it did NOT stop at the ownership check.
    expect(text(result)).not.toContain(REFUSED);
  });

  // The direction that matters. None of these is the pinned person.
  it.each([
    ["somebody else's login", { Owner: 'HSanders' }],
    ["somebody else's email", { Owner: 'hsanders@synergy.eu' }],
    ["somebody else's RecId", { Owner: '', Owner_Valid: 'E2' }],
    ['nobody at all', { Owner: '' }],
    // A prefix is not a match: `tyrunasj` must not open `tyrunasj2`'s approvals.
    ['a login this one is a prefix of', { Owner: 'tyrunasj2' }],
  ])('refuses a row identified by %s', async (_label, row) => {
    const { tool, context } = setup(row);

    const result = await tool.handler({ approvalId: 'V1', decision: 'approve' }, context);

    expect(text(result)).toContain(REFUSED);
  });

  // The message that sent this bug undiagnosed for a release: it named the same person twice.
  it('names what it compared, rather than asserting the owner is someone else', async () => {
    const { tool, context } = setup({ Owner: 'HSanders' });

    const result = await tool.handler({ approvalId: 'V1', decision: 'approve' }, context);

    expect(text(result)).toContain('waiting on HSanders');
    expect(text(result)).toContain('tyrunasj@synergy.eu');
  });

  it('refuses before reading the row when nobody is pinned', async () => {
    const { tool } = setup({ Owner: 'tyrunasj' });
    const bare: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };

    const result = await tool.handler({ approvalId: 'V1', decision: 'approve' }, bare);

    expect(text(result)).toContain('act_as');
  });

  /**
   * Two people called John Smith. `Owner_Valid` used to be one clause in an OR with the `Owner`
   * spellings, so a row naming the OTHER John Smith's employee record still matched on the shared
   * display name — and each could vote on the other's approval, recorded as the other's decision.
   */
  it.each([
    ['the same display name', { Owner: 'Tyrunas Jokubauskas', Owner_Valid: 'E2' }],
    ['the same login spelling', { Owner: 'tyrunasj', Owner_Valid: 'E2' }],
    ['the same address', { Owner: 'tyrunasj@synergy.eu', Owner_Valid: 'E2' }],
  ])("refuses a namesake's row with %s, because Owner_Valid decides alone", async (_label, row) => {
    const { tool, context } = setup(row);

    const result = await tool.handler({ approvalId: 'V1', decision: 'approve' }, context);

    expect(text(result)).toContain(REFUSED);
    expect(text(result)).toContain('someone who shares that name');
  });
});

/**
 * After the vote, which used to count as done once the row was merely "no longer Pending" — the
 * wrong decision, an unreadable approval and a reason left behind on a failed vote all passed.
 */
describe('vote_on_approval — what it reports after voting', () => {
  const MINE = { RecId: 'V1', Owner: 'tyrunasj', Owner_Valid: 'E1', ParentLink_RecID: 'A1', Reason: null };

  interface Script {
    /** Each read of the vote row in turn: before the vote, after it, after a clean-up. */
    reads: (Record<string, unknown> | Error)[];
    approval?: Record<string, unknown> | Error;
    /** Each PATCH in turn: undefined succeeds. */
    patches?: (Error | undefined)[];
    action?: unknown;
  }

  function scripted(script: Script) {
    const { connection } = connectionFixture({
      entities: { frs_approvalvotetracking: {} },
      capability: { tier: 'session' },
      sessionCalls: {
        GetObjectQuickActions: [
          ['qa-approve', 'Approve Vote', 'Action'],
          ['qa-deny', 'Deny Vote', 'Action'],
        ],
        SaveDataExecuteAction: script.action ?? { status: 'OK', saved: true },
      },
    });

    const patched: unknown[] = [];
    vi.spyOn(connection.transport, 'request').mockImplementation((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'PATCH') {
        patched.push(init?.body);
        const outcome = script.patches?.shift();
        return outcome === undefined ? Promise.resolve(undefined as never) : Promise.reject(outcome);
      }
      if (url.includes('frs_approvals(')) {
        return script.approval instanceof Error
          ? Promise.reject(script.approval)
          : Promise.resolve(script.approval as never);
      }
      const next = script.reads.shift();
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve({ value: next === undefined ? [] : [next] } as never);
    });

    const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
    context.pin?.pin({ ...PERSON });
    const tool = createVoteOnApprovalTool({
      connection,
      gate: OPEN_GATE,
      logger: logger(),
      ownRecordsOnly: false,
      actions: OPEN_ACTIONS,
    });
    return { tool, context, patched };
  }

  const pending = { ...MINE, Status: 'Pending' };

  it('reports a vote that landed as the decision made', async () => {
    const { tool, context } = scripted({
      reads: [pending, { ...MINE, Status: 'Approved' }],
      approval: { RecId: 'A1', Status: 'Approved' },
    });

    const result = await tool.handler({ approvalId: 'V1', decision: 'approve' }, context);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result))).toMatchObject({ decision: 'Approved', approval: 'Approved' });
  });

  it('fails a vote that landed as the OPPOSITE decision', async () => {
    const { tool, context } = scripted({
      reads: [pending, { ...MINE, Status: 'Approved' }],
      approval: { RecId: 'A1', Status: 'Approved' },
    });

    const result = await tool.handler({ approvalId: 'V1', decision: 'deny' }, context);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('OPPOSITE');
  });

  it('reports a status it cannot place as it reads, rather than as the decision', async () => {
    const { tool, context } = scripted({
      reads: [pending, { ...MINE, Status: 'Complete' }],
      approval: { RecId: 'A1', Status: 'Complete' },
    });

    const result = JSON.parse(
      text(await tool.handler({ approvalId: 'V1', decision: 'approve' }, context)),
    ) as Record<string, unknown>;

    expect(result['decisionNote']).toContain("reads 'Complete'");
  });

  it('says when the approval behind the vote could not be read, instead of a bare null', async () => {
    const { tool, context } = scripted({
      reads: [pending, { ...MINE, Status: 'Approved' }],
      approval: new Error('timeout'),
    });

    const result = JSON.parse(
      text(await tool.handler({ approvalId: 'V1', decision: 'approve' }, context)),
    ) as Record<string, unknown>;

    expect(result['approval']).toBeNull();
    expect(result['note']).toContain('could not be read back');
  });

  it('takes the reason off again when the vote did not register', async () => {
    const { tool, context, patched } = scripted({
      reads: [pending, pending, pending],
    });

    const result = await tool.handler(
      { approvalId: 'V1', decision: 'deny', reason: 'Over budget' },
      context,
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('did not register');
    expect(text(result)).not.toContain('could NOT be taken off');
    expect(patched).toEqual([{ Reason: 'Over budget' }, { Reason: null }]);
  });

  it('says the reason is still there when taking it off failed', async () => {
    const { tool, context } = scripted({
      reads: [pending, pending],
      patches: [undefined, new Error('refused')],
    });

    const result = await tool.handler(
      { approvalId: 'V1', decision: 'deny', reason: 'Over budget' },
      context,
    );

    expect(text(result)).toContain('could NOT be taken off');
    expect(text(result)).toContain('Over budget');
  });

  it('says the reason is still there when the action itself failed', async () => {
    const { tool, context } = scripted({
      reads: [pending, { ...pending, Reason: 'Over budget' }],
      action: new Error('Ivanti unavailable'),
    });

    const result = await tool.handler(
      { approvalId: 'V1', decision: 'deny', reason: 'Over budget' },
      context,
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('could not be cast (Ivanti unavailable)');
    expect(text(result)).toContain('could NOT be taken off');
  });

  it('leaves the failure to the ordinary explanation when nothing was left behind', async () => {
    const { tool, context, patched } = scripted({
      reads: [pending, pending],
      action: new Error('Ivanti unavailable'),
    });

    const result = await tool.handler(
      { approvalId: 'V1', decision: 'deny', reason: 'Over budget' },
      context,
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Ivanti unavailable');
    expect(text(result)).not.toContain('could NOT be taken off');
    expect(patched).toHaveLength(2);
  });

  // The action ran and may have registered: a failure here would invite a second vote.
  it('does not invite a second vote when the row cannot be read back afterwards', async () => {
    const { tool, context } = scripted({ reads: [pending, new Error('timeout')] });

    const result = await tool.handler({ approvalId: 'V1', decision: 'approve' }, context);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Do NOT cast it again');
  });
});
