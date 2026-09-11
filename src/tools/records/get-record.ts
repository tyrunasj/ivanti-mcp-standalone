import { z } from 'zod';
import { parseFieldList, projectRow } from '../../ivanti/odata/projection.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

export function createGetRecordTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_record',
    title: 'Get record',
    description:
      'Fetches ONE record by its 32-character RecId — one round trip, no filter.\n\n' +
      'Use this only when you already hold the RecId (from a list or search result). If you ' +
      'have a human-facing identifier such as an incident number or a login, use list_records ' +
      'with a filter instead: `IncidentNumber eq 11150`.\n\n' +
      'Pass `fields` on every call you can. A bare incident is ~180 fields and ~10 KB of JSON, ' +
      'and you almost never need all of it. Names the object does not have are ignored, because ' +
      'the narrowing happens here rather than in Ivanti — Ivanti answers a projected ' +
      'single-record read with an empty body.',
    annotations: {
      title: 'Get record',
      readOnlyHint: true,
      idempotentHint: true,
      // Returns text people wrote into tickets: untrusted content.
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object: `Incident#`, `Incidents` or `incident`.'),
      recordId: z
        .string()
        .describe('The 32-character RecId. NOT an incident number or other human-facing id.'),
      fields: z
        .string()
        .optional()
        .describe('Comma-separated field names to return, e.g. "Subject,Status,Owner".'),
    },
    handler: (args) =>
      runTool('get_record', deps.logger, async () => {
        const { entitySet } = await resolveObject(deps, args.object);
        const url = deps.connection.transport.routes.record(entitySet, args.recordId);

        const record = await deps.connection.transport.request<OdataRecord>(url);
        if (record === undefined) {
          return errorResult(
            `No ${entitySet} record with RecId ${args.recordId}. Ivanti returned an empty body, ` +
              'which for a read by key means the record is not there.',
          );
        }

        const fields = parseFieldList(args.fields);
        return jsonResult({
          object: entitySet,
          record: fields === undefined ? record : projectRow(record, fields),
        });
      }),
  });
}
