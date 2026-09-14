// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { COMPACT_ROW_FIELDS } from '../../ivanti/odata/compact-fields.js';
import { parseFieldList, projectRows } from '../../ivanti/odata/projection.js';
import { MAX_TOP } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { answersForSignedInAccount } from './list-saved-searches.js';

export function createSavedSearchTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'saved_search',
    title: 'Run a saved search',
    description:
      'Runs one of the tenant\'s own saved searches, by name and id from list_saved_searches. ' +
      'The definition is Ivanti\'s, so the answer matches what a person sees in the product — ' +
      'which is usually closer to what was asked than a filter composed from scratch.\n\n' +
      'A search that matches nothing answers with no rows at all, and that is a real answer.\n\n' +
      'A name beginning "My" resolves against the account this server signs in as, never the ' +
      'person asking; the result says so. Rows are trimmed to a compact set of fields — pass ' +
      '`fields`, or `"*"` for whole records.\n\n' +
      'THERE IS NO `orderBy`: rows arrive in the order the saved search itself defines, which ' +
      'this server cannot change. For "the oldest" or "the most recent" of something, use ' +
      'list_records with an `orderBy` instead — paging this to find an extreme is both slow and ' +
      'unreliable.',
    annotations: {
      title: 'Run a saved search',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object the search belongs to.'),
      name: z.string().describe('Saved search name, exactly as list_saved_searches reports it.'),
      searchId: z.string().describe('The `id` from list_saved_searches.'),
      fields: z.string().optional().describe('Comma-separated fields, or "*" for whole records.'),
      top: z.number().int().min(1).max(MAX_TOP).optional().describe('Rows to return. Default 25.'),
      skip: z.number().int().min(0).optional().describe('Rows to skip, for paging.'),
    },
    handler: (args) =>
      runTool('saved_search', deps.logger, async () => {
        const { entity, entitySet } = await resolveObject(deps, args.object);

        // `$select` is useless here in a way that looks like it worked: Ivanti keeps every key
        // and blanks the values of the ones not selected — 181 keys, all null but the chosen
        // few. Projection stays client-side.
        const query = new URLSearchParams({
          ActionId: args.searchId,
          $inlinecount: 'allpages',
          $top: String(args.top ?? 25),
        });
        if (args.skip !== undefined && args.skip > 0) query.set('$skip', String(args.skip));

        const url = `${deps.connection.transport.routes.savedSearch(entitySet, args.name)}?${query.toString()}`;
        const payload = await deps.connection.transport.request<OdataRecord>(url);
        // A saved search matching nothing answers 204 with an empty body.
        const rows = readCollection<OdataRecord>(payload, url);
        const total = payload?.['@odata.count'];

        const requested = parseFieldList(args.fields);
        const fields = args.fields?.trim() === '*' ? undefined : (requested ?? COMPACT_ROW_FIELDS);

        return jsonResult({
          object: entity.name,
          search: args.name,
          returned: rows.length,
          ...(typeof total === 'number' ? { total } : {}),
          ...(answersForSignedInAccount(args.name)
            ? {
                answeredFor:
                  'This search resolves "my" against the account this server signs in as — the ' +
                  'tenant API key\'s account, NOT the person asking. These are not their ' +
                  'records. For a named person use list_assigned_work.',
              }
            : {}),
          rows: projectRows(rows, fields),
        });
      }),
  });
}
