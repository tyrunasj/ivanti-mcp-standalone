// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { connectionFixture, field } from '../../ivanti/connection.fixture.js';
import { ANONYMOUS } from '../../auth/identity.js';
import { createSessionPin } from '../../auth/identity-pin.js';
import type { Logger } from '../../logger.js';
import { OPEN_ACTIONS } from '../shared/action-gate.js';
import { OPEN_GATE } from '../shared/object-gate.js';
import type { CallContext } from '../tool-definition.js';
import { createAddNoteTool } from './add-note.js';

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const text = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
};
const body = (result: CallToolResult): Record<string, unknown> =>
  JSON.parse(text(result) || '{}') as Record<string, unknown>;

const PERSON = {
  recId: 'E1',
  category: 'employee',
  displayName: 'Harold Sanders',
  loginId: 'HSanders',
  matchedOn: 'LoginID',
  provenance: 'asserted',
} as const;

function pinned(): CallContext {
  const context: CallContext = { identity: ANONYMOUS, pin: createSessionPin(ANONYMOUS) };
  context.pin?.pin({ ...PERSON });
  return context;
}

const TICKET = { "incidents('i1')": { RecId: 'i1', ProfileLink_RecID: 'E1', ReadOnly: false } };
const POSTED = { 'POST journal__notess': { RecId: 'n1', NotesBody: 'hello', PublishToWeb: false } };
const STORED = (row: Record<string, unknown>) => ({
  journal__notess: { value: [{ RecId: 'n1', NotesBody: 'hello', ...row }] },
});

function tool(responses: Record<string, unknown>, ownRecordsOnly = false) {
  const { connection, urls } = connectionFixture({
    entities: {
      incident: {
        fields: [field('RecId'), field('ProfileLink_RecID'), field('ProfileLink_Category')],
      },
      employee: {},
      journal__notes: {},
    },
    responses,
  });
  return {
    urls,
    addNote: createAddNoteTool({
      connection,
      gate: OPEN_GATE,
      logger: logger(),
      ownRecordsOnly,
      actions: OPEN_ACTIONS,
    }),
  };
}

const ARGS = { object: 'Incidents', recordId: 'i1', note: 'hello' };

describe('add_note', () => {
  it('writes the note, reads it back, and reports what was stored', async () => {
    const { addNote, urls } = tool({
      ...TICKET,
      ...POSTED,
      ...STORED({ ParentLink_RecID: 'I1', PublishToWeb: false }),
    });

    const result = await addNote.handler(ARGS, pinned());

    expect(result.isError).toBeUndefined();
    expect(body(result)).toMatchObject({
      recordId: 'i1',
      note: { recId: 'n1', body: 'hello', visibleToCustomer: false },
    });
    expect(body(result)['visibilityWarning']).toBeUndefined();
    // The read-back asks for the note by its own id, after the POST.
    const post = urls.findIndex((url) => url.startsWith('POST'));
    expect(urls.slice(post + 1).some((url) => url.includes("RecId%20eq%20'n1'"))).toBe(true);
  });

  it('refuses in full mode when the record is not there, and sends nothing', async () => {
    // The guard hands "not there" back to the tool in `full` mode. It used to be ignored, and
    // the note went out against a parent that does not exist and was reported as written.
    const { addNote, urls } = tool({ ...POSTED, ...STORED({ ParentLink_RecID: 'gone' }) });

    const result = await addNote.handler({ ...ARGS, recordId: 'gone' }, pinned());

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No incidents record with RecId gone');
    expect(text(result)).toContain('no note was written');
    expect(urls.some((url) => url.startsWith('POST'))).toBe(false);
  });

  it('refuses in enduser mode when the record is not there, in the words used for “not yours”', async () => {
    const { addNote, urls } = tool({ ...POSTED }, true);

    const result = await addNote.handler({ ...ARGS, recordId: 'gone' }, pinned());

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('No such record is available to you.');
    expect(urls.some((url) => url.startsWith('POST'))).toBe(false);
  });

  it('reports a note that answered the POST but is not there when read back', async () => {
    const { addNote } = tool({ ...TICKET, ...POSTED, journal__notess: { value: [] } });

    const result = await addNote.handler(ARGS, pinned());

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('found no such note');
    expect(text(result)).toContain('NOT on incidents i1');
  });

  it('reports a note that landed on a different record as not written', async () => {
    const { addNote } = tool({ ...TICKET, ...POSTED, ...STORED({ ParentLink_RecID: 'other' }) });

    const result = await addNote.handler(ARGS, pinned());

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('different record (other)');
  });

  it('says there is no confirmation when the read-back itself fails', async () => {
    const { addNote } = tool({
      ...TICKET,
      ...POSTED,
      'journal__notess?': new Error('Ivanti 500'),
    });

    const result = await addNote.handler(ARGS, pinned());

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no confirmation');
    // The id travels, so the caller can look for it rather than write a duplicate.
    expect(text(result)).toContain('n1');
  });

  it('warns when the stored visibility is not the one asked for', async () => {
    const { addNote } = tool({
      ...TICKET,
      ...POSTED,
      ...STORED({ ParentLink_RecID: 'i1', PublishToWeb: true }),
    });

    const result = await addNote.handler(ARGS, pinned());

    expect(result.isError).toBeUndefined();
    expect(String(body(result)['visibilityWarning'])).toContain('VISIBLE to the customer');
  });
});
