import { z } from 'zod';
import { referencedFieldNames } from '../../ivanti/odata/filter.js';
import { buildQuery, readTotal, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { explainFieldError } from '../shared/explain-field-error.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { scopeToOwnRecords } from '../shared/own-records.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { assertNullFilterTypes } from '../shared/null-filter.js';
import { zeroNote } from '../shared/zero-note.js';

export function createCountRecordsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'count_records',
    title: 'Count records',
    description:
      'Answers "how many X are there" in one call, without paging through the records.\n\n' +
      'WHERE THE ANSWER CARRIES `scopedTo`, IT IS ONE PERSON\'S COUNT, not the tenant\'s — an ' +
      '`exact: true` under it is an exact total FOR THEM. Say whose number it is.\n\n' +
      'Takes the same `filter` and `search` as list_records, so "how many open incidents does ' +
      'this person have" is ' +
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
      object: z
        .string()
        .describe(
          'Business Object, in any of the three forms Ivanti spells them — the AdminUI id, the ' +
            'entity set, or the entity (`Incident#` / `Incidents` / `incident`, and the same ' +
            'shape for a Business Object this tenant defined itself). Names are tenant-specific: ' +
            'take them from list_business_objects rather than assuming the ones Ivanti ships.',
        ),
      filter: z.string().optional().describe('Same dialect as list_records.'),
      search: z
        .string()
        .optional()
        .describe(
          'Keyword search across the record\'s text fields — the only substring match. Same ' +
            'grammar as fulltext_search_object: A SPACE MEANS AND, `or` widens, words ' +
            'match from their START, and quoting a phrase matches nothing.',
        ),
    },
    handler: (args, context) =>
      runTool('count_records', deps.logger, async () => {
        const resolved = await resolveObject(deps, args.object);
        const { entity, entitySet } = resolved;
        assertNullFilterTypes(args.filter, entity);
        const scoped = await scopeToOwnRecords(deps, context, resolved, args.filter);

        // One row is enough to ask for: the count rides along with any page, and a page of one
        // is the cheapest thing to carry it.
        const url = withQuery(
          deps.connection.transport.routes.entitySet(entitySet),
          buildQuery({ filter: scoped.filter, search: args.search, top: 1, count: true }),
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
            ...(scoped.scopedTo === undefined ? {} : { scopedTo: scoped.scopedTo }),
            count: rows.length,
            exact: rows.length === 0,
            // This is the path a real zero takes — Ivanti answers an empty body rather than a
            // count — so the note has to be here too, not only on the counted branch below.
            ...(rows.length === 0
              ? {
                  note: zeroNote({
                    looked: entitySet,
                    ...(args.search === undefined ? {} : { keyword: args.search }),
                    ...(scoped.scopedTo === undefined ? {} : { scopedTo: scoped.scopedTo }),
                  }),
                }
              : { note: 'Ivanti returned rows without a count; this is a floor, not a total.' }),
          });
        }

        return jsonResult({
          object: entitySet,
          ...(scoped.scopedTo === undefined ? {} : { scopedTo: scoped.scopedTo }),
          count: total.total,
          ...(total.total === 0
            ? {
                note: zeroNote({
                  looked: entitySet,
                  ...(args.search === undefined ? {} : { keyword: args.search }),
                  ...(scoped.scopedTo === undefined ? {} : { scopedTo: scoped.scopedTo }),
                }),
              }
            : {}),
          exact: total.exact,
        });
      }),
  });
}
