// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it, vi } from 'vitest';
import { ANONYMOUS } from '../../auth/identity.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import type { EntityMetadata } from '../../ivanti/metadata/csdl.js';
import type { Logger } from '../../logger.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import type { CallContext } from '../tool-definition.js';
import { createListApprovalsTool } from './list-approvals.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** One of two John Smiths — the other is `E2`. */
const JOHN = {
  recId: 'E1',
  category: 'employee',
  displayName: 'John Smith',
  loginId: 'jsmith',
  matchedOn: 'LoginID',
  provenance: 'asserted',
} as const;

const VOTE_FIELDS = ['RecId', 'Owner', 'Owner_Valid', 'Status', 'DueDateTime'];

function setup(rows: Record<string, unknown>[], fields: string[] = VOTE_FIELDS, count?: number) {
  const vote: Partial<EntityMetadata> = { fields: fields.map((name) => field(name)) };
  const { connection, urls } = connectionFixture({
    entities: { frs_approvalvotetracking: vote },
    responses: {
      frs_approvalvotetrackings: {
        value: rows,
        ...(count === undefined ? {} : { '@odata.count': count }),
      },
    },
  });

  const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
  context.pin?.pin({ ...JOHN });

  const tool = createListApprovalsTool({
    connection,
    gate: OPEN_GATE,
    logger: logger(),
    ownRecordsOnly: false,
    actions: OPEN_ACTIONS,
  });
  const run = async (): Promise<Record<string, unknown>> => {
    const result = await tool.handler({}, context);
    const [block] = result.content;
    return JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<string, unknown>;
  };
  return { run, urls, tool, context };
}

const ids = (result: Record<string, unknown>): unknown[] =>
  (result['approvals'] as Record<string, unknown>[]).map((row) => row['approvalId']);

describe('list_approvals — two people with one name', () => {
  // The query keeps `Owner eq '<display name>'`: it is how a row whose Owner holds a display name
  // is found at all. It also fetches the OTHER John Smith's rows, which vote_on_approval refuses.
  it("drops a namesake's row, so the listing and the vote agree", async () => {
    const { run } = setup(
      [
        { RecId: 'V1', Owner: 'John Smith', Owner_Valid: 'E1', Status: 'Pending' },
        { RecId: 'V2', Owner: 'John Smith', Owner_Valid: 'E2', Status: 'Pending' },
        // No `Owner_Valid` at all: the spelling of Owner is all there is, and it is his.
        { RecId: 'V3', Owner: 'jsmith', Owner_Valid: '', Status: 'Pending' },
      ],
      VOTE_FIELDS,
      3,
    );

    const result = await run();

    expect(ids(result)).toEqual(['V1', 'V3']);
    expect(result['leftOut']).toContain('a different employee record');
    // The whole set came back, so the count can be corrected exactly.
    expect(result).toMatchObject({ total: 2, totalIsExact: true });
  });

  it('stops calling the count exact when the dropped rows came from a partial page', async () => {
    const { run } = setup(
      [
        { RecId: 'V1', Owner: 'John Smith', Owner_Valid: 'E1', Status: 'Pending' },
        { RecId: 'V2', Owner: 'John Smith', Owner_Valid: 'E2', Status: 'Pending' },
      ],
      VOTE_FIELDS,
      40,
    );

    expect(await run()).toMatchObject({ total: 39, totalIsExact: false });
  });

  it('refuses a person it cannot resolve, rather than reporting an empty queue', async () => {
    const { tool, context } = setup([]);

    const result = await tool.handler({ person: 'nobody-at-all' }, context);
    const [block] = result.content;

    expect(result.isError).toBe(true);
    expect(block?.type === 'text' ? block.text : '').toContain('This is NOT an empty queue');
  });

  it('says nothing about namesakes when there were none', async () => {
    const { run } = setup([{ RecId: 'V1', Owner: 'jsmith', Owner_Valid: 'E1', Status: 'Pending' }]);

    expect(await run()).not.toHaveProperty('leftOut');
  });
});

/**
 * `DueDateTime` is a field Ivanti ships. An unknown `$orderby` field answers 204 — no rows — so on a
 * tenant without it, every queue read as empty.
 */
