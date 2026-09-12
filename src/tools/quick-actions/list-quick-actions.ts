import { z } from 'zod';
import { listQuickActions, toActionObjectId } from '../../ivanti/quick-actions/execute.js';
import { toObjectId } from '../../ivanti/write/validated-write.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { jsonResult } from '../shared/result.js';
import { resolveObject } from '../shared/resolve-object.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { zeroNote } from '../shared/zero-note.js';

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
      'EVERY ACTION DEFINED ON THE OBJECT — ~104 on a stock incident, so PASS `actionType` OR ' +
      '`search` ON THE FIRST CALL; `UpdateObject` and `Composite` are the ~34 that change ' +
      'anything. These are not the ones valid for one record either: whether an action ' +
      'applies depends on that record\'s state and the list does not say — a Reopen action sits ' +
      'beside a Close action even where the record can only go one way.\n\n' +
      'READ `actionType` BEFORE CHOOSING BY NAME. `SendEmail` notifies real people and changes ' +
      'nothing on the record — three actions here are named "…Escalation…" and all three only ' +
      'send mail, while the one that actually reassigns is called "Reassign Owner Team". ' +
      '`UpdateObject` and `Composite` change the record.\n\n' +
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
      object: z
        .string()
        .describe(
          'Business Object, in any of the three forms Ivanti spells them — the AdminUI id, the ' +
            'entity set, or the entity (`Incident#` / `Incidents` / `incident`, and the same ' +
            'shape for a Business Object this tenant defined itself). Names are tenant-specific: ' +
            'take them from list_business_objects rather than assuming the ones Ivanti ships.',
        ),
      search: z.string().optional().describe('Case-insensitive substring of the action name.'),
      actionType: z
        .string()
        .optional()
        .describe(
          'Return only actions of this type. `UpdateObject` and `Composite` change the record; ' +
            '`SendEmail` notifies people and changes nothing. Filtering by type is more reliable ' +
            'than reading the names — three actions on incident are called "…Escalation…" and ' +
            'all three only send mail.',
        ),
    },
    handler: (args) =>
      runTool('list_quick_actions', deps.logger, async () => {
        const { entity } = await resolveObject(deps, args.object);
        const objectId = toActionObjectId(toObjectId(entity.name));

        // Only what this audience may actually run: offering an end user an action the gate
        // would refuse is an invitation to a refusal, not a capability.
        const actions = (await listQuickActions(deps.connection.session, objectId)).filter(
          (action) => deps.actions.allows(action.name),
        );
        const search = args.search?.toLowerCase();
        const wantedType = args.actionType?.toLowerCase();
        const matching = actions.filter(
          (action) =>
            (search === undefined || action.name.toLowerCase().includes(search)) &&
            (wantedType === undefined || action.actionType.toLowerCase() === wantedType),
        );

        return jsonResult({
          object: entity.name,
          count: matching.length,
          ...(matching.length === 0
            ? {
                note: zeroNote({
                  looked: `quick actions on ${entity.name}`,
                  ...(args.search === undefined ? {} : { keyword: args.search }),
                  because:
                    actions.length === 0
                      ? 'THIS DEPLOYMENT NARROWS THE LIST: where an allowlist of action names is ' +
                        'configured, an action the tenant defines but the allowlist omits is not ' +
                        'shown here at all. Zero can therefore mean the tenant defined none, the ' +
                        'role sees none, OR this deployment allows none — and on this object it ' +
                        'means you cannot run one either way.'
                      : `${String(actions.length)} actions exist on this object; none matches ` +
                        'the filters you passed.',
                }),
              }
            : {}),
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
