import { z } from 'zod';
import { buildQuery, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { encodeRecordId, recordRecId, recordSummary, recordTitle } from './record-identity.js';

/** Where a question usually lands when the asker did not say which object. */
const DEFAULT_OBJECTS = ['incidents', 'servicereqs', 'changes'] as const;
const PER_OBJECT_TOP = 10;
const MAX_RESULTS = 25;

export function createSearchTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'search',
    title: 'Search across Business Objects',
    description:
      'Keyword search ACROSS Business Objects — the one to reach for when you do not know ' +
      'which object holds the answer. Returns `{ results: [{ id, title, text }] }`; pass an ' +
      '`id` to `fetch` for the whole record.\n\n' +
      `Searches ${DEFAULT_OBJECTS.join(', ')} by default, ${String(PER_OBJECT_TOP)} hits each. ` +
      'Name `objects` to look elsewhere — each one costs a request, so name only what you need.\n\n' +
      'This fans out Ivanti\'s per-object keyword search rather than using its cross-object ' +
      'search endpoint, which has been observed to answer an empty array for terms that ' +
      'per-object search matches dozens of times. An empty result here genuinely means no match.\n\n' +
      'For one known object use fulltext_search_object; for an exact value use list_records.',
    annotations: {
      title: 'Search across Business Objects',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      query: z.string().describe('Words to look for. Case-insensitive.'),
      objects: z
        .array(z.string())
        .optional()
        .describe(`Business Objects to search. Default: ${DEFAULT_OBJECTS.join(', ')}.`),
    },
    handler: (args) =>
      runTool('search', deps.logger, async () => {
        const objects = args.objects ?? [...DEFAULT_OBJECTS];
        const skipped: { object: string; reason: string }[] = [];

        const found = await Promise.all(
          objects.map(async (object) => {
            try {
              const { entitySet } = await resolveObject(deps, object);
              const url = withQuery(
                deps.connection.transport.routes.entitySet(entitySet),
                buildQuery({ search: args.query, top: PER_OBJECT_TOP }),
              );
              const rows = readCollection<OdataRecord>(
                await deps.connection.transport.request<OdataRecord>(url),
                url,
              );

              // A row without a RecId cannot be fetched back, so it is not a result.
              return rows.flatMap((row) => {
                const recId = recordRecId(row);
                return recId === undefined
                  ? []
                  : [
                      {
                        id: encodeRecordId(entitySet, recId),
                        title: recordTitle(row),
                        text: recordSummary(row),
                      },
                    ];
              });
            } catch (error: unknown) {
              // One object the key cannot read must not empty the whole answer.
              skipped.push({
                object,
                reason: error instanceof Error ? error.message : 'failed',
              });
              return [];
            }
          }),
        );

        const results = found.flat().slice(0, MAX_RESULTS);

        return jsonResult({
          results,
          searched: objects,
          ...(skipped.length > 0 ? { skipped } : {}),
        });
      }),
  });
}
