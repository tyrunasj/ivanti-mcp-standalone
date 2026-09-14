// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { buildQuery, quoteOdataString, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import { registersLinkTools, type IvantiToolDeps } from '../shared/deps.js';
import { assertRecordWritable, missingRecordMessage } from '../shared/own-records.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { transportFor } from '../shared/transport-for.js';

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
      (registersLinkTools(deps)
        ? 'own ParentLink fields; unlink_records does not detach one, it blanks that link and leaves '
        : 'own ParentLink fields; blanking that link does not detach the file, it leaves ') +
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
        const transport = transportFor(deps.connection.transport, context);
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
          // See download_attachment: a scoped caller must not be able to tell "no such
          // attachment" from "not yours". The 204 note is still worth saying where there is
          // nothing to hide.
          return errorResult(
            missingRecordMessage(deps) ??
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

        // The parent decides, in both modes. Deleting a file is the one irreversible thing that
        // can be done to a record, and it was the one operation that skipped the closed-record
        // check — so a closed ticket refused notes, attachments, edits and its own deletion, and
        // then let its evidence be destroyed. Found by driving the tools, not by reading them.
        if (typeof parent === 'string' && parent !== '' && typeof parentRecId === 'string' && parentRecId !== '') {
          await assertRecordWritable(deps, context, await resolveObject(deps, parent), parentRecId);
        } else if (deps.ownRecordsOnly) {
          return errorResult(
            'That attachment is on no record, so I cannot tell whether it is yours. Refusing ' +
              'rather than guessing.',
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
