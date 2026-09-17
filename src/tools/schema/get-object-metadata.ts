// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { visibleFields } from '../../ivanti/metadata/csdl.js';
import { findSubtypes } from '../../ivanti/metadata/subtypes.js';
import { registersFormTools, type IvantiToolDeps } from '../shared/deps.js';
import { connectionFor } from '../shared/connection-for.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { knownObjectNames } from '../shared/object-names.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type CallContext, type ToolDefinition } from '../tool-definition.js';

/** `Edm.String` → `String`. The prefix is on every field of every entity and carries nothing. */
function shortType(type: string): string {
  return type.replace(/^Edm\./, '');
}

/**
 * What the tenant calls each field, so an answer can be written in the tenant's words.
 *
 * The ladder is `form-context`'s: the form's own label for the control, else the object's
 * `DisplayName`, else nothing — and nothing means the caller falls back to the technical name,
 * which is the last rung rather than a forbidden one. Resolved on the CALLER's connection, because
 * a form is a property of the role: the service account's form for `Incident` is not the one the
 * person being impersonated would see.
 *
 * Never throws. A tenant whose role has no workspace for this object, and a credential that cannot
 * open a session at all, both answer "no labels" — the fields are still the answer, and losing
 * them because a label lookup failed would be a far worse trade.
 */
async function fieldLabels(
  deps: IvantiToolDeps,
  context: CallContext,
  entityName: string,
): Promise<Record<string, string>> {
  if (!registersFormTools(deps)) return {};
  try {
    const form = await connectionFor(deps, context).forms.get(entityName);
    return form?.fieldLabels ?? {};
  } catch (error) {
    deps.logger.debug('no field labels for this object', { object: entityName, error });
    return {};
  }
}

