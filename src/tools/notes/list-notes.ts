import { z } from 'zod';
import { MAX_TOP } from '../../ivanti/odata/query.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { assertOwnRecordById } from '../shared/own-records.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { countJournalEntries, readNotes, toNote } from './notes.js';

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
      'history can answer zero here. The answer says how many other journal entries exist; read ' +
      'them with get_related_records on the journal relationship when someone asks what has ' +
      'happened rather than what was said.\n\n' +
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
        const parent = await resolveObject(deps, args.object);

        // The note is reached through the ticket, so the ticket is what is checked.
        await assertOwnRecordById(deps, context, parent, args.recordId);

        const rows = await readNotes(deps, args.recordId, {
          visibleOnly: enduser,
          top: args.top ?? DEFAULT_TOP,
        });

        const notes = rows.flatMap((row) => {
          const note = toNote(row);
          return note === undefined ? [] : [note];
        });

        // What was NOT returned, because a bare `returned: 0` on a record with eight escalation
        // entries reads as "nothing has happened here" — which is the opposite of true.
        const allEntries = await countJournalEntries(deps, args.recordId).catch(() => 0);
        const otherEntries = Math.max(0, allEntries - notes.length);

        return jsonResult({
          object: parent.entitySet,
          recordId: args.recordId,
          returned: notes.length,
          ...(otherEntries === 0
            ? {}
            : {
                otherJournalEntries: otherEntries,
                alsoOnThisRecord:
                  `${String(otherEntries)} journal entries that are not notes — Ivanti's own ` +
                  'emails, escalations and assignment notices. Read them with ' +
                  'get_related_records on the journal relationship.',
              }),
          ...(enduser
            ? { showing: 'notes published to the customer; internal ones are not listed' }
            : {}),
          notes,
        });
      }),
  });
}
