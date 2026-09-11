import { z } from 'zod';
import { referencedFieldNames } from '../../ivanti/odata/filter.js';
import { buildQuery, readTotal, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { explainFieldError } from '../shared/explain-field-error.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

export function createCountRecordsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'count_records',
    title: 'Count records',
    description:
      'Answers "how many X are there" in one call, without paging through the records.\n\n' +
      'Takes the same `filter` and `search` as list_records, so "how many open incidents" is ' +
      '`count_records({ object: "Incidents", filter: "Status eq \'Active\'" })`.\n\n' +
      'READ `exact` BEFORE REPORTING THE NUMBER. `exact: true` is a total and may be reported ' +
      'as one. `exact: false` means Ivanti sent a count that contradicted the rows beside it, ' +
      'so all that is known is "at least this many" — say "at least", or page with list_records ' +
      'if the precise figure matters.',
    annotations: {
      title: 'Count records',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object: `Incident#`, `Incidents` or `incident`.'),
      filter: z.string().optional().describe('Same dialect as list_records.'),
      search: z.string().optional().describe('Keyword search across text fields.'),
    },
    handler: (args) =>
      runTool('count_records', deps.logger, async () => {
        const { entity, entitySet } = await resolveObject(deps, args.object);

        // One row is enough to ask for: the count rides along with any page, and a page of one
        // is the cheapest thing to carry it.
        const url = withQuery(
          deps.connection.transport.routes.entitySet(entitySet),
          buildQuery({ filter: args.filter, search: args.search, top: 1, count: true }),
        );

        const payload = await deps.connection.transport
          .request<OdataRecord>(url)
          .catch((error: unknown) => {
            throw explainFieldError(error, entity, referencedFieldNames({ filter: args.filter })) ?? error;
          });
        const rows = readCollection<OdataRecord>(payload, url);
        const total = readTotal(payload, rows.length);

        // No count and no rows is Ivanti's empty body for "nothing matched" — which is an exact
        // zero, not an unknown.
        if (total === undefined) {
          return jsonResult({
            object: entitySet,
            count: rows.length,
            exact: rows.length === 0,
            ...(rows.length === 0
              ? {}
              : { note: 'Ivanti returned rows without a count; this is a floor, not a total.' }),
          });
        }

        return jsonResult({ object: entitySet, count: total.total, exact: total.exact });
      }),
  });
}
