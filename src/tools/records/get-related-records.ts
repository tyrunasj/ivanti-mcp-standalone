// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { suggestNames } from '../../ivanti/metadata/suggest-names.js';
import { ALL_FIELDS, resolveRowFields } from '../../ivanti/odata/compact-fields.js';
import { parseFieldList, projectRows } from '../../ivanti/odata/projection.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import { buildQuery, readTotal, withQuery } from '../../ivanti/odata/query.js';
import { readRows } from '../shared/read-rows.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import {
  UnscopableObjectError,
  assertOwnRecordById,
  scopeRelatedRows,
  type RelatedRowScope,
} from '../shared/own-records.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { compactMissedObject } from '../../ivanti/odata/compact-fields.js';
import { compactFieldsFor } from '../../ivanti/odata/compact-fields.js';
import { ignoredFieldNames, ignoredFieldsNote } from '../shared/ignored-fields.js';
import { transportFor } from '../shared/transport-for.js';

/**
 * How many related rows one call reads.
 *
 * The request had no `$top` at all, so a relationship with a thousand rows came back whole — and
 * there is no `skip` here to page it, so a cap alone would silently cut the answer. One row more
 * than the cap is asked for, so "there are more" is known rather than guessed, and the rows are
 * trimmed here as well in case Ivanti ignores `$top` on a navigation property.
 */
const RELATED_TOP = 50;

