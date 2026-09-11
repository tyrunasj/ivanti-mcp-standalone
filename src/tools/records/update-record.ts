import { z } from 'zod';
import { referencedFieldNames } from '../../ivanti/odata/filter.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import {
  confirmWrite,
  resolveValidatedWrite,
  toObjectId,
} from '../../ivanti/write/validated-write.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { explainFieldError } from '../shared/explain-field-error.js';
import { explainRequiredFields } from '../shared/explain-required-fields.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

export function createUpdateRecordTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'update_record',
    title: 'Update a record',
    description:
      'Changes fields on one existing record, by RecId, and reads it back to confirm.\n\n' +
      'Only the fields named are touched. A validated field takes a value from a list — see ' +
      'get_pick_list_values — and a list can CASCADE: the categories depend on the service. This ' +
      'tool reads the record\'s stored parents before checking, so patching `Category` alone is ' +
      'judged against the service the record already has rather than against an empty one.\n\n' +
      'OMITTING A VALIDATED FIELD IS NOT THE SAME AS LEAVING IT ALONE on some objects, because ' +
      'Ivanti recalculates dependent fields; read the result rather than assuming.\n\n' +
      'To change a link — the customer, the owner — set the pair: `ProfileLink_RecID` plus ' +
      '`ProfileLink_Category`.',
    annotations: {
      title: 'Update a record',
      readOnlyHint: false,
      // It overwrites what was there; MCP calls that destructive, and it is.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object: `Incident#`, `Incidents` or `incident`.'),
      recordId: z.string().describe('The 32-character RecId of the record to change.'),
      fields: z
        .record(z.string(), z.unknown())
        .describe('Only the fields to change, e.g. { "Status": "Resolved" }.'),
    },
    handler: (args) =>
      runTool('update_record', deps.logger, async () => {
        const { entity, entitySet } = await resolveObject(deps, args.object);

        const resolved = await resolveValidatedWrite({
          connection: deps.connection,
          logger: deps.logger,
          entity,
          entitySet,
          fields: args.fields,
          recId: args.recordId,
        });

        const body = { ...args.fields, ...resolved.values, ...resolved.companions };
        const url = deps.connection.transport.routes.record(entitySet, args.recordId);

        const updated = await deps.connection.transport
          .request<OdataRecord>(url, { method: 'PATCH', body })
          .catch(async (error: unknown) => {
            // Required-field rules name display names, and some of them are links; the form is
            // the only thing that can translate either.
            const form = await deps.connection.forms
              .get(toObjectId(entity.name))
              .catch(() => undefined);
            throw (
              explainRequiredFields(error, form) ??
              explainFieldError(error, entity, referencedFieldNames({ fields: Object.keys(body) })) ??
              error
            );
          });

        await confirmWrite(
          deps.connection,
          entitySet,
          args.recordId,
          resolved.confirm,
          resolved.companions,
        );

        deps.logger.info('ivanti record updated', { object: entitySet });

        return jsonResult({
          object: entitySet,
          recId: args.recordId,
          changed: Object.keys(args.fields),
          record: updated,
        });
      }),
  });
}
