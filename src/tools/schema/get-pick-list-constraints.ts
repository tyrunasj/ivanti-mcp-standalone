import { z } from 'zod';
import { constrainedBy } from '../../ivanti/session/form-context.js';
import { toObjectId } from '../../ivanti/write/validated-write.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

export function createGetPickListConstraintsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_pick_list_constraints',
    title: 'Get which fields filter which lists',
    description:
      'Which validated fields depend on which others — the cascades. On a stock incident, ' +
      '`Category` is filtered by `Service`, `Subcategory` by both, and `Owner` by `OwnerTeam`.\n\n' +
      'This is what get_pick_list_values needs as `filters`, and what makes a write succeed: ' +
      'asking for the categories without naming a service returns the unfiltered list, whose ' +
      'values may be rejected for the record you have in mind. OData exposes none of this — ' +
      '`$metadata` says only that a field is validated.',
    annotations: {
      title: 'Get which fields filter which lists',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object: `Incident#`, `Incidents` or `incident`.'),
      field: z
        .string()
        .optional()
        .describe('One field to describe. Omit for every constrained field on the object.'),
    },
    handler: (args) =>
      runTool('get_pick_list_constraints', deps.logger, async () => {
        const { entity } = await resolveObject(deps, args.object);
        const form = await deps.connection.forms.get(toObjectId(entity.name));

        if (form === undefined) {
          return errorResult(
            `Ivanti has no create form for ${entity.name} that this role can reach, and the ` +
              'cascades live on the form.',
          );
        }

        const wanted =
          args.field === undefined
            ? Object.keys(form.validatedFields)
            : Object.keys(form.validatedFields).filter(
                (name) => name.toLowerCase() === args.field?.toLowerCase(),
              );

        if (args.field !== undefined && wanted.length === 0) {
          return errorResult(
            `${args.field} is not a validated field on ${entity.name}, so nothing filters it. ` +
              'get_object_metadata marks the fields that are.',
          );
        }

        // A field nothing filters is the common case; listing it as "constrained by nothing"
        // would bury the handful that matter.
        const constrained = wanted
          .map((field) => ({ field, constrainedBy: constrainedBy(form, field) }))
          .filter((entry) => entry.constrainedBy.length > 0)
          .sort((a, b) => a.field.localeCompare(b.field));

        return jsonResult({
          object: entity.name,
          validatedFields: Object.keys(form.validatedFields).length,
          constrained,
          ...(constrained.length === 0
            ? { note: 'No cascades here: every list on this object stands on its own.' }
            : {}),
        });
      }),
  });
}
