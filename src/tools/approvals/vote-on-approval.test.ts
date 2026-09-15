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
});
