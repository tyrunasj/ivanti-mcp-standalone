import { z } from 'zod';
import {
  describeFailure,
  executeAction,
  listQuickActions,
  toActionObjectId,
  type ActionPrompt,
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

export function createRunQuickActionTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'run_quick_action',
    title: 'Run a quick action',
    description:
      'Runs one of Ivanti\'s own actions against a record: escalate it, send the email, close it ' +
      'with a template.\n\n' +
      'SOME ACTIONS CANNOT BE UNDONE. One whose name contains Close or Cancel usually moves the ' +
      'record to a final state, after which it refuses every write — no edits, no notes, no ' +
      'attachments, and no reopening, even where the object also has a Reopen action. Prefer ' +
      'Resolved over Closed where the tenant offers both, and confirm with the person before ' +
      'running anything final. A `SendEmail` action reaches real people and cannot be recalled.\n\n' +
      '`saved: true` MEANS IVANTI ACCEPTED THE COMMIT, NOT THAT THE RECORD CHANGED. An action ' +
      'whose preconditions the record does not meet commits cleanly and does nothing — a reopen ' +
      'run against an already-resolved record reported `saved: true` and moved nothing. Read the ' +
      'record back before telling anyone it worked.\n\n' +
      'THIS REPEATS ITS SIDE EFFECTS ON RETRY. An action that sends an email sends another one; ' +
      'one that creates a child record creates a second. If a call fails ambiguously, check the ' +
      'record before running it again.\n\n' +
      'Preview first with preview_quick_action to learn what it asks for, then pass those ' +
      'answers as `answers`. This tool previews again itself — Ivanti mints a token per probe ' +
      'and the commit must echo the one from its own — so an action that suddenly demands an ' +
      'answer you did not supply is refused rather than run half-configured.',
    annotations: {
      title: 'Run a quick action',
      readOnlyHint: false,
      // It does whatever the tenant defined — email, child records, status changes.
      destructiveHint: true,
      // Running it twice runs it twice.
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      object: z.string().describe('Business Object the record belongs to.'),
      recordId: z.string().describe('The 32-character RecId to act on.'),
      actionId: z.string().describe('`actionId` from list_quick_actions.'),
      answers: z
        .record(z.string(), z.string())
        .optional()
        .describe('Values for the prompts preview_quick_action reported, keyed by field name.'),
    },
    handler: (args, context) =>
      runTool('run_quick_action', deps.logger, async () => {
        const resolved = await resolveObject(deps, args.object);
        const { entity } = resolved;
        const objectId = toActionObjectId(toObjectId(entity.name));

        // An end user runs the tenant's procedures on their own record, and only the procedures
        // the deployment named. Both are no-ops in `full`, where the audience is IT staff.
        await assertRecordWritable(deps, context, resolved, args.recordId);

        const known = await listQuickActions(deps.connection.session, objectId);
        const action = known.find(
          (candidate) => candidate.actionId.toLowerCase() === args.actionId.toLowerCase(),
        );
        if (action !== undefined && !deps.actions.allows(action.name)) {
          throw new ActionNotAllowedError(action.name, deps.actions.allowed);
        }

        if (action === undefined) {
          return errorResult(
            `No quick action ${args.actionId} on ${objectId} for this role. List them with ` +
              'list_quick_actions — ids are per-tenant and role-scoped.',
          );
        }

        if (action.actionType === NO_OP_ACTION_TYPE) {
          return errorResult(
            `'${action.name}' is a ${NO_OP_ACTION_TYPE}: it would answer OK and change nothing. ` +
              'Refusing rather than reporting a success that did not happen.',
          );
        }

        const form = await deps.connection.forms.get(objectId);
        if (form === undefined) {
          return errorResult(
            `This role has no form for ${objectId}, and running an action without one means ` +
              'committing without being able to probe first. Refusing.',
          );
        }

        const shared = {
          session: deps.connection.session,
          objectId,
          recordId: args.recordId,
          actionId: args.actionId,
          formName: form.formName,
        };

        // A fresh probe every time: the commit echoes a token this probe mints, and it also says
        // what the action asks for *now* rather than when someone last looked.
        const probe = await executeAction({ ...shared, shouldSave: false });

        const prompts: ActionPrompt[] = probe.promptParams ?? [];
        const answers = args.answers ?? {};
        const unanswered = prompts.filter(
          (prompt) =>
            prompt.Required === true &&
            prompt.Hidden !== true &&
            (answers[prompt.FieldName] ?? '') === '' &&
            (prompt.Value === null || prompt.Value === undefined || prompt.Value === ''),
        );

        if (unanswered.length > 0) {
          return errorResult(
            `'${action.name}' requires ${unanswered
              .map((prompt) => `${prompt.FieldName}${prompt.Label ? ` (${String(prompt.Label)})` : ''}`)
              .join(', ')}. Nothing was run. Supply them as \`answers\`.`,
          );
        }

        const filled = prompts.map((prompt) => {
          const answer = answers[prompt.FieldName];
          return answer === undefined ? prompt : { ...prompt, Value: answer };
        });

        const result = await executeAction({
          ...shared,
          shouldSave: true,
          prompts: filled.length > 0 ? filled : null,
          parentActionExecutionInstanceId: probe.parentActionExecutionInstanceId ?? null,
        });

        const failures = describeFailure(result);
        if (failures.length > 0) {
          return errorResult(
            `'${action.name}' failed: ${failures.join('; ')}. Check the record before retrying — ` +
              'an action that partly ran has partly happened.',
          );
        }

        deps.logger.info('ivanti quick action run', { object: objectId, action: action.name });

        return jsonResult({
          object: entity.name,
          action: action.name,
          ran: true,
          ...(result.saved === undefined ? {} : { saved: result.saved }),
          ...(result.newObjectIds === undefined || result.newObjectIds === null
            ? {}
            : { created: result.newObjectIds }),
          ...(result.errors?.warningMessages?.length
            ? { warnings: result.errors.warningMessages.map(String) }
            : {}),
          note: 'Read the record back to see what changed — the reply says it ran, not what it did.',
        });
      }),
  });
}
