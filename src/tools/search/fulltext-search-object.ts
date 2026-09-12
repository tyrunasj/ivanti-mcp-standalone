import { z } from 'zod';
import { COMPACT_ROW_FIELDS } from '../../ivanti/odata/compact-fields.js';
import { parseFieldList, projectRows } from '../../ivanti/odata/projection.js';
import { buildQuery, DEFAULT_TOP, MAX_TOP, readTotal, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { scopeToOwnRecords } from '../shared/own-records.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

export function createFulltextSearchObjectTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'fulltext_search_object',
    title: 'Search within a Business Object',
    description:
      'Keyword search across the text fields of one Business Object — "incidents mentioning ' +
      'printer". This is the ONLY substring mechanism Ivanti honours: `$filter` has no ' +
      '`contains()`, and asking for one returns the full unfiltered set.\n\n' +
      'Matching is case-insensitive and whole-field-agnostic; `printer` finds "Printer is not ' +
      'working". It composes with `filter`, so "open incidents mentioning printer" is one call.\n\n' +
      'Returns a compact set of fields by default. Ask for `fields` when you need more, and use ' +
      'list_records instead when you know the exact value to match.',
    annotations: {
      title: 'Search within a Business Object',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object: `Incident#`, `Incidents` or `incident`.'),
      query: z.string().describe('Words to look for. Case-insensitive.'),
      filter: z
        .string()
        .optional()
        .describe("Narrow the search further, e.g. \"Status eq 'Active'\"."),
      orderBy: z.string().optional().describe('e.g. "CreatedDateTime desc".'),
      fields: z
        .string()
        .optional()
        .describe('Comma-separated fields to return. Defaults to a compact identifying set.'),
      top: z.number().int().min(1).max(MAX_TOP).optional().describe(`Default ${String(DEFAULT_TOP)}.`),
    },
    handler: (args, context) =>
      runTool('fulltext_search_object', deps.logger, async () => {
        const resolved = await resolveObject(deps, args.object);
        const { entitySet } = resolved;
        const scoped = await scopeToOwnRecords(deps, context, resolved, args.filter);

        const url = withQuery(
          deps.connection.transport.routes.entitySet(entitySet),
          buildQuery({
            search: args.query,
            filter: scoped.filter,
            orderBy: args.orderBy,
            top: args.top ?? DEFAULT_TOP,
            count: true,
          }),
        );

        const payload = await deps.connection.transport.request<OdataRecord>(url);
        const rows = readCollection<OdataRecord>(payload, url);
        const total = readTotal(payload, rows.length);

        return jsonResult({
          object: entitySet,
          ...(scoped.scopedTo === undefined ? {} : { scopedTo: scoped.scopedTo }),
          query: args.query,
          returned: rows.length,
          ...(total === undefined ? {} : { total: total.total, totalIsExact: total.exact }),
          rows: projectRows(rows, parseFieldList(args.fields) ?? COMPACT_ROW_FIELDS),
        });
      }),
  });
}
