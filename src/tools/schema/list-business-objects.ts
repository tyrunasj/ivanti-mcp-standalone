import { z } from 'zod';
import { toEntitySet } from '../../ivanti/metadata/entity-names.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

/** `audit_incident`, `audit_employee`, … — one shadow table per audited object. */
const AUDIT_PREFIX = 'audit_';

export function createListBusinessObjectsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'list_business_objects',
    title: 'List Business Objects',
    description:
      'Lists the Business Objects (record types) this tenant exposes, with the entity-set name ' +
      'the record tools take. Start here when you do not know what an object is called — ' +
      'Ivanti names are tenant-specific and rarely what you would guess.\n\n' +
      'THIS IS NOT AN ACCESS BOUNDARY. It is what the API key can see in the schema; ' +
      'permissions are enforced per request, so an object listed here may still be refused.\n\n' +
      'The list is assembled from several metadata graphs and is wide but not exhaustive. ' +
      'Audit shadow tables are hidden unless asked for.',
    annotations: {
      title: 'List Business Objects',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      search: z
        .string()
        .optional()
        .describe('Case-insensitive substring; omit to list everything.'),
      includeAuditTables: z
        .boolean()
        .optional()
        .describe('Include audit_* shadow tables. They are rarely what you want.'),
    },
    handler: (args) =>
      runTool('list_business_objects', deps.logger, async () => {
        await deps.connection.metadata.widen();
        const names = await deps.connection.metadata.entityNames();

        const search = args.search?.toLowerCase();
        const matching = names.filter((name) => {
          if (args.includeAuditTables !== true && name.startsWith(AUDIT_PREFIX)) return false;
          return search === undefined || name.includes(search);
        });

        return jsonResult({
          count: matching.length,
          hiddenAuditTables:
            args.includeAuditTables === true
              ? 0
              : names.filter((name) => name.startsWith(AUDIT_PREFIX)).length,
          objects: matching.map((name) => ({
            object: name,
            // What the record tools take. Ivanti appends a literal 's': `category` → `categorys`.
            entitySet: toEntitySet(`${name}#`),
          })),
        });
      }),
  });
}
