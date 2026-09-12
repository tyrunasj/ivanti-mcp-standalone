import { z } from 'zod';
import { ALL_FIELDS, resolveRowFields } from '../../ivanti/odata/compact-fields.js';
import { parseFieldList, projectRows } from '../../ivanti/odata/projection.js';
import { referencedFieldNames } from '../../ivanti/odata/filter.js';
import { buildQuery, DEFAULT_TOP, MAX_TOP, readTotal, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { explainFieldError } from '../shared/explain-field-error.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { scopeToOwnRecords } from '../shared/own-records.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { assertOrderBy } from '../shared/order-by.js';
import { compactMissedObject } from '../../ivanti/odata/compact-fields.js';
import { compactFieldsFor } from '../../ivanti/odata/compact-fields.js';
import { visibleFields } from '../../ivanti/metadata/csdl.js';

export function createListRecordsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'list_records',
    title: 'List records',
    description:
      'Lists records from a Business Object.\n\n' +
      'FILTER — Ivanti supports a strict subset of OData: `eq ne gt ge lt le and or` and ' +
      'parentheses. It has NO functions: `contains()`, `startswith()` and `year()` are ' +
      'SILENTLY IGNORED and the full unfiltered set comes back, so this tool refuses them ' +
      'before sending. Use `search` for substrings.\n' +
      '- empty field: `Owner eq \'$NULL\'` — the only way to match one\n' +
      '- dates are bare and unquoted: `CreatedDateTime gt 2026-01-01`\n' +
      '- there is no default order; "the latest" needs `orderBy`\n\n' +
      'ZERO ROWS MEANS NO SUCH RECORD IS VISIBLE TO THE PERSON YOU ARE ACTING FOR. Where the ' +
      'answer carries `scopedTo`, this server returns their own records only — a record that ' +
      'belongs to somebody else answers zero here **including one they have been asked to ' +
      'approve**. Do not go hunting through neighbouring numbers, and do not tell them it does ' +
      'not exist; say you cannot see it.\n\n' +
      'Field names are not guessable — an incident\'s description is `Symptom` — so call ' +
      'get_object_metadata first when composing a filter.',
    annotations: {
      title: 'List records',
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
      filter: z
        .string()
        .optional()
        .describe("OData filter, e.g. \"Status eq 'Active' and Priority eq '1'\"."),
      search: z
        .string()
        .optional()
        .describe('Keyword search across the record\'s text fields — the only substring match.'),
      orderBy: z
        .string()
        .optional()
        .describe(
          'Sort clause: `CreatedDateTime desc`, or several separated by commas. The field name ' +
            'is checked before the request, because Ivanti answers an unknown sort field with an ' +
            'EMPTY RESULT rather than an error — `CreatedDate` instead of `CreatedDateTime` ' +
            'would otherwise turn every row into none.',
        ),
      fields: z
        .string()
        .optional()
        .describe(
          'Comma-separated fields to return. Defaults to a compact identifying set — a full ' +
            `Ivanti record is ~180 fields and a page of them is enormous. Pass "${ALL_FIELDS}" ` +
            'for whole records, and expect them to be large.',
        ),
      top: z
        .number()
        .int()
        .min(1)
        .max(MAX_TOP)
        .optional()
        .describe(`Rows to return, default ${String(DEFAULT_TOP)}, max ${String(MAX_TOP)}.`),
      skip: z.number().int().min(0).optional().describe('Rows to skip, for paging.'),
    },
    handler: (args, context) =>
      runTool('list_records', deps.logger, async () => {
        const resolved = await resolveObject(deps, args.object);
        const { entity, entitySet } = resolved;
        const top = args.top ?? DEFAULT_TOP;

        // Before the request: an unknown sort field answers 204, which is indistinguishable from
        // "there are no such records".
        assertOrderBy(args.orderBy, entity);

        // In `enduser` mode this narrows the filter to the caller's own records, and refuses
        // when nobody has said who that is.
        const scoped = await scopeToOwnRecords(deps, context, resolved, args.filter);

        const url = withQuery(
          deps.connection.transport.routes.entitySet(entitySet),
          buildQuery({
            filter: scoped.filter,
            search: args.search,
            orderBy: args.orderBy,
            top,
            skip: args.skip,
            count: true,
          }),
        );

        const projection = resolveRowFields(parseFieldList(args.fields), args.fields);

        const payload = await deps.connection.transport
          .request<OdataRecord>(url)
          .catch((error: unknown) => {
            const referenced = referencedFieldNames({
              filter: args.filter,
              fields: parseFieldList(args.fields),
            });
            throw explainFieldError(error, entity, referenced) ?? error;
          });
        const rows = readCollection<OdataRecord>(payload, url);
        const total = readTotal(payload, rows.length);
        const skipped = args.skip ?? 0;

        /**
         * The default field set, decided against THIS object's rows rather than a fixed list.
         *
         * A tenant defines its own Business Objects and renames fields on the ones Ivanti ships,
         * so the preference list is a starting point and not an answer. `compactFieldsFor` falls
         * back to the row's own leading fields when the list matches nothing — otherwise every
         * row of an unrecognised object came back as a RecId and two timestamps.
         */
        const compact =
          projection.defaulted && rows.length > 0
            ? compactFieldsFor(
                Object.keys(rows[0] ?? {}),
                // A better-than-a-name-list candidate source, where the schema offers one.
                visibleFields(entity)
                  .filter((f) => f.validated || !f.nullable)
                  .map((f) => f.name),
              )
            : undefined;

        return jsonResult({
          object: entitySet,
          ...(scoped.scopedTo === undefined ? {} : { scopedTo: scoped.scopedTo }),
          returned: rows.length,
          // `scopedTo` alone reads as a label rather than a caveat, and a bare zero under it was
          // the one place a tester could have told someone a record does not exist when it does.
          ...(scoped.scopedTo !== undefined && rows.length === 0
            ? {
                note:
                  `No ${entitySet} record matching this is visible to ${scoped.scopedTo}. That ` +
                  'is not the same as none existing — a record belonging to someone else answers ' +
                  'zero here too.',
              }
            : {}),
          ...(total === undefined
            ? {}
            : {
                total: total.total,
                totalIsExact: total.exact,
                hasMore: total.total > skipped + rows.length,
              }),
          ...(projection.defaulted && rows.length > 0
            ? ((): Record<string, unknown> => {
                // The compact default is tuned for the ticket objects. On some others it
                // intersects nothing but RecId and timestamps, and the rows come back
                // indistinguishable from one another — so say so, with the names to pick from,
                // rather than presenting a useless row as a normal answer.
                // Only what is NOT already in the row below: repeating the shown fields under
                // "available" reads as though nothing was shown.
                const shown = new Set((compact?.fields ?? []).map((name) => name.toLowerCase()));
                const missed = compactMissedObject(Object.keys(rows[0] ?? {}))?.filter(
                  (name) => !shown.has(name.toLowerCase()),
                );
                return missed === undefined
                  ? {
                      fields:
                        'a compact default set — pass `fields` for others, or "*" for whole records',
                    }
                  : {
                      fields:
                        'THIS OBJECT IS NOT ONE OF THE ONES THE DEFAULT KNOWS, so the rows below ' +
                        'show its own first few fields instead. That choice is arbitrary, not a ' +
                        'judgement about which fields matter — name the ones you want in ' +
                        '`fields`, or pass "*".',
                      otherFields: missed,
                    };
              })()
            : {}),
          rows: projectRows(rows, compact?.fields ?? projection.fields),
        });
      }),
  });
}
