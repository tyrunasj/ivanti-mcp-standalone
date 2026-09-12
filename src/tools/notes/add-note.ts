import { z } from 'zod';
import { tenantCategorySpelling } from '../../ivanti/parent-link.js';
import { NOTE_ENTITY_SET, resolveNoteObject, toNote } from './notes.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { assertRecordWritable, authorFields } from '../shared/own-records.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

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
        const parent = await resolveObject(deps, args.object);

        // A note is written on a ticket, so the ticket decides whether it may be written — both
        // whose it is and whether it is still open.
        await assertRecordWritable(deps, context, parent, args.recordId);

        const notes = await resolveNoteObject(deps);
        const category = await tenantCategorySpelling(
          deps.connection.transport,
          NOTE_ENTITY_SET,
          parent.entity.name,
        );

        // An end user's own comment is theirs to see; a staff note is internal unless said
        // otherwise. `JournalType` and `Category` are set by Ivanti on this extension.
        const visible = enduser ? true : ((args as { visibleToCustomer?: boolean }).visibleToCustomer ?? false);

        const created = await deps.connection.transport.request<OdataRecord>(
          deps.connection.transport.routes.entitySet(notes.entitySet),
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

        deps.logger.info('ivanti note added', { object: parent.entitySet });

        return jsonResult({
          object: parent.entitySet,
          recordId: args.recordId,
          note,
        });
      }),
  });
}
