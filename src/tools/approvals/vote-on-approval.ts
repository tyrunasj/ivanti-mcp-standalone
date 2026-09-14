// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { executeAction, listQuickActions } from '../../ivanti/quick-actions/execute.js';
import { buildQuery, quoteOdataString, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { connectionFor } from '../shared/connection-for.js';

/**
 * Casting a vote, which is only safe because of where it is cast.
 *
 * Ivanti has two ways to approve and they are not equivalent. **"Approve My Vote"** on the
 * approval resolves "my" from the signed-in session — this server's service account — so it would
 * record the wrong person's decision, and on an admin key the override actions bypass the real
 * approver entirely. **"Approve Vote"** on the *vote row* acts on a row that already belongs to a
 * named approver, so the decision counts as theirs. This tool uses the second, and refuses any row
 * whose `Owner` is not the person the conversation is acting for. That check is what makes it safe.
 *
 * Without impersonation `VotedBy` records the service account, which is accurate rather than a flaw: the
 * approver decided, this server performed it — the same shape as a delegated approval.
 *
 * Measured: a raw field update on the vote row is **not** a vote. It stores the status, overwrites
 * `VotedBy` with the session account, and leaves the approval untouched — the workflow never runs.
 * Hence the quick action, and hence the read-back below.
 */

const VOTES = 'frs_approvalvotetrackings';
const VOTE_OBJECT = 'FRS_ApprovalVoteTracking#';

/** Ivanti's out-of-box names for the two verbs on a vote row. */
const ACTION_NAMES: Record<'approve' | 'deny', string> = {
  approve: 'Approve Vote',
  deny: 'Deny Vote',
};

export function createVoteOnApprovalTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'vote_on_approval',
    title: 'Approve or deny',
    description:
      'Casts the approval decision of the person this conversation is acting for.\n\n' +
      'ONLY ON THEIR OWN APPROVAL. The vote is cast on the row that belongs to them, so it counts ' +
      'as their decision — and a row belonging to anyone else is refused. Call `act_as` first, ' +
      'and `list_approvals` to see what is waiting.\n\n' +
      'GET AN EXPLICIT DECISION FROM THEM FIRST, in their own words, and say what they are ' +
      'approving. An approval is a control someone relies on; inferring it from "yeah go ahead" ' +
      'in a conversation about something else is not consent.\n\n' +
      'Ivanti records the vote as cast by this server on their behalf — their decision, this ' +
      'server\'s hands. The result reports what actually moved, because a vote that registers on ' +
      'the row does not always advance the approval behind it.',
    annotations: {
      title: 'Approve or deny',
      readOnlyHint: false,
      destructiveHint: true,
      // A second call re-runs the action; the decision is already recorded by then.
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      approvalId: z
        .string()
        .describe("The vote's RecId, from list_approvals — the row that belongs to this person."),
      decision: z.enum(['approve', 'deny']).describe('What they decided.'),
      reason: z
        .string()
        .optional()
        .describe('Their reason, in their words. Worth recording on a denial especially.'),
    },
    handler: (args, context) =>
      runTool('vote_on_approval', deps.logger, async () => {
        const connection = connectionFor(deps, context);
        const person = context.pin?.person();
        if (person?.loginId === undefined) {
          return errorResult(
            'I do not know whose decision this is. Call `act_as` with the person you are helping ' +
              'before casting a vote on their behalf.',
          );
        }

        const transport = connection.transport;
        const { session } = connection;
        const url = withQuery(
          transport.routes.entitySet(VOTES),
          buildQuery({ filter: `RecId eq ${quoteOdataString(args.approvalId)}`, top: 1 }),
        );
        const vote = readCollection<OdataRecord>(await transport.request<OdataRecord>(url), url)[0];

        if (vote === undefined) {
          return errorResult(`No approval with id ${args.approvalId}. Check list_approvals.`);
        }

        // The check the whole design rests on: this row is theirs, so the vote is theirs.
        const owner = typeof vote['Owner'] === 'string' ? vote['Owner'] : '';
        if (owner.toLowerCase() !== person.loginId.toLowerCase()) {
          return errorResult(
            `That approval is ${owner === '' ? "somebody else's" : `waiting on ${owner}`}, not on ` +
              `${person.displayName}. A vote can only be cast on one's own approval — otherwise ` +
              "it would be recorded as that person's decision without them making it.",
          );
        }

        if (vote['Status'] !== 'Pending') {
          return jsonResult({
            alreadyDecided: vote['Status'],
            note: 'This approval has already been voted on; nothing was changed.',
          });
        }

        // Action ids are per tenant, so the verb is found by name rather than assumed.
        const actions = await listQuickActions(session, VOTE_OBJECT);
        const wanted = ACTION_NAMES[args.decision].toLowerCase();
        const action = actions.find((entry) => entry.name.toLowerCase() === wanted);

        if (action === undefined) {
          return errorResult(
            `This tenant has no '${ACTION_NAMES[args.decision]}' action on an approval vote, so ` +
              'there is no way to cast the decision through its own workflow. Setting the status ' +
              'directly is not a vote — it records nothing and advances nothing. They will need ' +
              'to decide it in Ivanti.',
          );
        }

        if (args.reason !== undefined && args.reason !== '') {
          // Recorded before the vote: the action closes the row, and a reason written after it
          // would be an edit to a decided approval.
          await transport.request(transport.routes.record(VOTES, args.approvalId), {
            method: 'PATCH',
            body: { Reason: args.reason },
          });
        }

        // The form path with no form name: this object has no form for any role here, and the
        // grid path would run the action while claiming to probe. Measured: the form path runs
        // it correctly with an empty name, so nothing needs the grid path.
        const result = await executeAction({
          session,
          objectId: VOTE_OBJECT,
          recordId: args.approvalId,
          actionId: action.actionId,
          formName: '',
          shouldSave: true,
        });

        // Ivanti's `saved` flag is not evidence — a rejected action can report true over a record
        // that did not change. Read both rows instead.
        const after = readCollection<OdataRecord>(await transport.request<OdataRecord>(url), url)[0];
        const recorded = after?.['Status'];

        const approvalRecId = vote['ParentLink_RecID'];
        const approval =
          typeof approvalRecId === 'string'
            ? await transport
                .request<OdataRecord>(transport.routes.record('frs_approvals', approvalRecId))
                .catch(() => undefined)
            : undefined;

        if (recorded === 'Pending' || recorded === undefined) {
          return errorResult(
            `Ivanti reported the ${args.decision} as ${String(result.status ?? 'done')} but the ` +
              'approval is still pending, so the vote did not register. Nothing was decided — ' +
              'ask them to do it in Ivanti rather than trying again.',
          );
        }

        deps.logger.info('approval vote cast', { decision: args.decision });

        const approvalStatus = approval?.['Status'];
        return jsonResult({
          decision: recorded,
          votedFor: person.displayName,
          ...(args.reason === undefined ? {} : { reason: args.reason }),
          recordedBy: 'this server, on their behalf — their decision, its hands',
          approval: approvalStatus ?? null,
          ...(approvalStatus === 'Pending'
            ? {
                note:
                  'Their vote is recorded, but the approval behind it has not moved yet — it may ' +
                  'be waiting on other approvers, or on a workflow that runs separately. Do not ' +
                  'tell them the request is approved; tell them their vote is in.',
              }
            : {}),
        });
      }),
  });
}