describe('list_approvals — the ordering', () => {
  const ROW = { RecId: 'V1', Owner: 'jsmith', Owner_Valid: 'E1', Status: 'Pending' };

  it('sorts by due date where the vote object has one', async () => {
    const { run, urls } = setup([ROW]);

    await run();

    expect(urls.some((url) => decodeURIComponent(url).includes('$orderby=DueDateTime asc'))).toBe(
      true,
    );
  });

  it('sends no ordering where it does not', async () => {
    const { run, urls } = setup([ROW], ['RecId', 'Owner', 'Owner_Valid', 'Status']);

    const result = await run();

    expect(urls.some((url) => url.includes('orderby'))).toBe(false);
    expect(ids(result)).toEqual(['V1']);
  });
});

describe('list_approvals — what is being approved', () => {
  function withSubjects(rows: Record<string, unknown>[], responses: Record<string, unknown>) {
    const { connection } = connectionFixture({
      entities: {
        frs_approvalvotetracking: { fields: VOTE_FIELDS.map((name) => field(name)) },
        change: { fields: [field('RecId'), field('Subject')] },
      },
      responses: { frs_approvalvotetrackings: { value: rows }, ...responses },
    });
    const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
    context.pin?.pin({ ...JOHN });
    const tool = createListApprovalsTool({
      connection,
      gate: OPEN_GATE,
      logger: logger(),
      ownRecordsOnly: false,
      actions: OPEN_ACTIONS,
    });
    return async (): Promise<Record<string, unknown>[]> => {
      const result = await tool.handler({}, context);
      const [block] = result.content;
      const parsed = JSON.parse(block?.type === 'text' ? block.text : '{}') as {
        approvals: Record<string, unknown>[];
      };
      return parsed.approvals;
    };
  }

  const VOTE = {
    RecId: 'V1',
    Owner: 'jsmith',
    Owner_Valid: 'E1',
    Status: 'Pending',
    PrimaryParentObject: 'Change#',
    PrimaryParentRecId: 'C1',
  };

  it('reads the approved record’s subject, status and requester with the approver’s authority', async () => {
    const run = withSubjects([VOTE], {
      "changes('C1')": { RecId: 'C1', Subject: 'Upgrade DB', Status: 'Pending', ProfileFullName: 'Ann Lee' },
    });

    const [approval] = await run();

    expect(approval).toMatchObject({
      subject: 'Upgrade DB',
      requestedBy: 'Ann Lee',
      recordStatus: 'Pending',
      approvalId: 'V1',
    });
  });

  it('keeps requestedBy as an explicit null when the object has no requester field', async () => {
    const run = withSubjects([VOTE], { "changes('C1')": { RecId: 'C1', Subject: 'Upgrade DB' } });

    const [approval] = await run();

    expect(approval).toHaveProperty('requestedBy', null);
  });

  it('lists the approval without a subject when the record cannot be read', async () => {
    const run = withSubjects([VOTE], { "changes('C1')": new Error('Ivanti 500') });

    const [approval] = await run();

    expect(approval).toMatchObject({ approvalId: 'V1' });
    expect(approval).not.toHaveProperty('subject');
  });

  it('skips the subject read for a vote that names no parent', async () => {
    const run = withSubjects([{ ...VOTE, PrimaryParentObject: null }], {});

    const [approval] = await run();

    expect(approval).not.toHaveProperty('requestedBy');
  });
});

describe('list_approvals — an empty queue', () => {
  it('says so as a real zero, and that decided ones are excluded by default', async () => {
    const { tool, context } = setup([], VOTE_FIELDS);

    const result = await tool.handler({}, context);
    const [block] = result.content;
    const parsed = JSON.parse(block?.type === 'text' ? block.text : '{}') as { note: string };

    expect(parsed.note).toContain('REAL ZERO');
    expect(parsed.note).toContain('UNDECIDED');

    const decided = await tool.handler({ includeDecided: true }, context);
    const [again] = decided.content;
    expect((JSON.parse(again?.type === 'text' ? again.text : '{}') as { note: string }).note).toContain(
      'never been asked',
    );
  });
});
