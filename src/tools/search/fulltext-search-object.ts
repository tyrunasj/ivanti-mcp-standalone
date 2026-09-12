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
import { assertOrderBy } from '../shared/order-by.js';
import { QUERY_WORDS, noHitsNote } from './query-words.js';

export function createFulltextSearchObjectTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'fulltext_search_object',
    title: 'Search within a Business Object',
    description:
      'Keyword search across one Business Object — "incidents mentioning printer". This is the ' +
      'ONLY substring mechanism Ivanti honours: `$filter` has no `contains()`, and asking for ' +
      'one returns the full unfiltered set.\n\n' +
      'ZERO HITS DOES NOT MEAN ZERO RECORDS. It searches only the fields Ivanti INDEXES — the ' +
      'subject, description and notes of a ticket — not every text field, and on some objects ' +
      'not much at all. Measured: `png` finds none of this tenant\'s 344 PNG attachments, and ' +
      '`laptop` finds neither computer whose `ChassisType` is literally "Laptop". Before ' +
      'reporting that nothing matches, retry with `list_records` and an `eq` filter on the ' +
      'field you actually mean.\n\n' +
      'Matching is case-insensitive within the indexed fields; `printer` finds "Printer is not ' +
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
      object: z
        .string()
        .describe(
          'Business Object, in any of the three forms Ivanti spells them — the AdminUI id, the ' +
            'entity set, or the entity (`Incident#` / `Incidents` / `incident`, and the same ' +
            'shape for a Business Object this tenant defined itself). Names are tenant-specific: ' +
            'take them from list_business_objects rather than assuming the ones Ivanti ships.',
        ),
      query: z.string().describe(QUERY_WORDS),
      filter: z
        .string()
        .optional()
        .describe("Narrow the search further, e.g. \"Status eq 'Active'\"."),
      orderBy: z
        .string()
        .optional()
        .describe(
          'Sort clause: `CreatedDateTime desc`. The field name is checked before the request — ' +
            'Ivanti answers an unknown sort field with an EMPTY RESULT, not an error.',
        ),
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
        assertOrderBy(args.orderBy, resolved.entity);
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
          // In the payload, not only in the description: across a long session the manifest
          // scrolls out of attention and an empty `rows` reads as a clean negative.
          ...(rows.length === 0 ? { note: noHitsNote(args.query) } : {}),
          rows: projectRows(rows, parseFieldList(args.fields) ?? COMPACT_ROW_FIELDS),
        });
      }),
  });
}
