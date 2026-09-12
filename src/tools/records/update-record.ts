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
import { assertRecordWritable } from '../shared/own-records.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { projectWritten } from '../shared/project-written.js';

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
      'To change a link — the customer, the requestor, the owner — set BOTH halves of its pair: ' +
      '`<Link>_RecID` and `<Link>_Category`. Which link carries which meaning differs per object, ' +
      'so get_link_fields for this object rather than assuming the name another object used.',
    annotations: {
      title: 'Update a record',
      readOnlyHint: false,
      // It overwrites what was there; MCP calls that destructive, and it is.
      destructiveHint: true,
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
      recordId: z.string().describe('The 32-character RecId of the record to change.'),
      fields: z
        .record(z.string(), z.unknown())
        .describe('Only the fields to change, e.g. { "Status": "Resolved" }.'),
      returnFields: z
        .string()
        .optional()
        .describe(
          'Comma-separated fields to return in the confirmation. Defaults to the fields you ' +
            'wrote plus a compact identifying set — a whole Ivanti record is ~180 fields and ' +
            'roughly 10 KB of JSON, which is a lot to spend confirming a write that has already ' +
            'been verified. Pass "*" for the whole record.',
        ),
    },
    handler: (args, context) =>
      runTool('update_record', deps.logger, async () => {
        const target = await resolveObject(deps, args.object);
        const { entity, entitySet } = target;

        // Before anything is resolved, let alone written: whether it is the caller's, and
        // whether it is still open. Ivanti happily updates a closed record.
        await assertRecordWritable(deps, context, target, args.recordId);

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

        const changed = Object.keys(args.fields);
        return jsonResult({
          object: entitySet,
          recId: args.recordId,
          changed,
          record: projectWritten(updated, args.returnFields, changed),
        });
      }),
  });
}
