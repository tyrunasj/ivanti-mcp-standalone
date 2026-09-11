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
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

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
      'ZERO ROWS MEANS THE RECORDS DO NOT EXIST. After `IncidentNumber eq 11150` returns ' +
      'nothing, do not go hunting through neighbouring numbers.\n\n' +
      'Field names are not guessable — an incident\'s description is `Symptom` — so call ' +
      'get_object_metadata first when composing a filter.',
    annotations: {
      title: 'List records',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object: `Incident#`, `Incidents` or `incident`.'),
      filter: z
        .string()
        .optional()
        .describe("OData filter, e.g. \"Status eq 'Active' and Priority eq '1'\"."),
      search: z
        .string()
        .optional()
        .describe('Keyword search across the record\'s text fields — the only substring match.'),
      orderBy: z.string().optional().describe('e.g. "CreatedDateTime desc".'),
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
    handler: (args) =>
      runTool('list_records', deps.logger, async () => {
        const { entity, entitySet } = await resolveObject(deps, args.object);
        const top = args.top ?? DEFAULT_TOP;

        const url = withQuery(
          deps.connection.transport.routes.entitySet(entitySet),
          buildQuery({
            filter: args.filter,
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

        return jsonResult({
          object: entitySet,
          returned: rows.length,
          ...(total === undefined
            ? {}
            : {
                total: total.total,
                totalIsExact: total.exact,
                hasMore: total.total > skipped + rows.length,
              }),
          ...(projection.defaulted && rows.length > 0
            ? {
                fields:
                  'a compact default set — pass `fields` for others, or "*" for whole records',
              }
            : {}),
          rows: projectRows(rows, projection.fields),
        });
      }),
  });
}
