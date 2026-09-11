import { z } from 'zod';
import { visibleFields } from '../../ivanti/metadata/csdl.js';
import { toEntitySet } from '../../ivanti/metadata/entity-names.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

/** `Edm.String` → `String`. The prefix is on every field of every entity and carries nothing. */
function shortType(type: string): string {
  return type.replace(/^Edm\./, '');
}

export function createGetObjectMetadataTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_object_metadata',
    title: 'Get Business Object metadata',
    description:
      'The fields and relationships of one Business Object: what you can read, filter on and ' +
      'ask for. Call this before composing a filter — Ivanti field names are rarely the obvious ' +
      'word (an incident\'s description is `Symptom`), and a wrong name is reported as a bad ' +
      'request, not as an empty result.\n\n' +
      'Accepts any of the three naming forms: `Incident#`, `Incidents` or `incident`.\n\n' +
      '`validated: true` marks a field whose value comes from a picklist rather than free text. ' +
      'Relationships are the names the related-records tool takes.',
    annotations: {
      title: 'Get Business Object metadata',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object: `Incident#`, `Incidents` or `incident`.'),
      search: z
        .string()
        .optional()
        .describe('Only fields whose name contains this (case-insensitive). Large objects carry 250+.'),
      includeRelationships: z
        .boolean()
        .optional()
        .describe('Default true. Set false when you only need field names.'),
    },
    handler: (args) =>
      runTool('get_object_metadata', deps.logger, async () => {
        const entity = await deps.connection.metadata.entity(args.object);
        const search = args.search?.toLowerCase();

        const fields = visibleFields(entity)
          .filter((field) => search === undefined || field.name.toLowerCase().includes(search))
          .map((field) => ({
            name: field.name,
            type: shortType(field.type),
            ...(field.nullable ? {} : { required: true }),
            ...(field.validated ? { validated: true } : {}),
          }));

        return jsonResult({
          object: entity.name,
          entitySet: toEntitySet(`${entity.name}#`),
          fieldCount: fields.length,
          ...(search === undefined ? {} : { searchedFor: args.search }),
          fields,
          ...(args.includeRelationships === false
            ? {}
            : { relationships: entity.relationships }),
        });
      }),
  });
}
