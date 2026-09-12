import { z } from 'zod';
import {
  describeFailure,
  executeAction,
  listQuickActions,
  toActionObjectId,
} from '../../ivanti/quick-actions/execute.js';
import { toObjectId } from '../../ivanti/write/validated-write.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { NO_OP_ACTION_TYPE } from './list-quick-actions.js';

export function createPreviewQuickActionTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'preview_quick_action',
    title: 'Preview a quick action',
    description:
      'Asks Ivanti what an action would do to one record, and what it would ask for, WITHOUT ' +
      'running it.\n\n' +
      'Preview before running anything whose name you are inferring. The reply lists any ' +
      '`prompts` the action needs answered — run_quick_action takes those values.\n\n' +
      'A preview needs a form this role can reach: Ivanti honours "do not save" only on the form ' +
      'path, and the other path would RUN the action while reporting itself as a probe. Where ' +
      'there is no form, this refuses rather than guessing.\n\n' +
      'The token a preview mints is good for that preview only, so run_quick_action previews ' +
      'again itself rather than reusing this one.',
    annotations: {
      title: 'Preview a quick action',
      readOnlyHint: true,
      // Nothing is written — but only because the form path is used. See the module comment.
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object the record belongs to.'),
      recordId: z.string().describe('The 32-character RecId to preview against.'),
      actionId: z.string().describe('`actionId` from list_quick_actions.'),
    },
    handler: (args) =>
      runTool('preview_quick_action', deps.logger, async () => {
        const { entity } = await resolveObject(deps, args.object);
        const objectId = toActionObjectId(toObjectId(entity.name));

        const known = await listQuickActions(deps.connection.session, objectId);
        const action = known.find(
          (candidate) => candidate.actionId.toLowerCase() === args.actionId.toLowerCase(),
        );
        if (action === undefined) {
          return errorResult(
            `No quick action ${args.actionId} on ${objectId} for this role. Action ids are ` +
              'per-tenant and role-scoped — list them with list_quick_actions rather than ' +
              'reusing one seen elsewhere.',
          );
        }

        if (action.actionType === NO_OP_ACTION_TYPE) {
          return errorResult(
            `'${action.name}' is a ${NO_OP_ACTION_TYPE}: behaviour of Ivanti's web client with ` +
              'nothing to execute server-side. Running it would answer OK and change nothing.',
          );
        }

        const form = await deps.connection.forms.get(objectId);
        if (form === undefined) {
          return errorResult(
            `Cannot preview an action on ${objectId}: this role has no form for it, and Ivanti ` +
              'honours a no-op probe only on the form path. Probing the other way would RUN the ' +
              'action, so no preview is offered. Use run_quick_action when you mean to run it.',
          );
        }

        const result = await executeAction({
          session: deps.connection.session,
          objectId,
          recordId: args.recordId,
          actionId: args.actionId,
          formName: form.formName,
          shouldSave: false,
        });

        const failures = describeFailure(result);
        const prompts = (result.promptParams ?? [])
          .filter((prompt) => prompt.Hidden !== true)
          .map((prompt) => ({
            field: prompt.FieldName,
            label: prompt.Label ?? prompt.FieldName,
            type: prompt.FieldType,
            required: prompt.Required === true,
            ...(prompt.Value === null || prompt.Value === undefined ? {} : { default: prompt.Value }),
          }));

        return jsonResult({
          object: entity.name,
          action: action.name,
          actionType: action.actionType,
          wouldPrompt: result.IsPromptRequired === true || prompts.length > 0,
          prompts,
          ...(failures.length > 0 ? { blockers: failures } : {}),
          ...(result.errors?.warningMessages?.length
            ? { warnings: result.errors.warningMessages.map(String) }
            : {}),
          note: 'Nothing was written. run_quick_action previews again before committing.',
        });
      }),
  });
}
