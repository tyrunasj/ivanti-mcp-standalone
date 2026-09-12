import { z } from 'zod';
import { buildQuery, quoteOdataString, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { assertOwnRecordById } from '../shared/own-records.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

export function createDeleteAttachmentTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'delete_attachment',
    title: 'Delete attachment',
    description:
      'Permanently deletes a file from Ivanti. IRREVERSIBLE, and there is no undo.\n\n' +
      'NAME THE FILE TO THE PERSON AND GET AN EXPLICIT YES FIRST — get_attachment_details gives ' +
      'the filename and size. A vague "ok" is not consent, and an attachment is often a ' +
      "ticket's only evidence.\n\n" +
      'THERE IS NO DETACH THAT KEEPS THE FILE. An attachment belongs to its record through its ' +
      'own ParentLink fields; unlink_records does not detach one, it blanks that link and leaves ' +
      'the file on no record where nobody can reach it. If they want it off this ticket but ' +
      'kept, they must download it first.\n\n' +
      'Existence is checked first and again after: Ivanti answers 204 for a delete of an id that ' +
      'never existed, so `deleted: true` here means a file was actually removed.',
    annotations: {
      title: 'Delete attachment',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      attachmentId: z.string().describe("The attachment's RecId, from get_related_records or get_attachment_details."),
    },
    handler: (args, context) =>
      runTool('delete_attachment', deps.logger, async () => {
        const { transport } = deps.connection;
        const read = async (): Promise<OdataRecord | undefined> => {
          const url = withQuery(
            transport.routes.entitySet('attachments'),
            buildQuery({ filter: `RecId eq ${quoteOdataString(args.attachmentId)}`, top: 1 }),
          );
          return readCollection<OdataRecord>(await transport.request<OdataRecord>(url), url)[0];
        };

        const existing = await read();
        const nameOf = (row: OdataRecord): string =>
          typeof row['ATTACHNAME'] === 'string' && row['ATTACHNAME'] !== ''
            ? row['ATTACHNAME']
            : args.attachmentId;

        if (existing === undefined) {
          return errorResult(
            `No attachment with RecId ${args.attachmentId}; nothing was deleted. Ivanti would ` +
              'have answered 204 for this, so it was checked rather than believed.',
          );
        }

        const parent = existing['ParentLink_Category'];
        const parentRecId = existing['ParentLink_RecID'];

        // The file is only as reachable as the record it hangs off, so the gate and the
        // ownership check are both applied to that record rather than to the attachment table.
        if (typeof parent === 'string' && parent !== '' && !deps.gate.allows(parent)) {
          return errorResult(
            `That attachment belongs to a ${parent} record, which this server does not expose. ` +
              `It serves ${deps.gate.allowed.join(', ')}.`,
          );
        }

        if (deps.ownRecordsOnly) {
          if (
            typeof parent !== 'string' ||
            parent === '' ||
            typeof parentRecId !== 'string' ||
            parentRecId === ''
          ) {
            return errorResult(
              'That attachment is on no record, so I cannot tell whether it is yours. Refusing ' +
                'rather than guessing.',
            );
          }
          await assertOwnRecordById(
            deps,
            context,
            await resolveObject(deps, parent),
            parentRecId,
          );
        }

        // The OData route rather than `/api/rest/Attachment?ID=`: both answer 204 whatever the
        // id, and this one is the same route every other delete here uses.
        await transport.request(transport.routes.record('attachments', args.attachmentId), {
          method: 'DELETE',
        });

        // Ivanti's delete is a 204 whatever happened, so the only evidence is the read.
        if ((await read()) !== undefined) {
          return errorResult(
            `Ivanti accepted the delete of '${nameOf(existing)}' ` +
              'but the attachment is still there. It may be locked or held by the record it is on.',
          );
        }

        deps.logger.info('ivanti attachment deleted', {});

        return jsonResult({
          attachmentId: args.attachmentId,
          filename: nameOf(existing),
          deleted: true,
        });
      }),
  });
}
