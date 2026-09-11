import { z } from 'zod';
import {
  confirmWrite,
  resolveValidatedWrite,
  toObjectId,
} from '../../ivanti/write/validated-write.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import { referencedFieldNames } from '../../ivanti/odata/filter.js';
import { describeSubtypes, findSubtypes } from '../../ivanti/metadata/subtypes.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { explainFieldError } from '../shared/explain-field-error.js';
import { explainRequiredFields } from '../shared/explain-required-fields.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { knownObjectNames } from '../shared/object-names.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

export function createCreateRecordTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'create_record',
    title: 'Create a record',
    description:
      'Creates one record and returns what Ivanti actually stored.\n\n' +
      'FIELD NAMES ARE NOT GUESSABLE — an incident\'s description is `Symptom`. Call ' +
      'get_object_metadata first, and get_pick_list_values for any field it marks `validated`: ' +
      'those take a value from a list, and this tool refuses one that is not on it rather than ' +
      'letting Ivanti accept the write and store nothing.\n\n' +
      'A PERSON IS NOT A NAME. Links are a pair of fields: the customer of an incident is ' +
      '`ProfileLink_RecID` (the employee\'s RecId) together with `ProfileLink_Category` ' +
      '("Employee"). Creating a child under a parent is the same shape — `ParentLink_RecID` plus ' +
      '`ParentLink_Category` — passed here, in the create, which wires the relationship in one ' +
      'call. link_records is for records that already exist.\n\n' +
      'The record is read back before this reports success. A write Ivanti accepted but did not ' +
      'store is reported as a failure.',
    annotations: {
      title: 'Create a record',
      readOnlyHint: false,
      // Additive: it creates, it does not overwrite.
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object: `Incident#`, `Incidents` or `incident`.'),
      fields: z
        .record(z.string(), z.unknown())
        .describe('Field names to values, e.g. { "Subject": "Printer jam", "Status": "Logged" }.'),
    },
    handler: (args) =>
      runTool('create_record', deps.logger, async () => {
        const { entity, entitySet } = await resolveObject(deps, args.object);

        const resolved = await resolveValidatedWrite({
          connection: deps.connection,
          logger: deps.logger,
          entity,
          entitySet,
          fields: args.fields,
        });

        const body = { ...args.fields, ...resolved.values, ...resolved.companions };
        const url = deps.connection.transport.routes.entitySet(entitySet);

        const created = await deps.connection.transport
          .request<OdataRecord>(url, { method: 'POST', body })
          .catch(async (error: unknown) => {
            // A create aimed at a base type answers 500 with an empty message, which explains
            // nothing. The subtypes do.
            const subtypes = findSubtypes(await knownObjectNames(deps.connection), entity.name);
            if (subtypes.length > 0) {
              throw new Error(
                `${describeSubtypes(entity.name, subtypes)} (Ivanti refused this create: ` +
                  `${error instanceof Error ? error.message : 'unknown error'})`,
              );
            }

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

        const recId = created?.['RecId'];
        if (typeof recId !== 'string' || recId === '') {
          return errorResult(
            'Ivanti answered the create without a RecId, so there is no evidence a record was ' +
              'stored. Check with list_records before trying again — a retry may duplicate it.',
          );
        }

        // Throws when a value did not take: the record exists, but not as asked.
        await confirmWrite(deps.connection, entitySet, recId, resolved.confirm, resolved.companions);

        deps.logger.info('ivanti record created', { object: entitySet });

        return jsonResult({ object: entitySet, recId, record: created });
      }),
  });
}
