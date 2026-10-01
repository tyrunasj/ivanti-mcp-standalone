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
import { OBJECT_ARGUMENT_IN_FULL } from '../shared/object-argument.js';
import { FIELDS_FORMAT, fieldRows, renderRows, rowMatches } from './field-table.js';

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
interface FormFacts {
  labels: Record<string, string>;
  /** Fields a required rule governs — which is not the same as fields required now. */
  sometimesRequired: ReadonlySet<string>;
  /** Fields a read-only rule governs — conditional in the same way, and for the same reason. */
  readOnly: ReadonlySet<string>;
}

const NO_FORM: FormFacts = { labels: {}, sometimesRequired: new Set(), readOnly: new Set() };

async function formFacts(
  deps: IvantiToolDeps,
  context: CallContext,
  entityName: string,
): Promise<FormFacts> {
  if (!registersFormTools(deps)) return NO_FORM;
  try {
    const form = await connectionFor(deps, context).forms.get(entityName);
    if (form === undefined) return NO_FORM;
    return {
      labels: form.fieldLabels,
      sometimesRequired: new Set(form.requiredRuleFields),
      readOnly: new Set(form.readOnlyFields),
    };
  } catch (error) {
    deps.logger.debug('no form for this object', { object: entityName, error });
    return NO_FORM;
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
      'A `validated` flag marks a field whose value comes from a picklist. It is a FLOOR, not a ' +
      'ceiling: it comes from `$metadata`, and a field without the flag may still be backed by a ' +
      'list the form knows about — `Employee.Department` carries no flag and still has a list. If a ' +
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
        .describe(OBJECT_ARGUMENT_IN_FULL),
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
        const form = await formFacts(deps, context, entity.name);

        // Searched on the label too, or this tool became unusable the moment anything started
        // speaking in labels: `customer` is what the form calls `ProfileLink`, and a caller told
        // to say "Customer" then cannot find the field that is called that. A folded link answers
        // to any of its three names, so a search for `_RecID` still finds it.
        const allRows = fieldRows(visibleFields(entity), form);
        const rows = allRows.filter((row) => search === undefined || rowMatches(row, search));
        // Fields, not rows: a link row stands for three, and `totalFieldCount` counts fields.
        const fieldCount = rows.reduce((sum, row) => sum + row.covers.length, 0);

        /**
         * Why a field has no `label`, said once rather than per field.
         *
         * The caller is told to name a field the way the tenant does, so the absence of a label
         * has to mean something definite: either this role's form does not bind the field, or
         * this credential cannot read forms at all. Without the note both read as "the field has
         * no other name", and the second case would have the caller quietly reporting technical
         * names to people on a deployment where better ones exist behind a session.
         *
         * Counted over EVERY field, not the ones `search` kept: the note is a claim about the
         * object, and a search that happened to match only unlabelled fields made it say "no field
         * on this object carries a label" about an object whose form labels dozens.
         */
        const labelled = allRows.filter((row) => row.label !== undefined).length;
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
          .map(
            (relationship) =>
              `${relationship.name} → ${relationship.target}` +
              (deps.gate.allows(relationship.target) ? '' : ' (not exposed)'),
          );
        const unexposed = relationships.some((relationship) => relationship.endsWith('(not exposed)'));

        return jsonResult({
          object: entity.name,
          entitySet,
          ...(subtypes.length > 0
            ? {
                subtypes: subtypes.map((subtype) => subtype.entitySet),
                note: 'A base type: readable, but records are created on a subtype.',
              }
            : {}),
          fieldCount,
          ...(labelsNote === undefined ? {} : { labelsNote }),
          /**
           * Said once, because the two flags differ in KIND and a reader that conflated them
           * would trust the weaker one too much.
           */
          ...(form.sometimesRequired.size === 0 && form.readOnly.size === 0
            ? {}
            : {
                // Shortened from a paragraph of measured cases, re-sent on every call for every
                // object with rules. What a caller must not get wrong is the kind of the flag.
                rulesNote:
                  '`required?` and `readOnly?` mean a form rule governs the field in some states; ' +
                  'the form never says which conditions. Neither is a promise — read-only fields ' +
                  'have been accepted on a create — so treat `readOnly?` as "may be locked", ' +
                  'never as "this write will be refused", and read the value back after writing.',
              }),
          ...(search === undefined
            ? {}
            : {
                searchedFor: args.search,
                // Without this, `fieldCount: 0` is byte-identical to the field-less entity Ivanti
                // fabricates for an object that does not exist — so a search that simply matched
                // nothing reads as a typo in the OBJECT name. Measured: `category` has 9 fields
                // and none contains "name".
                totalFieldCount: visibleFields(entity).length,
                ...(rows.length === 0
                  ? {
                      fieldsNote:
                        `This object is real and has ${String(visibleFields(entity).length)} ` +
                        `fields; none matches '${args.search ?? ''}'. Call again without ` +
                        '`search` to see them. This is not the empty document Ivanti returns for ' +
                        'an object that does not exist.',
                    }
                  : {}),
              }),
          ...(rows.length === 0 ? {} : { fieldsFormat: FIELDS_FORMAT, fields: renderRows(rows) }),
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
                ...(unexposed
                  ? {
                      unexposedNote:
                        '`(not exposed)`: this deployment does not expose that object, so ' +
                        'get_related_records will refuse the relationship.',
                    }
                  : {}),
                relationships,
              }),
        });
      }),
  });
}
