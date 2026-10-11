// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { ALL_FIELDS } from '../../ivanti/odata/compact-fields.js';
import { parseFieldList, projectRows } from '../../ivanti/odata/projection.js';
import { buildQuery, DEFAULT_TOP, MAX_TOP, readTotal, withQuery } from '../../ivanti/odata/query.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import { readRows } from '../shared/read-rows.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { explainReadError, prepareFilterRead } from '../shared/read-preflight.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { COMPACT_FITTED_NOTE, compactRows } from '../shared/compact-rows.js';
import { ignoredFieldsPayload } from '../shared/ignored-fields.js';
import { withImpersonation, zeroNote } from '../shared/zero-note.js';
import { transportFor } from '../shared/transport-for.js';
import { OBJECT_ARGUMENT } from '../shared/object-argument.js';

export function createListRecordsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'list_records',
    title: 'List records',
    description:
      'Lists records from a Business Object.\n\n' +
      'FILTER — Ivanti supports a strict subset of OData: `eq ne gt ge lt le and or` and ' +
      'a LEADING `(…)`. It has NO functions: `contains()`, `startswith()` and `year()` are ' +
      'SILENTLY IGNORED and the full unfiltered set comes back, so this tool refuses them ' +
      'before sending. Use `search` for substrings.\n' +
      '- empty field: `Owner eq \'$NULL\'` — the only way to match one, and TEXT FIELDS ONLY ' +
      '(a date or number is refused here, because Ivanti answers it as though the field name ' +
      "were wrong). `ne '$NULL'` counts the empty string as PRESENT: add `and Owner ne ''`.\n" +
      '- dates are bare and unquoted: `CreatedDateTime gt 2026-01-01`\n' +
      '- there is no default order; "the latest" needs `orderBy`\n\n' +
      'ZERO ROWS IS A REAL ANSWER: the filter and sort fields are both checked against the ' +
      'object before the request, so an empty result is a fact about the data and not a typo. ' +
      'IF AND ONLY IF the answer carries `scopedTo`, it means something weaker — this server is ' +
      'returning one person\'s own records, and a record belonging to someone else answers zero ' +
      'too, **including one they have been asked to approve**. In that case do not hunt through ' +
      'neighbouring numbers and do not say it does not exist; say you cannot see it.\n\n' +
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
        .describe(OBJECT_ARGUMENT),
      filter: z
        .string()
        .optional()
        .describe("OData filter, e.g. \"Status eq 'Active' and Priority eq '1'\"."),
      search: z
        .string()
        .optional()
        .describe(
          'Keyword search across the record\'s text fields — the only substring match. Same ' +
            'grammar as fulltext_search_object: A SPACE MEANS AND, `or` widens, words ' +
            'match from their START, and quoting a phrase matches nothing.',
        ),
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
        const transport = transportFor(deps.connection.transport, context);
        const resolved = await resolveObject(deps, args.object);
        const { entity, entitySet } = resolved;
        const top = args.top ?? DEFAULT_TOP;

        // Before the request: an unknown sort field answers 204, which is indistinguishable from
        // "there are no such records". In `enduser` mode this also narrows the filter to the
        // caller's own records, and refuses when nobody has said who that is.
        const scoped = await prepareFilterRead(deps, context, resolved, {
          filter: args.filter,
          orderBy: args.orderBy,
        });

        const url = withQuery(
          transport.routes.entitySet(entitySet),
          buildQuery({
            filter: scoped.filter,
            search: args.search,
            orderBy: args.orderBy,
            top,
            skip: args.skip,
            count: true,
          }),
        );

        const payload = await transport
          .request<OdataRecord>(url)
          .catch((error: unknown) => {
            throw explainReadError(error, entity, {
              filter: args.filter,
              fields: parseFieldList(args.fields),
            });
          });
        const rows = readRows<OdataRecord>(payload, url);
        const total = readTotal(payload, rows.length);
        const skipped = args.skip ?? 0;

        // The default field set, decided against THIS object's rows rather than a fixed list: a
        // tenant defines its own Business Objects, so the preference list is a starting point.
        const shown = compactRows(rows, args.fields, entity);

        return jsonResult({
          object: entitySet,
          ...(scoped.scopedTo === undefined ? {} : { scopedTo: scoped.scopedTo }),
          returned: rows.length,
          // `scopedTo` alone reads as a label rather than a caveat, and a bare zero under it was
          // the one place a tester could have told someone a record does not exist when it does.
          ...(rows.length === 0 && (args.search !== undefined || scoped.scopedTo === undefined)
            ? {
                note: zeroNote({
                  looked: entitySet,
                  ...(args.search === undefined ? {} : { keyword: args.search }),
                  ...(scoped.scopedTo === undefined ? {} : { scopedTo: scoped.scopedTo }),
                }, context),
              }
            : {}),
          ...(rows.length === 0 && args.search === undefined && scoped.scopedTo !== undefined
            ? {
                note: withImpersonation(
                  `No ${entitySet} record matching this is visible to ${scoped.scopedTo}. That ` +
                    'is not the same as none existing — a record belonging to someone else ' +
                    'answers zero here too.',
                  context,
                ),
              }
            : {}),
          // Emitted on an empty answer too. The zero case used to drop `total`, `totalIsExact`
          // and `hasMore` — exactly where an exactness signal settles whether "none" is a fact
          // or a visibility limit, and the one place a reader most needs it.
          ...(total === undefined
            ? { total: rows.length, totalIsExact: true, hasMore: false }
            : {
                total: total.total,
                totalIsExact: total.exact,
                hasMore: total.total > skipped + rows.length,
              }),
          ...(shown.defaulted && rows.length > 0
            ? {
                fields: shown.note ?? COMPACT_FITTED_NOTE,
                ...(shown.otherFields === undefined ? {} : { otherFields: shown.otherFields }),
              }
            : {}),
          ...ignoredFieldsPayload(rows, parseFieldList(args.fields)),
          rows: projectRows(rows, shown.fields),
        });
      }),
  });
}
