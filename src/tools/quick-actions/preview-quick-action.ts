// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

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
import { assertRecordWritable } from '../shared/own-records.js';
import { ActionNotAllowedError } from '../shared/action-gate.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { NO_OP_ACTION_TYPE } from './list-quick-actions.js';
import { connectionFor } from '../shared/connection-for.js';

export function createPreviewQuickActionTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'preview_quick_action',
    title: 'Preview a quick action',
    description:
      'Asks Ivanti what an action would ASK FOR, without running it.\n\n' +
      'IT DOES NOT REPORT WHAT THE ACTION WOULD CHANGE. A preview returns the action\'s prompts ' +
      'and nothing else, so an action that sends an email, one that closes the record for good, ' +
      'and one that does nothing all preview identically as `wouldPrompt: false`. An empty ' +
      'preview is not reassurance — it means the action needs no input from you, not that it is ' +
      'harmless.\n\n' +
      'Judge the action by its NAME and `actionType` before running it: `SendEmail` notifies ' +
      'someone and cannot be recalled; `UpdateObject` and `Composite` change the record, and a ' +
      'name containing Close or Cancel usually moves it to a state nothing can edit or reopen. ' +
      'When a person asks you to close something, confirm that is what they mean.\n\n' +
      'The reply lists any `prompts` the action needs answered — run_quick_action takes those ' +
      'values.\n\n' +
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
    handler: (args, context) =>
      runTool('preview_quick_action', deps.logger, async () => {
        const connection = connectionFor(deps, context);
        const resolved = await resolveObject(deps, args.object);
        const { entity } = resolved;
        const objectId = toActionObjectId(toObjectId(entity.name));

        // An end user runs the tenant's procedures on their own record, and only the procedures
        // the deployment named. Both are no-ops in `full`, where the audience is IT staff.
        await assertRecordWritable(deps, context, resolved, args.recordId);

        const known = await listQuickActions(connection.session, objectId);
        const action = known.find(
          (candidate) => candidate.actionId.toLowerCase() === args.actionId.toLowerCase(),
        );
        if (action !== undefined && !deps.actions.allows(action.name)) {
          throw new ActionNotAllowedError(action.name, deps.actions.allowed);
        }

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

        const form = await connection.forms.get(objectId);
        if (form === undefined) {
          return errorResult(
            `Cannot preview an action on ${objectId}: this role has no form for it, and Ivanti ` +
              'honours a no-op probe only on the form path. Probing the other way would RUN the ' +
              'action, so no preview is offered. Use run_quick_action when you mean to run it.',
          );
        }

        const result = await executeAction({
          session: connection.session,
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
