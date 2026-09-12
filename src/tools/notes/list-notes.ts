import { z } from 'zod';
import { MAX_TOP } from '../../ivanti/odata/query.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { assertOwnRecordById } from '../shared/own-records.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { readNotes, toNote } from './notes.js';

const DEFAULT_TOP = 20;

export function createListNotesTool(deps: IvantiToolDeps): ToolDefinition {
  const enduser = deps.ownRecordsOnly;

  return defineTool({
    name: 'list_notes',
    title: 'List notes',
    description:
      "The notes people have written on a record, newest first.\n\n" +
      'USE THIS RATHER THAN get_related_records for a ticket\'s history. The journal relationship ' +
      "returns Ivanti's own email traffic as well — escalation and assignment notices, which on a " +
      'stock tenant outnumber the human notes entirely — while this reads the notes object ' +
      'directly and returns nothing else.\n\n' +
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

        return jsonResult({
          object: parent.entitySet,
          recordId: args.recordId,
          returned: notes.length,
          ...(enduser
            ? { showing: 'notes published to the customer; internal ones are not listed' }
            : {}),
          notes,
        });
      }),
  });
}
