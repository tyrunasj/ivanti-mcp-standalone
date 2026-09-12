import { z } from 'zod';
import { listQuickActions, toActionObjectId } from '../../ivanti/quick-actions/execute.js';
import { toObjectId } from '../../ivanti/write/validated-write.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

/** Answers OK and changes nothing: a behaviour of Ivanti's own web client. */
export const NO_OP_ACTION_TYPE = 'UIAction';

export function createListQuickActionsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'list_quick_actions',
    title: 'List quick actions',
    description:
      "The buttons Ivanti itself offers on a record — escalate, send this email, close with a " +
      'template, clone. They are the tenant\'s encoded procedures, so running one is usually ' +
      'more correct than reproducing its field updates by hand.\n\n' +
      'Action ids are per-tenant AND role-scoped, so they are discovered here rather than ' +
      'remembered: one seen on another tenant, or under another role, will not exist.\n\n' +
      `Actions of type \`${NO_OP_ACTION_TYPE}\` are marked \`doesNothingServerSide\` — they are ` +
      'web-client behaviour with nothing to execute, and running one answers OK while changing ' +
      'nothing.',
    annotations: {
      title: 'List quick actions',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object: `Incident#`, `Incidents` or `incident`.'),
      search: z.string().optional().describe('Case-insensitive substring of the action name.'),
    },
    handler: (args) =>
      runTool('list_quick_actions', deps.logger, async () => {
        const { entity } = await resolveObject(deps, args.object);
        const objectId = toActionObjectId(toObjectId(entity.name));

        const actions = await listQuickActions(deps.connection.session, objectId);
        const search = args.search?.toLowerCase();
        const matching = actions.filter(
          (action) => search === undefined || action.name.toLowerCase().includes(search),
        );

        return jsonResult({
          object: entity.name,
          count: matching.length,
          ...(matching.length < actions.length ? { of: actions.length } : {}),
          actions: matching.map((action) => ({
            name: action.name,
            actionId: action.actionId,
            actionType: action.actionType,
            ...(action.actionType === NO_OP_ACTION_TYPE ? { doesNothingServerSide: true } : {}),
          })),
        });
      }),
  });
}