export function createGetRelatedRecordsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_related_records',
    title: 'Get related records',
    description:
      'Follows a named relationship from one record to the records on the other side — the ' +
      'tasks under an incident, the journals attached to it, the CIs it affects.\n\n' +
      'Relationship names come from get_object_metadata; they are Ivanti-specific ' +
      '(`IncidentContainsTask`, `IncidentAssociatesCI`) and are not guessable. A name this ' +
      'object does not have is rejected here with the list of the ones it does.\n\n' +
      'This is the only way to read related records: `$expand` is silently ignored by Ivanti ' +
      'under API-key authentication, so a request that looks like it inlined them did not.',
    annotations: {
      title: 'Get related records',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('The Business Object the record belongs to.'),
      recordId: z.string().describe('The 32-character RecId of the record to start from.'),
      relationship: z
        .string()
        .describe('Relationship name from get_object_metadata, e.g. `IncidentContainsTask`.'),
      fields: z
        .string()
        .optional()
        .describe(
          `Comma-separated fields per related row. Defaults to a compact set; "${ALL_FIELDS}" ` +
            'returns whole records.',
        ),
    },
    handler: (args, context) =>
      runTool('get_related_records', deps.logger, async () => {
        const transport = transportFor(deps.connection.transport, context);
        const resolved = await resolveObject(deps, args.object);
        const { entity, entitySet } = resolved;

        // Checked here rather than by Ivanti: a wrong name answers 404 "No HTTP resource was
        // found", which says nothing about what the right names are.
        const known = entity.relationships.map((relationship) => relationship.name);
        const match = known.find(
          (name) => name.toLowerCase() === args.relationship.toLowerCase(),
        );
        if (match === undefined) {
          const close = suggestNames(args.relationship, known, 5);
          return errorResult(
            `${entity.name} has no relationship named '${args.relationship}'. ` +
              (close.length > 0
                ? `Did you mean: ${close.join(', ')}?`
                : `It has ${String(known.length)}: ${known.slice(0, 15).join(', ')}${known.length > 15 ? ', …' : ''}`) +
              ' Full list: get_object_metadata.',
          );
        }

        // The gate applies to what a relationship REACHES, not only to what the caller named.
        // Without this, an allowlisted incident is a doorway into every object related to it —
        // `IncidentOwnerEmployee` handed back the owning analyst's login and email on a tenant
        // whose allowlist refuses `Employees` outright. Measured 2026-09-12.
        const target = entity.relationships.find((r) => r.name === match)?.target;
        if (target !== undefined && !deps.gate.allows(target)) {
          return errorResult(
            `${match} leads to ${target} records, which this server does not expose. It serves ` +
              `${deps.gate.allowed.join(', ')}.` +
              (/^journal/i.test(target)
                ? ' Use list_notes for the notes on this record — it returns what was written ' +
                  'for you, without the internal commentary or Ivanti\'s own email traffic.'
                : ''),
          );
        }

        // A journal holds staff-internal notes and Ivanti's own email traffic beside what was
        // written for the customer, and a traversal cannot tell them apart. An operator can
        // allowlist the journal object; that still does not make its rows the customer's.
        if (deps.ownRecordsOnly && target !== undefined && /^journal/i.test(target)) {
          return errorResult(
            `${match} leads to the journal, which holds internal notes and Ivanti's own email ` +
              'traffic beside what was written for you, so it is not read here. Use list_notes ' +
              'for the notes on this record — it returns the ones published to you.',
          );
        }

        // Related rows cannot be filtered, so the first gate is the parent: someone else's
        // incident must not become a way to read its tasks and journals.
        await assertOwnRecordById(deps, context, resolved, args.recordId);

        // The second is the rows themselves, because the parent being theirs says nothing about
        // whose records a relationship reaches. Decided before the read — an object that cannot
        // be scoped is refused without being asked for.
        let rowScope: RelatedRowScope | undefined;
        if (deps.ownRecordsOnly) {
          if (target === undefined) throw new UnscopableObjectError('related', match);
          rowScope = await scopeRelatedRows(
            deps,
            context,
            await resolveObject(deps, target),
            args.recordId,
            match,
          );
        }

        const url = withQuery(
          transport.routes.related(entitySet, args.recordId, match),
          buildQuery({ top: RELATED_TOP + 1 }),
        );
        const payload = await transport.request<OdataRecord>(url);
        // Ivanti answers an empty relationship with `{"value": "No instances found."}` — a
        // string, not an array. `readCollection` turns that into no rows rather than nineteen.
        const fetched = readRows<OdataRecord>(payload, url);
        const page = fetched.slice(0, RELATED_TOP);
        const rows = rowScope === undefined ? page : page.filter(rowScope.keep);
        // A count, where Ivanti sends one unasked. Not under a scope: it counts every related
        // row, the ones that are someone else's included.
        const total = rowScope === undefined ? readTotal(payload, fetched.length) : undefined;
        const hasMore =
          fetched.length > RELATED_TOP || (total !== undefined && total.total > page.length);

        const projection = resolveRowFields(parseFieldList(args.fields), args.fields);
        // Decided against the TARGET's rows: a journal, an attachment or a tenant's own object
        // shares none of the field names the preference list is built from.
        const compact =
          projection.defaulted && rows.length > 0
            ? compactFieldsFor(rows)
            : undefined;

        return jsonResult({
          object: entitySet,
          relationship: match,
          target,
          ...(rowScope === undefined
            ? {}
            : {
                scopedTo: rowScope.scopedTo,
                showing:
                  rowScope.rule === 'owner'
                    ? `only ${rowScope.scopedTo}'s own ${target ?? 'related'} records — any ` +
                      'belonging to someone else are left out, and not counted'
                    : `only the ${target ?? 'related'} records that hang off this ` +
                      `${entity.name} itself`,
              }),
          returned: rows.length,
          hasMore,
          ...(total === undefined ? {} : { total: total.total, totalIsExact: total.exact }),
          ...(hasMore
            ? {
                truncated:
                  `This relationship holds more than ${String(RELATED_TOP)} rows and only the ` +
                  `first ${String(RELATED_TOP)} were read — THIS IS NOT ALL OF THEM, and this ` +
                  `tool cannot page. For the rest, query ${target ?? 'the target object'} with ` +
                  'list_records, filtering on its link to this record (a task or an attachment ' +
                  "names its parent in `ParentLink_RecID`), and page with `skip`.",
              }
            : {}),
          /**
           * What zero means, said here rather than left to be inferred.
           *
           * `list_notes` says it and is believed instantly; this said nothing, and three
           * independent testers each spent extra calls proving a zero by a second route — one of
           * them four calls, including running the same relationship against another record to
           * check it worked at all. Two zeros in that run were never verified and went into an
           * answer as assertions.
           */
          // Under a scope, zero is about what this person may see and not about the record — the
          // "real zero" below would be a false reassurance there, and saying WHY it is zero would
          // tell them someone else's records are attached to their ticket.
          ...(rows.length === 0 && rowScope !== undefined
            ? {
                note:
                  `No ${target ?? 'related'} rows on this ${entity.name} are visible to ` +
                  `${rowScope.scopedTo}. That is not the same as none existing — only rows that ` +
                  'are theirs, or that hang off this record itself, are shown here.',
              }
            : {}),
          ...(rows.length === 0 && rowScope === undefined
            ? {
                note:
                  `The relationship resolved and this ${entity.name} has no ` +
                  `${target ?? 'related'} rows. THAT IS A REAL ZERO, not a failed lookup: the ` +
                  'relationship name was checked against the object before the request, and a ' +
                  'wrong one is refused by name. It is not the silent-empty failure a dropped ' +
                  '`$filter` function produces. IT IS ALSO ONLY ABOUT THIS RECORD: whether ' +
                  `${target ?? 'the target object'} holds any rows at all on this tenant is a ` +
                  'separate question — answer it with count_records before reporting that ' +
                  'nothing was ever logged, or you may describe a configuration gap as a fact ' +
                  'about the record.',
              }
            : {}),
          ...(projection.defaulted && rows.length > 0
            ? ((): Record<string, unknown> => {
                // Judged on the TARGET's rows, not the parent's: a journal or an attachment
                // shares none of the ticket field names the compact set is built from.
                // Only what is NOT already in the row below: repeating the shown fields under
                // "available" reads as though nothing was shown.
                const shown = new Set((compact?.fields ?? []).map((name) => name.toLowerCase()));
                const missed = compactMissedObject(rows)?.filter(
                  (name) => !shown.has(name.toLowerCase()),
                );
                return missed === undefined
                  ? { fields: 'a compact default set — pass `fields`, or "*" for whole records' }
                  : {
                      fields:
                        'THIS OBJECT IS NOT ONE OF THE ONES THE DEFAULT KNOWS, so what is below ' +
                        'is its own first few fields. That choice is arbitrary, not a judgement ' +
                        'about which fields matter — name the ones you want in `fields`, or ' +
                        'pass "*".',
                      otherFields: missed,
                    };
              })()
            : {}),
          ...(ignoredFieldNames(rows, parseFieldList(args.fields)).length === 0
            ? {}
            : {
                ignoredFields: ignoredFieldNames(rows, parseFieldList(args.fields)),
                fieldsNote: ignoredFieldsNote(
                  ignoredFieldNames(rows, parseFieldList(args.fields)),
                ),
              }),
          rows: projectRows(rows, compact?.fields ?? projection.fields),
        });
      }),
  });
}
