// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import type { Logger } from '../../logger.js';
import { createListNotesTool } from './list-notes.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const body = (result: CallToolResult): Record<string, unknown> => {
  const [block] = result.content;
  return JSON.parse(block?.type === 'text' ? block.text : '{}') as Record<string, unknown>;
};

const note = (i: number) => ({
  RecId: `n${String(i)}`,
  Subject: `note ${String(i)}`,
  NotesBody: 'text',
  PublishToWeb: true,
});

/** Notes and journals are matched by URL: `journal__notess` for the notes, `journals` for all. */
const listNotes = (responses: Record<string, unknown>) => {
  const { connection } = connectionFixture({
    entities: {
      incident: {
        fields: [field('RecId'), field('Subject')],
        relationships: [{ name: 'IncidentContainsJournal', target: 'journal' }],
      },
    },
    responses,
  });
  return createListNotesTool({
    connection,
    gate: OPEN_GATE,
    logger: logger(),
    ownRecordsOnly: false,
    actions: OPEN_ACTIONS,
  });
};

describe('list_notes', () => {
  it('says the page is not all of the notes, and how many there are', async () => {
    // Twenty were returned and the other forty were thrown away with the count.
    const tool = listNotes({
      journal__notess: { value: Array.from({ length: 20 }, (_, i) => note(i)), '@odata.count': 60 },
      journals: { value: [{ RecId: 'j1' }], '@odata.count': 70 },
    });

    const result = body(await tool.handler({ object: 'Incidents', recordId: 'i1' }));

    expect(result).toMatchObject({ returned: 20, total: 60, hasMore: true });
    expect(String(result['moreNotes'])).toContain('NOT ALL THE NOTES');
  });

  it('takes the notes’ total off the journal count, not the page', async () => {
    // Every note is a journal entry too. 70 − 20 reported forty notes as Ivanti's own traffic.
    const tool = listNotes({
      journal__notess: { value: Array.from({ length: 20 }, (_, i) => note(i)), '@odata.count': 60 },
      journals: { value: [{ RecId: 'j1' }], '@odata.count': 70 },
    });

    const result = body(await tool.handler({ object: 'Incidents', recordId: 'i1' }));

    expect(result['otherJournalEntries']).toBe(10);
  });

  it('does not call a count it could not read "no other activity"', async () => {
    const tool = listNotes({
      journal__notess: { value: [note(1)], '@odata.count': 1 },
      journals: new Error('Ivanti 500'),
    });

    const result = body(await tool.handler({ object: 'Incidents', recordId: 'i1' }));

    expect(result).not.toHaveProperty('otherJournalEntries');
    expect(String(result['alsoOnThisRecord'])).toContain('UNKNOWN');
    expect(String(result['alsoOnThisRecord'])).not.toContain('genuinely');
  });

  it('treats a journal page without a count as a floor, not a number', async () => {
    const tool = listNotes({
      journal__notess: { value: [note(1)], '@odata.count': 1 },
      journals: { value: [{ RecId: 'j1' }] },
    });

    const result = body(await tool.handler({ object: 'Incidents', recordId: 'i1' }));

    expect(result).not.toHaveProperty('otherJournalEntries');
    expect(String(result['alsoOnThisRecord'])).toContain('UNKNOWN');
  });

  it('still says a real zero is one', async () => {
    const tool = listNotes({
      journal__notess: { value: [note(1)], '@odata.count': 1 },
      journals: { value: [{ RecId: 'j1' }], '@odata.count': 1 },
    });

    const result = body(await tool.handler({ object: 'Incidents', recordId: 'i1' }));

    expect(result).toMatchObject({ otherJournalEntries: 0, hasMore: false });
    expect(String(result['alsoOnThisRecord'])).toContain('genuinely');
  });
});
