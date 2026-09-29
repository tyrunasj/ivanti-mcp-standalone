// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { tenantCategorySpelling } from '../../ivanti/parent-link.js';
import { buildQuery, quoteOdataString, withQuery } from '../../ivanti/odata/query.js';
import { NOTE_ENTITY_SET, resolveNoteObject, toNote } from './notes.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiTransport } from '../../ivanti/http/transport.js';
import { readRows } from '../shared/read-rows.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { assertRecordWritable, authorFields } from '../shared/own-records.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { transportFor } from '../shared/transport-for.js';

/** The note as Ivanti stored it, read by its own id rather than trusted from the POST's answer. */
async function readNote(
  transport: IvantiTransport,
  recId: string,
): Promise<OdataRecord | undefined> {
  const url = withQuery(
    transport.routes.entitySet(NOTE_ENTITY_SET),
    buildQuery({ filter: `RecId eq ${quoteOdataString(recId)}`, top: 1 }),
  );
  return readRows<OdataRecord>(await transport.request<OdataRecord>(url), url)[0];
}

const sameId = (a: unknown, b: string): boolean =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

export function createAddNoteTool(deps: IvantiToolDeps): ToolDefinition {
  const enduser = deps.ownRecordsOnly;

  return defineTool({
    name: 'add_note',
    title: 'Add a note',
    description:
      'Writes a note onto a record — a comment, an update, a question.\n\n' +
      'This is the ordinary way to say something on a ticket. It does not change the ticket ' +
      'itself: it adds to the history, which is what a person reading the ticket later will ' +
      'see.\n\n' +
      (enduser
        ? 'The note is published to the customer, because it is theirs.'
        : 'By default the note is INTERNAL and the customer does not see it in the self-service ' +
          'portal. Pass `visibleToCustomer: true` when it is a reply to them rather than a note ' +
          'for colleagues — that distinction cannot be changed by them afterwards.'),
    annotations: {
      title: 'Add a note',
      readOnlyHint: false,
      // It adds to the history; it does not alter or remove anything already there.
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('The record\'s Business Object: `Incident#`, `Incidents` or `incident`.'),
      recordId: z.string().describe("The record's RecId."),
      note: z.string().min(1).describe('What to say. This is the body of the note.'),
      subject: z
        .string()
        .optional()
        .describe('A one-line summary shown before the body. Optional.'),
      ...(enduser
        ? {}
        : {
            visibleToCustomer: z
              .boolean()
              .optional()
              .describe(
                'Default false. True publishes it to the self-service portal, where the person ' +
                  'the ticket is for will read it.',
              ),
          }),
    },
    handler: (args, context) =>
      runTool('add_note', deps.logger, async () => {
        const transport = transportFor(deps.connection.transport, context);
        const parent = await resolveObject(deps, args.object);

        // A note is written on a ticket, so the ticket decides whether it may be written — both
        // whose it is and whether it is still open.
        const ticket = await assertRecordWritable(deps, context, parent, args.recordId);

        // `full` mode only: in `enduser` a missing record has already been refused, in the same
        // words as someone else's. The guard hands "not there" back for the tool to explain, and
        // this tool used to ignore it — so a note was POSTed against a record that does not
        // exist and reported as written, stored on nothing and read by nobody.
        if (ticket === undefined) {
          return errorResult(
            `No ${parent.entitySet} record with RecId ${args.recordId}, so no note was written. ` +
              'This is checked before writing because a note posted against a record that is ' +
              'not there is not refused — it would be stored on nothing, where no one reads it. ' +
              'Check the RecId: get_record answers for the record you meant.',
          );
        }

        const notes = await resolveNoteObject(deps);
        const category = await tenantCategorySpelling(
          transport,
          NOTE_ENTITY_SET,
          parent.entity.name,
        );

        // An end user's own comment is theirs to see; a staff note is internal unless said
        // otherwise. `JournalType` and `Category` are set by Ivanti on this extension.
        const visible = enduser ? true : ((args as { visibleToCustomer?: boolean }).visibleToCustomer ?? false);

        const created = await transport.request<OdataRecord>(
          transport.routes.entitySet(notes.entitySet),
          {
            method: 'POST',
            body: {
              // In `enduser` the note is the person's own, so it carries their name rather than
              // the service account's. `LastModBy` still records the account that wrote it.
              ...(enduser ? authorFields(context.pin?.person()?.loginId) : {}),
              NotesBody: args.note,
              ...(args.subject === undefined ? {} : { Subject: args.subject }),
              ParentLink_RecID: args.recordId,
              ParentLink_Category: category,
              PublishToWeb: visible,
            },
          },
        );

        const note = created === undefined ? undefined : toNote(created);
        if (note === undefined) {
          return errorResult(
            'Ivanti accepted the note without answering with one, so there is no evidence it was ' +
              'stored. Check with list_notes before writing it again.',
          );
        }

        // Read back by its own id. A POST that answers with a note is not proof the note is on
        // THIS record — Ivanti accepts writes it then ignores — and "no note landed" must never
        // read as "written".
        const stored = await readNote(transport, note.recId).catch((error: unknown) =>
          error instanceof Error ? error : new Error(String(error)),
        );

        if (stored instanceof Error) {
          return errorResult(
            `Ivanti accepted the note (id ${note.recId}), but reading it back failed: ` +
              `${stored.message.slice(0, 200)}. So there is no confirmation it is on the record. ` +
              'Check with list_notes before writing it again — a second write would duplicate it.',
          );
        }

        if (stored === undefined || !sameId(stored['ParentLink_RecID'], args.recordId)) {
          const where =
            stored === undefined
              ? 'found no such note'
              : typeof stored['ParentLink_RecID'] === 'string' && stored['ParentLink_RecID'] !== ''
                ? `found it on a different record (${stored['ParentLink_RecID']})`
                : 'found it on no record at all';
          deps.logger.error('ivanti note did not land', { object: parent.entitySet });
          return errorResult(
            `Ivanti answered as though the note was written, but reading it back ${where}. It is ` +
              `NOT on ${parent.entitySet} ${args.recordId}, so do not tell the person it was ` +
              'added. Check with list_notes before trying again.',
          );
        }

        const written = toNote(stored) ?? note;

        deps.logger.info('ivanti note added', { object: parent.entitySet });

        return jsonResult({
          object: parent.entitySet,
          recordId: args.recordId,
          // What was stored, not what was sent: the read-back row.
          note: written,
          // Who can read it is the one part of a note that cannot be taken back, so a stored
          // visibility different from the one asked for is said out loud.
          ...(written.visibleToCustomer === visible
            ? {}
            : {
                visibilityWarning:
                  `The note is on the record, but Ivanti stored it as ` +
                  `${written.visibleToCustomer ? 'VISIBLE to the customer' : 'internal'} where ` +
                  `${visible ? 'visible to the customer' : 'internal'} was asked. Do not write it ` +
                  'again; say so, and have its visibility corrected in Ivanti.',
              }),
        });
      }),
  });
}
