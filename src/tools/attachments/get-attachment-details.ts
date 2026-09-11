import { z } from 'zod';
import { buildQuery, quoteOdataString, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

/** Ivanti's own names, kept as they are so a caller can filter on them elsewhere. */
const DETAIL_FIELDS = [
  'RecId',
  'ATTACHNAME',
  'ATTACHDESC',
  'AttachmentSize',
  'ParentLink_Category',
  'ParentLink_RecID',
  'CreatedBy',
  'CreatedDateTime',
  'LastModBy',
  'LastModDateTime',
  'SaveType',
  'Uploaded',
  'ReadOnly',
];

export function createGetAttachmentDetailsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_attachment_details',
    title: 'Get attachment details',
    description:
      'What an attachment is: its filename, size in bytes, description, who uploaded it and ' +
      'when, and which record it hangs off.\n\n' +
      'This does not return the file. Reading the bytes is a separate concern — most attachments ' +
      'are screenshots and documents that would be useless as tokens.\n\n' +
      'To find attachment ids for a record, use get_related_records with the record\'s ' +
      'attachment relationship, or list_records on the attachment object filtered by ' +
      '`ParentLink_RecID`.',
    annotations: {
      title: 'Get attachment details',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      attachmentId: z.string().describe('The 32-character RecId of the attachment.'),
    },
    handler: (args) =>
      runTool('get_attachment_details', deps.logger, async () => {
        // Read through the Business Object rather than `/rest/Attachment?ID=`: that endpoint
        // streams the file itself, so metadata would have to be sniffed from response headers,
        // and it carries neither the parent link nor the description.
        const url = withQuery(
          deps.connection.transport.routes.entitySet('attachments'),
          buildQuery({ filter: `RecId eq ${quoteOdataString(args.attachmentId)}`, top: 1 }),
        );

        const payload = await deps.connection.transport.request<OdataRecord>(url);
        const [row] = readCollection<OdataRecord>(payload, url);

        if (row === undefined) {
          return errorResult(`No attachment with RecId ${args.attachmentId}.`);
        }

        // An attachment is only as reachable as the record it hangs off: `ParentLink_Category`
        // names that object, so a gated deployment checks it rather than the attachment table.
        const parent = row['ParentLink_Category'];
        if (typeof parent === 'string' && parent !== '' && !deps.gate.allows(parent)) {
          return errorResult(
            `That attachment belongs to a ${parent} record, which this server does not expose. ` +
              `It serves ${deps.gate.allowed.join(', ')}.`,
          );
        }

        const details: OdataRecord = {};
        for (const field of DETAIL_FIELDS) {
          if (field in row && row[field] !== null && row[field] !== '') details[field] = row[field];
        }

        return jsonResult({ attachment: details });
      }),
  });
}
