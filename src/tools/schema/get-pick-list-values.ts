import { z } from 'zod';
import { visibleFields } from '../../ivanti/metadata/csdl.js';
import { toObjectId } from '../../ivanti/write/validated-write.js';
import { readPickLists } from '../../ivanti/session/pick-lists.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

export function createGetPickListValuesTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_pick_list_values',
    title: 'Get the allowed values for a field',
    description:
      'The values a validated field will actually accept — the Status list, the Priority list, ' +
      'the categories this tenant uses.\n\n' +
      'get_object_metadata marks a field `validated: true`, which means its value comes from a ' +
      'list rather than free text; this is how to see that list. Ivanti does not expose it over ' +
      'OData at all, so guessing a value is how filters return nothing and writes get rejected.\n\n' +
      'Some lists CASCADE: the categories depend on the service, the sub-status on the status. ' +
      'Pass the parent value in `filters` — without it the answer is the unfiltered list, whose ' +
      'values may not be valid together. The response echoes what it filtered by, and names any ' +
      'filter the form did not recognise.',
    annotations: {
      title: 'Get the allowed values for a field',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object: `Incident#`, `Incidents` or `incident`.'),
      fields: z
        .array(z.string())
        .min(1)
        .describe('Field names, e.g. ["Status","Priority"]. Ask for several at once.'),
      filters: z
        .record(z.string(), z.string())
        .optional()
        .describe('Values for the fields a list cascades on, e.g. { "Service": "Email" }.'),
    },
    handler: (args) =>
      runTool('get_pick_list_values', deps.logger, async () => {
        const { entity } = await resolveObject(deps, args.object);
        const objectId = toObjectId(entity.name);

        const form = await deps.connection.forms.get(objectId);
        if (form === undefined) {
          return errorResult(
            `Ivanti has no create form for ${objectId} that this role can reach, and the allowed ` +
              'values live on the form. get_object_metadata still reports which fields are ' +
              'validated, and list_records against the validation object often lists the values.',
          );
        }

        const known = new Set(visibleFields(entity).map((field) => field.name.toLowerCase()));
        const unknownFields = args.fields.filter((field) => !known.has(field.toLowerCase()));

        const { lists, ignoredValues } = await readPickLists({
          session: deps.connection.session,
          form,
          objectId,
          fields: args.fields,
          ...(args.filters === undefined ? {} : { values: args.filters }),
        });

        return jsonResult({
          object: entity.name,
          ...(unknownFields.length > 0 ? { unknownFields } : {}),
          ...(ignoredValues.length > 0
            ? {
                ignoredFilters: ignoredValues,
                warning:
                  'Those filters name fields this form does not have, so they narrowed nothing. ' +
                  'The values below may not be valid for the record you have in mind.',
              }
            : {}),
          fields: lists,
        });
      }),
  });
}
