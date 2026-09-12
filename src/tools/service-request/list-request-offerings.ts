import { z } from 'zod';
import { listOfferings } from '../../ivanti/service-request/offerings.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

export function createListRequestOfferingsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'list_request_offerings',
    title: 'List request offerings',
    description:
      'The service catalog: what a person can request.\n\n' +
      'EACH OFFERING CARRIES TWO DIFFERENT IDS AND THEY ARE NOT INTERCHANGEABLE. ' +
      '`subscriptionId` is what submit_service_request takes; `templateId` is what ' +
      'get_service_request_parameters takes. Take both from the SAME entry — mixing two ' +
      "offerings' ids creates a request with none of the answers on it, and Ivanti reports that " +
      'as success.\n\n' +
      'Search is applied here, over name and description. Ivanti\'s own catalog search matches ' +
      'whole words and silently returns fewer offerings than exist — \'phone\' misses ' +
      "'New Smartphone Request' — so it is not used.",
    annotations: {
      title: 'List request offerings',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      search: z
        .string()
        .optional()
        .describe('Case-insensitive substring over the name and description.'),
      topLevelOnly: z
        .boolean()
        .optional()
        .describe(
          'Only the catalog\'s top-level offerings — roughly 20 of 130 on a stock tenant, and ' +
            'what the self-service portal shows first. Needs an Ivanti session; the answer says ' +
            'if it could not be narrowed.',
        ),
      person: z
        .string()
        .optional()
        .describe(
          "Whose catalog to read, as their RecId. Defaults to whoever this conversation is " +
            'acting for. The catalog is per person: entitlements differ.',
        ),
    },
    handler: (args, context) =>
      runTool('list_request_offerings', deps.logger, async () => {
        const pinned = context.pin?.person();
        const personRecId = args.person ?? pinned?.recId;

        if (personRecId === undefined) {
          return errorResult(
            'Whose catalog? The offerings a person sees depend on their entitlements, so this ' +
              'needs someone: call `act_as` with the name of the person you are helping, or ' +
              'pass `person` with their RecId.',
          );
        }

        const result = await listOfferings({
          transport: deps.connection.transport,
          session: deps.connection.session,
          logger: deps.logger,
          personRecId,
          topLevelOnly: args.topLevelOnly ?? false,
          ...(args.search === undefined ? {} : { search: args.search }),
        });

        return jsonResult({
          returned: result.offerings.length,
          servedBy: result.servedBy === 'catalog' ? "the catalog's top level" : 'the whole catalog',
          ...(pinned === undefined ? {} : { forPerson: pinned.displayName }),
          ...(result.note === undefined ? {} : { note: result.note }),
          offerings: result.offerings,
        });
      }),
  });
}
