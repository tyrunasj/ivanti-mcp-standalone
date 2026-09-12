import { z } from 'zod';
import { linkFieldsOf } from '../../ivanti/session/form-context.js';
import { toObjectId } from '../../ivanti/write/validated-write.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

export function createGetLinkFieldsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_link_fields',
    title: 'Get the link fields of an object',
    description:
      'The fields that point at another record, and the PAIR of fields each one is written ' +
      'through.\n\n' +
      'A link is not a column: it is a RecId field plus a `_Category` field naming the object the ' +
      'target lives in. Ivanti\'s refusals use the human label, which is neither — so this maps ' +
      'the label to the two fields you actually write.\n\n' +
      '**The mapping is per object, and the same field name can mean different things.** ' +
      'Measured on one tenant: `ProfileLink` is labelled "Customer" on an incident and ' +
      '"Contact Link" on a service request; a change has no `ProfileLink` and uses ' +
      '`RequestorLink`; knowledge articles have no links at all. Counts range from 0 to 21. Ask ' +
      'for the object you are about to write to.\n\n' +
      'Find the RecId to put in it with list_records or search against the target object.',
    annotations: {
      title: 'Get the link fields of an object',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object: `Incident#`, `Incidents` or `incident`.'),
    },
    handler: (args) =>
      runTool('get_link_fields', deps.logger, async () => {
        const { entity } = await resolveObject(deps, args.object);
        const form = await deps.connection.forms.get(toObjectId(entity.name));

        if (form === undefined) {
          return errorResult(
            `Ivanti has no create form for ${entity.name} that this role can reach, and the link ` +
              'fields live on the form. get_object_metadata still lists the fields; the ones ' +
              'ending `_RecID` are links.',
          );
        }

        const links = linkFieldsOf(form);

        return jsonResult({
          object: entity.name,
          count: links.length,
          links,
          note: 'Write both fields of a pair in the same call — a RecId without its Category is refused.',
        });
      }),
  });
}
