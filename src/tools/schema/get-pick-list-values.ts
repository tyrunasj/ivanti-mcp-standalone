// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { visibleFields } from '../../ivanti/metadata/csdl.js';
import { constrainedBy } from '../../ivanti/session/form-context.js';
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
      'WITHOUT `filters` THE ANSWER IS A SUBSET, NOT THE WHOLE LIST. Measured: an incident\'s ' +
      'Category answers 5 values unfiltered, 13 under one Service, and its backing object holds ' +
      '69 — so an unfiltered answer presented as "the categories" understates by an order of ' +
      'magnitude. Call get_pick_list_constraints first to learn which parents apply, then pass ' +
      'them here. To enumerate everything a field could ever hold, read its backing object ' +
      'directly (list_business_objects with includeValidationLists).\n\n' +
      'Pass the parent value in `filters` — without it the answer is that default subset, whose ' +
      'values may not be valid together. The response echoes what it filtered by, and names any ' +
      'filter the form did not recognise.',
    annotations: {
      title: 'Get the allowed values for a field',
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
      fields: z
        .array(z.string())
        .min(1)
        .describe('Field names, e.g. ["Status","Priority"]. Ask for several at once.'),
      filters: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Values for the fields a list cascades on, e.g. `{ "Service": "Email Service" }`. The ' +
            'value must be one the PARENT field actually holds — a plausible-but-wrong one ' +
            '("Email" where the tenant says "Email Service") narrows the list to nothing and ' +
            'looks exactly like a field with no options. Get parent values from this same tool.',
        ),
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

        /**
         * Why a list is short or empty, said in the payload.
         *
         * Three different situations rendered identically as `values: []` or as a plausible short
         * list, and a tester took each of them at face value: a five-value answer for Category was
         * reported as "the categories an incident can have" when the tenant holds 69, and a
         * misspelled parent value produced an empty list byte-identical to a nonexistent one.
         * `get_service_request_parameter_options` already names its three causes; this did not.
         */
        const diagnosed = Object.fromEntries(
          Object.entries(lists).map(([field, list]) => {
            const all = constrainedBy(form, field);
            // A field constrained by ITSELF is a workflow state machine: the list Ivanti offers
            // is the transitions available from a NEW record, not the field's range. Filtering
            // the self-reference out left `parents` empty, so `change.Status` answered 4 of its 9
            // values with no `subset` flag at all — and a breakdown built from it covered 12 of
            // 51 records.
            const selfConstrained = all.some((parent) => parent === field);
            const parents = all.filter((parent) => parent !== field);
            const supplied = new Set(Object.keys(list.filteredBy ?? {}).map((k) => k.toLowerCase()));
            const missing = parents.filter((parent) => !supplied.has(parent.toLowerCase()));

            if (list.values.length === 0) {
              return [
                field,
                {
                  ...list,
                  ...(parents.length > 0 ? { constrainedBy: parents } : {}),
                  note: !list.validated
                    ? 'Not a validated field, so no list exists — this is not an empty list, it ' +
                      'is free text. To see the values actually in use, call list_records with ' +
                      '`fields` set to this field, or pass candidate values to group_count.'
                    : missing.length > 0
                      ? `Empty because this list depends on ${missing.join(', ')} and no value ` +
                        'was supplied for it. Supply one in `filters` — a dependent list is ' +
                        'empty rather than complete until its parent is given.'
                      : supplied.size > 0
                        ? 'Empty with the filters applied. The likeliest cause is that a value ' +
                          'in `filters` is not one the parent field actually holds — a wrong ' +
                          'value and a nonexistent field both narrow to nothing. Check the ' +
                          "parent's own list first."
                        : 'Empty: this field is validated but the form offers no options for it ' +
                          'in this role. Read the backing object directly with list_records.',
                },
              ];
            }

            if (selfConstrained && list.values.length > 0) {
              return [
                field,
                {
                  ...list,
                  subset: true,
                  constrainedBy: [field],
                  note:
                    `THESE ARE NOT ALL THE VALUES. '${field}' is constrained by its own current ` +
                    'value — a workflow state machine — so this is the set reachable from a NEW ' +
                    'record, not everything the field can hold. Measured: change.Status answers ' +
                    '4 here while 7 are in use, and the largest group is missing. Read the ' +
                    'backing object (list_business_objects with includeValidationLists) for the ' +
                    'full range before counting or grouping by it.',
                },
              ];
            }

            // A non-empty answer for a constrained field with no parent supplied is the dangerous
            // case: it looks complete and is not.
            return [
              field,
              missing.length > 0
                ? {
                    ...list,
                    constrainedBy: parents,
                    subset: true,
                    note:
                      `THESE ARE NOT ALL THE VALUES. This list is constrained by ` +
                      `${missing.join(', ')}, and none was supplied, so Ivanti answered with the ` +
                      'default subset. Measured: an incident’s Category answers 5 this way, 13 ' +
                      'under one Service, and its backing object holds 69. Pass the parent in ' +
                      '`filters` before presenting these as the options, or read the backing ' +
                      'object for everything the field could ever hold.',
                  }
                : list,
            ];
          }),
        );

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
          fields: diagnosed,
        });
      }),
  });
}