export function createGetObjectMetadataTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_object_metadata',
    title: 'Get Business Object metadata',
    description:
      'The fields and relationships of one Business Object: what you can read, filter on and ' +
      'ask for. Call this before composing a filter — Ivanti field names are rarely the obvious ' +
      'word (an incident\'s description is `Symptom`), and a wrong name is reported as a bad ' +
      'request, not as an empty result.\n\n' +
      'Accepts any of the three naming forms: `Incident#`, `Incidents` or `incident`.\n\n' +
      'When `subtypes` comes back, the object is a base type — readable, but **not creatable**. ' +
      'Create one of the subtypes instead.\n\n' +
      '`validated: true` marks a field whose value comes from a picklist. It is a FLOOR, not a ' +
      'ceiling: it comes from `$metadata`, and a field without the flag may still be backed by a ' +
      'list the form knows about — `Employee.Department` carries no flag and has 17 values. If a ' +
      (registersFormTools(deps)
        ? 'field looks enumerable, try get_pick_list_values regardless of the flag rather than paging '
        : 'field looks enumerable, its values come from a list this credential cannot read — say so rather than paging ') +
      'the table to find out. ' +
      'Relationships are the names the related-records tool takes.',
    annotations: {
      title: 'Get Business Object metadata',
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
      search: z
        .string()
        .optional()
        .describe(
          'Narrows BOTH fields and relationships to those whose name contains this ' +
            '(case-insensitive; a relationship also matches on the object it points at, so ' +
            '`journal` finds `IncidentContainsJournal`, and a field matches on its label too, so ' +
            'the word a person used finds the field they meant). Large objects carry 250+ fields ' +
            'and 35+ relationships — searching is how you find one without reading all of them.',
        ),
      includeRelationships: z
        .boolean()
        .optional()
        .describe('Default true. Set false when you only need field names.'),
    },
    handler: (args, context) =>
      runTool('get_object_metadata', deps.logger, async () => {
        const { entity, entitySet } = await resolveObject(deps, args.object);
        const search = args.search?.toLowerCase();
        const subtypes = findSubtypes(await knownObjectNames(deps.connection), entity.name);
        const labels = await fieldLabels(deps, context, entity.name);

        const fields = visibleFields(entity)
          // Searched on the label too, or this tool became unusable the moment anything started
          // speaking in labels: `customer` is what the form calls `ProfileLink`, and a caller
          // told to say "Customer" then cannot find the field that is called that.
          .filter(
            (field) =>
              search === undefined ||
              field.name.toLowerCase().includes(search) ||
              (labels[field.name]?.toLowerCase().includes(search) ?? false),
          )
          .map((field) => ({
            name: field.name,
            // Only when it says something the name does not. `Owner` labelled "Owner" is noise on
            // every field of every object, and this response is already large.
            ...(labels[field.name] !== undefined && labels[field.name] !== field.name
              ? { label: labels[field.name] }
              : {}),
            type: shortType(field.type),
            ...(field.nullable ? {} : { required: true }),
            ...(field.validated ? { validated: true } : {}),
          }));

        /**
         * Why a field has no `label`, said once rather than per field.
         *
         * The caller is told to name a field the way the tenant does, so the absence of a label
         * has to mean something definite: either this role's form does not bind the field, or
         * this credential cannot read forms at all. Without the note both read as "the field has
         * no other name", and the second case would have the caller quietly reporting technical
         * names to people on a deployment where better ones exist behind a session.
         */
        const labelled = fields.filter((field) => 'label' in field).length;
        const labelsNote = registersFormTools(deps)
          ? labelled === 0
            ? 'No field on this object carries a label this role can see, so its technical names ' +
              'are the only names it has here.'
            : undefined
          : 'Labels need a form, which this credential cannot read: these are technical names, ' +
            'and the tenant may show people different ones.';

        /**
         * Relationships are searched too, on the name *and* on the target.
         *
         * `search` filtered fields only, so finding incident's journal relationship among its ~35
         * meant dumping the whole list — past a client's display budget — and grepping it. The
         * target match is what makes `journal` work when the relationship is called
         * `IncidentContainsJournal`.
         */
        const relationships = entity.relationships
          .filter(
            (relationship) =>
              search === undefined ||
              relationship.name.toLowerCase().includes(search) ||
              relationship.target.toLowerCase().includes(search),
          )
          /**
           * Whether the caller can actually follow it.
           *
           * `get_related_records` says "relationship names come from get_object_metadata", and on
           * a gated deployment that list was 7/8 dead ends — every one refused the moment it was
           * used. Advertising a path the gate forbids is worse than not listing it, because the
           * refusal arrives after the caller has committed to a plan.
           */
          .map((relationship) =>
            deps.gate.allows(relationship.target)
              ? relationship
              : {
                  ...relationship,
                  available: false,
                  reason: 'this deployment does not expose that object, so this relationship ' +
                    'cannot be followed — get_related_records will refuse it',
                },
          );

        return jsonResult({
          object: entity.name,
          entitySet,
          ...(subtypes.length > 0
            ? {
                subtypes: subtypes.map((subtype) => subtype.entitySet),
                note: 'A base type: readable, but records are created on a subtype.',
              }
            : {}),
          fieldCount: fields.length,
          ...(labelsNote === undefined ? {} : { labelsNote }),
          ...(search === undefined
            ? {}
            : {
                searchedFor: args.search,
                // Without this, `fieldCount: 0` is byte-identical to the field-less entity Ivanti
                // fabricates for an object that does not exist — so a search that simply matched
                // nothing reads as a typo in the OBJECT name. Measured: `category` has 9 fields
                // and none contains "name".
                totalFieldCount: visibleFields(entity).length,
                ...(fields.length === 0
                  ? {
                      fieldsNote:
                        `This object is real and has ${String(visibleFields(entity).length)} ` +
                        `fields; none matches '${args.search ?? ''}'. Call again without ` +
                        '`search` to see them. This is not the empty document Ivanti returns for ' +
                        'an object that does not exist.',
                    }
                  : {}),
              }),
          fields,
          ...(args.includeRelationships === false
            ? {}
            : {
                relationshipCount: relationships.length,
                ...(search !== undefined && relationships.length === 0
                  ? {
                      relationshipsNote:
                        `No relationship matches '${args.search ?? ''}'. Call again without ` +
                        '`search` to see all ' +
                        `${String(entity.relationships.length)} of them.`,
                    }
                  : {}),
                relationships,
              }),
        });
      }),
  });
}
