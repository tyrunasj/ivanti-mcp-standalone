// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { constrainedBy } from '../../ivanti/session/form-context.js';
import { toObjectId } from '../../ivanti/write/validated-write.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { connectionFor } from '../shared/connection-for.js';

export function createGetPickListConstraintsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_pick_list_constraints',
    title: 'Get which fields filter which lists',
    description:
      'Which validated fields depend on which others — the cascades. On a stock incident, ' +
      '`Category` is filtered by `Service`, `Subcategory` by both, and `Owner` by `OwnerTeam`.\n\n' +
      'This is what get_pick_list_values needs as `filters`, and what makes a write succeed: ' +
      'asking for the categories without naming a service returns a default subset, whose ' +
      'values may be rejected for the record you have in mind. OData exposes none of this — ' +
      '`$metadata` says only that a field is validated.',
    annotations: {
      title: 'Get which fields filter which lists',
      readOnlyHint: true,
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
      field: z
        .string()
        .optional()
        .describe('One field to describe. Omit for every constrained field on the object.'),
    },
    handler: (args, context) =>
      runTool('get_pick_list_constraints', deps.logger, async () => {
        const connection = connectionFor(deps, context);
        const { entity } = await resolveObject(deps, args.object);
        const form = await connection.forms.get(toObjectId(entity.name));

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

        /**
         * A field-scoped answer must never make an object-scoped claim.
         *
         * Asked about one field, this replied `constrained: []` with `validatedFields: 21` and
         * "No cascades HERE: every list on THIS OBJECT stands on its own" — while incident has
         * four cascades. The note contradicted the tool's own description, and a fresh response
         * beats static text, so it set up exactly the error `get_pick_list_values` exists to
         * prevent: reporting 5 categories as "the categories" where the tenant holds 69.
         */
        const scoped = args.field !== undefined;

        return jsonResult({
          object: entity.name,
          ...(scoped
            ? { field: args.field, answersFor: 'this field only' }
            : { validatedFields: Object.keys(form.validatedFields).length }),
          constrained,
          ...(constrained.length === 0
            ? {
                note: scoped
                  ? `${args.field ?? 'That field'} is not constrained by any other field. THIS ` +
                    `SAYS NOTHING ABOUT ${entity.name.toUpperCase()} AS A WHOLE — call again ` +
                    "without `field` for the object's full cascade map, because other fields on " +
                    'it may well cascade.'
                  : 'No cascades on this object: every list stands on its own.',
              }
            : {}),
        });
      }),
  });
}
