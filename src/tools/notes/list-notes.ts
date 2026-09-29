// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { MAX_TOP } from '../../ivanti/odata/query.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { assertOwnRecordById } from '../shared/own-records.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { countJournalEntries, readNotes, toNote } from './notes.js';
import { transportFor } from '../shared/transport-for.js';

const DEFAULT_TOP = 20;

export function createListNotesTool(deps: IvantiToolDeps): ToolDefinition {
  const enduser = deps.ownRecordsOnly;

  return defineTool({
    name: 'list_notes',
    title: 'List notes',
    description:
      "The notes people have written on a record, newest first.\n\n" +
      'THIS IS NOT THE WHOLE HISTORY. It returns human-written notes only. Ivanti also files its ' +
      'own email traffic, escalations and assignment notices as journal entries on the same ' +
      'record, and on a stock tenant those outnumber the notes entirely — a record with a long ' +
      'history can answer zero here. The answer says how many other journal entries exist.\n\n' +
      (enduser
        ? 'THIS DEPLOYMENT DOES NOT EXPOSE THOSE OTHER ENTRIES — the count is all there is, so ' +
          'say the ticket has system activity on it rather than implying nothing happened, and ' +
          'do not promise to fetch the history.\n\n'
        : 'Read them with get_related_records on the journal relationship the answer names — ' +
          'but that returns SUBJECT LINES ONLY, because the `journal` group object has no body ' +
          'field. The text of an email entry lives on the `journal__emails` subtype.\n\n') +
      (enduser
        ? 'Only notes published to the self-service portal are returned. A note an agent wrote ' +
          'for internal use is not shown, because it was not written to be read by the customer.'
        : 'Both internal notes and replies to the customer are returned; `visibleToCustomer` ' +
          'says which is which.'),
    annotations: {
      title: 'List notes',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('The record\'s Business Object: `Incident#`, `Incidents` or `incident`.'),
      recordId: z.string().describe("The record's RecId."),
      top: z
        .number()
        .int()
        .min(1)
        .max(MAX_TOP)
        .optional()
        .describe(`Notes to return, newest first. Default ${String(DEFAULT_TOP)}.`),
    },
    handler: (args, context) =>
      runTool('list_notes', deps.logger, async () => {
        const transport = transportFor(deps.connection.transport, context);
        const parent = await resolveObject(deps, args.object);

        // The note is reached through the ticket, so the ticket is what is checked.
        await assertOwnRecordById(deps, context, parent, args.recordId);

        const { rows, total } = await readNotes(deps, transport, args.recordId, {
          visibleOnly: enduser,
          top: args.top ?? DEFAULT_TOP,
        });

        const notes = rows.flatMap((row) => {
          const note = toNote(row);
          return note === undefined ? [] : [note];
        });
        // Against the rows Ivanti sent, not the notes built from them: the question is whether
        // the page was all there is.
        const hasMore = total.total > rows.length;

        // What was NOT returned, because a bare `returned: 0` on a record with eight escalation
        // entries reads as "nothing has happened here" — which is the opposite of true.
        //
        // A failed count is NOT a zero. It was read as one, and the zero then became the
        // sentence below asserting this record "genuinely has no other activity" — a claim made
        // on no evidence at all. Nor is a floor: `exact: false` means "at least".
        const allEntries = await countJournalEntries(deps, transport, args.recordId).catch(
          () => undefined,
        );
        // Every note is also a journal entry, so it is the notes' TOTAL that comes off — not the
        // page. Subtracting the twenty shown from a record with sixty notes reported forty notes
        // as "Ivanti's own emails and escalations".
        const otherEntries =
          allEntries === undefined || !allEntries.exact
            ? undefined
            : Math.max(0, allEntries.total - total.total);

        /**
         * This object's own journal relationship, read from its metadata rather than assumed.
         *
         * The name was hard-coded as `IncidentContainsJournal`, which is right for exactly one
         * object — and the prose said "naming this object's own journal relationship" as though
         * the reader could work the rest out. They cannot: incident has ~35 relationships, and
         * `get_object_metadata`'s `search` filters fields but not relationships, so finding it
         * meant dumping the whole list and grepping.
         */
        const journalRelationship = parent.entity.relationships.find((relationship) =>
          relationship.target.startsWith('journal'),
        )?.name;

        // In `enduser` the journal is not readable even where the gate names it —
        // `get_related_records` refuses it there, so offering it would be the same dead end.
        const journalReadable = !enduser && deps.gate.allows('journal');

        // In `enduser` the notes counted are the published ones, so what is left over includes
        // any an agent kept internal — said without a separate count, which would be one.
        const notShown = enduser
          ? "Ivanti's own emails, escalations and assignment notices, and any note not published " +
            'to the customer'
          : "Ivanti's own emails, escalations and assignment notices";

        return jsonResult({
          object: parent.entitySet,
          recordId: args.recordId,
          returned: notes.length,
          total: total.total,
          ...(total.exact ? {} : { totalIsExact: false }),
          hasMore,
          ...(hasMore
            ? {
                moreNotes:
                  `THESE ARE NOT ALL THE NOTES: ${total.exact ? '' : 'at least '}` +
                  `${String(total.total)} match and ${String(rows.length)} are shown, newest ` +
                  `first. Pass a larger \`top\` (up to ${String(MAX_TOP)}) for older ones.`,
              }
            : {}),
          // Always, including zero, whenever it is known. Omitting it when there was nothing to
          // report made "0 notes and 0 journals" and "0 notes, this feature is not present"
          // render identically — and the empty answer is exactly where a reader most needs to
          // know the count is real. When it is NOT known, it is absent and the line below says so.
          ...(otherEntries === undefined ? {} : { otherJournalEntries: otherEntries }),
          // Where to go next depends on whether the caller can go there. In `enduser` the journal
          // object is outside the gate, so naming `get_related_records` sends them into a
          // refusal that points straight back here — a circular dead end that cost a tester two
          // calls to discover.
          ...(journalReadable && journalRelationship !== undefined
            ? { journalRelationship }
            : {}),
          alsoOnThisRecord:
            otherEntries === undefined
              ? 'The other journal entries on this record could not be counted, so whether it ' +
                `has other activity — ${notShown} — is UNKNOWN. Do not say it has none.`
              : otherEntries === 0
                ? 'No journal entries beyond the notes above — this record genuinely has no ' +
                  'other activity logged, rather than the count being unavailable.'
                : journalReadable
                  ? `${String(otherEntries)} journal entries that are not notes — ${notShown}. ` +
                    'Read them with ' +
                    `get_related_records({ relationship: '${journalRelationship ?? 'the journal relationship'}' }).`
                  : `${String(otherEntries)} journal entries not listed here — ${notShown}. ` +
                    'This server does not expose them, so the count is all there is: say that ' +
                    'the ticket has system activity on it rather than implying nothing has ' +
                    'happened.',
          ...(enduser
            ? { showing: 'notes published to the customer; internal ones are not listed' }
            : {}),
          notes,
        });
      }),
  });
}
