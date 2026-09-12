import { z } from 'zod';
import { suggestNames } from '../../ivanti/metadata/suggest-names.js';
import { ALL_FIELDS, resolveRowFields } from '../../ivanti/odata/compact-fields.js';
import { parseFieldList, projectRows } from '../../ivanti/odata/projection.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { assertOwnRecordById } from '../shared/own-records.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { compactMissedObject } from '../../ivanti/odata/compact-fields.js';
import { compactFieldsFor } from '../../ivanti/odata/compact-fields.js';

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

        // Related rows cannot be filtered, so the gate is the parent: someone else's incident
        // must not become a way to read its tasks and journals.
        await assertOwnRecordById(deps, context, resolved, args.recordId);

        const url = deps.connection.transport.routes.related(entitySet, args.recordId, match);
        const payload = await deps.connection.transport.request<OdataRecord>(url);
        // Ivanti answers an empty relationship with `{"value": "No instances found."}` — a
        // string, not an array. `readCollection` turns that into no rows rather than nineteen.
        const rows = readCollection<OdataRecord>(payload, url);

        const projection = resolveRowFields(parseFieldList(args.fields), args.fields);
        // Decided against the TARGET's rows: a journal, an attachment or a tenant's own object
        // shares none of the field names the preference list is built from.
        const compact =
          projection.defaulted && rows.length > 0
            ? compactFieldsFor(Object.keys(rows[0] ?? {}))
            : undefined;

        return jsonResult({
          object: entitySet,
          relationship: match,
          target: entity.relationships.find((r) => r.name === match)?.target,
          returned: rows.length,
          ...(projection.defaulted && rows.length > 0
            ? ((): Record<string, unknown> => {
                // Judged on the TARGET's rows, not the parent's: a journal or an attachment
                // shares none of the ticket field names the compact set is built from.
                // Only what is NOT already in the row below: repeating the shown fields under
                // "available" reads as though nothing was shown.
                const shown = new Set((compact?.fields ?? []).map((name) => name.toLowerCase()));
                const missed = compactMissedObject(Object.keys(rows[0] ?? {}))?.filter(
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
          rows: projectRows(rows, compact?.fields ?? projection.fields),
        });
      }),
  });
}
