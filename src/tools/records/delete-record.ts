// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { isIvantiNotFound } from '../../ivanti/http/errors.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { assertRecordWritable } from '../shared/own-records.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { transportFor } from '../shared/transport-for.js';

export function createDeleteRecordTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'delete_record',
    title: 'Delete a record',
    description:
      'Deletes one record by RecId. There is no undo, and Ivanti cascades: deleting a record can ' +
      'take its tasks, journals and attachments with it.\n\n' +
      'Read the record first and tell the person what it is — an incident number and subject — ' +
      'before deleting it. Most requests that sound like deletion are really closure: setting ' +
      'Status to Closed or Cancelled keeps the history, and is almost always what a service desk ' +
      'actually wants.\n\n' +
      'The record is read back afterwards; if it is still there, this reports a failure rather ' +
      'than success.\n\n' +
      'DELETE BEFORE CLOSING, NOT AFTER. A closed record is read-only and this tool refuses it, ' +
      "so \"close it now, tidy up later\" does not work — the tidying is exactly what closing " +
      'prevents.',
    annotations: {
      title: 'Delete a record',
      readOnlyHint: false,
      destructiveHint: true,
      // Deleting twice is not an error worth distinguishing: the record is gone either way.
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z
        .string()
        .describe(
          'Business Object, in any of the three forms Ivanti spells them — the AdminUI id, the ' +
            'entity set, or the entity (`Incident#` / `Incidents` / `incident`, and the same ' +
            'shape for a Business Object this tenant defined itself). Names are tenant-specific: ' +
            'take them from list_business_objects rather than assuming the ones Ivanti ships.',
        ),
      recordId: z.string().describe('The 32-character RecId of the record to delete.'),
    },
    handler: (args, context) =>
      runTool('delete_record', deps.logger, async () => {
        const transport = transportFor(deps.connection.transport, context);
        const target = await resolveObject(deps, args.object);
        const { entitySet } = target;
        const url = transport.routes.record(entitySet, args.recordId);

        await assertRecordWritable(deps, context, target, args.recordId);

        // Ivanti has no 404: asking first turns "already gone" into a clear answer rather than a
        // 400 that reads like a malformed request.
        const existing = await transport
          .request<OdataRecord>(url)
          .catch((error: unknown) => {
            if (isIvantiNotFound(error)) return undefined;
            throw error;
          });

        if (existing === undefined) {
          return errorResult(
            `No ${entitySet} record with RecId ${args.recordId}; nothing was deleted.`,
          );
        }

        await transport.request(url, { method: 'DELETE' });

        const stillThere = await transport
          .request<OdataRecord>(url)
          .catch((error: unknown) => {
            if (isIvantiNotFound(error)) return undefined;
            throw error;
          });

        if (stillThere !== undefined) {
          return errorResult(
            `Ivanti accepted the delete of ${entitySet}('${args.recordId}') but the record is ` +
              'still there. It may be locked, in change control, or held by a relationship.',
          );
        }

        deps.logger.info('ivanti record deleted', { object: entitySet });

        return jsonResult({ object: entitySet, recId: args.recordId, deleted: true });
      }),
  });
}
