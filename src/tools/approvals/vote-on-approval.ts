// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import {
  executeAction,
  listQuickActions,
  type ActionResult,
} from '../../ivanti/quick-actions/execute.js';
import { buildQuery, quoteOdataString, withQuery } from '../../ivanti/odata/query.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import { comparable } from '../../ivanti/write/compare-stored.js';
import { readRows } from '../shared/read-rows.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';
import { connectionFor } from '../shared/connection-for.js';
import { voteOwnership } from './vote-owner.js';

/**
 * Which decision a stored vote status reads as.
 *
 * The vocabulary is the tenant's own (see `ivanti://reference/workflow`), so this matches a stem
 * rather than a word, and a status it cannot place is reported as it reads rather than guessed.
 * The refusing stems are tried first: "Not Approved" contains "approv".
 */
function decisionOf(status: string): 'approve' | 'deny' | undefined {
  if (/den(y|ied)|reject|declin|disapprov|not approv|unapprov/i.test(status)) return 'deny';
  if (/approv/i.test(status)) return 'approve';
  return undefined;
}

/**
 * Casting a vote, which is only safe because of where it is cast.
 *
 * Ivanti has two ways to approve and they are not equivalent. **"Approve My Vote"** on the
 * approval resolves "my" from the signed-in session — this server's service account — so it would
 * record the wrong person's decision, and on an admin key the override actions bypass the real
 * approver entirely. **"Approve Vote"** on the *vote row* acts on a row that already belongs to a
 * named approver, so the decision counts as theirs. This tool uses the second, and refuses any row
 * that is not the person the conversation is acting for — by `Owner_Valid` where the row has one,
 * never by a name two people can share (`vote-owner.ts`). That check is what makes it safe.
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
        const vote = readRows<OdataRecord>(await transport.request<OdataRecord>(url), url)[0];

        if (vote === undefined) {
          return errorResult(`No approval with id ${args.approvalId}. Check list_approvals.`);
        }

        // The check the whole design rests on: this row is theirs, so the vote is theirs. The rule
        // is `voteOwnership`'s, shared with `list_approvals` so the listing never offers a row
        // this refuses — and `Owner_Valid`, where the row has one, decides alone.
        //
        // Still fail-closed: nothing but the pinned person's own identifiers can match.
        const owner = typeof vote['Owner'] === 'string' ? vote['Owner'] : '';
        const ownership = voteOwnership(person, vote);

        if (ownership !== 'theirs') {
          const held = [person.loginId, person.primaryEmail].filter((id) => id !== undefined);
          const who = `${person.displayName}${held.length === 0 ? '' : ` (${held.join(', ')})`}`;
          return errorResult(
            (ownership === 'namesake'
              ? `That approval is waiting on ${owner} — but on a different employee record from ` +
                `${who}'s: someone who shares that name. `
              : `That approval is ${owner === '' ? 'not owned by anyone this server can read' : `waiting on ${owner}`}, ` +
                `which is not ${who}. `) +
              "A vote can only be cast on one's own approval — otherwise it would be recorded as " +
              "that person's decision without them making it.",
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

        const row = transport.routes.record(VOTES, args.approvalId);
        const readVote = async (): Promise<OdataRecord | undefined> =>
          readRows<OdataRecord>(await transport.request<OdataRecord>(url), url)[0];

        const priorReason = vote['Reason'] ?? null;
        const writingReason = args.reason !== undefined && args.reason !== '';
        if (writingReason) {
          // Recorded before the vote: the action closes the row, and a reason written after it
          // would be an edit to a decided approval.
          await transport.request(row, { method: 'PATCH', body: { Reason: args.reason } });
        }

        /**
         * Takes the reason off again when the vote did not happen.
         *
         * Written first for the reason above, it outlived every failed vote: the row stayed
         * Pending with their words on it, readable by anyone as the grounds for a decision nobody
         * made. Put back to what the row held, and read back rather than trusted — this whole tool
         * exists because a 200 is not evidence. Undefined when nothing is left behind; otherwise
         * the sentence that says what was.
         */
        const takeBackReason = async (): Promise<string | undefined> => {
          if (!writingReason) return undefined;
          const now = await transport
            .request(row, { method: 'PATCH', body: { Reason: priorReason } })
            .then(readVote)
            .catch(() => undefined);
          if (now !== undefined && comparable(now['Reason']) === comparable(priorReason)) return undefined;
          return (
            `The reason they gave was written to the row before the vote and could NOT be taken ` +
            `off again, so it is still there — "${args.reason ?? ''}" — on an approval that is ` +
            'undecided. Tell them, so nobody reads it as the grounds for a decision.'
          );
        };

        // The form path with no form name: this object has no form for any role here, and the
        // grid path would run the action while claiming to probe. Measured: the form path runs
        // it correctly with an empty name, so nothing needs the grid path.
        let result: ActionResult;
        try {
          result = await executeAction({
            session,
            objectId: VOTE_OBJECT,
            recordId: args.approvalId,
            actionId: action.actionId,
            formName: '',
            shouldSave: true,
          });
        } catch (error: unknown) {
          const left = await takeBackReason();
          // Nothing left behind: the row is as it was, and `runTool` explains the failure better.
          if (left === undefined) throw error;
          deps.logger.warn('approval vote failed; its reason is left on the row', {});
          return errorResult(
            `The ${args.decision} could not be cast (${error instanceof Error ? error.message : 'unknown error'}), ` +
              `so nothing was decided. ${left}`,
          );
        }

        // Ivanti's `saved` flag is not evidence — a rejected action can report true over a record
        // that did not change. Read both rows instead.
        let after: OdataRecord | undefined;
        try {
          after = await readVote();
        } catch {
          // The action ran and may well have registered. Reporting a failure here invites a second
          // vote; reporting success would be a claim nothing supports.
          return errorResult(
            `The ${args.decision} was sent, but the vote could not be read back, so whether it ` +
              'registered is unknown. Do NOT cast it again: list_approvals with includeDecided ' +
              'shows whether it did.',
          );
        }
        const recorded = typeof after?.['Status'] === 'string' ? after['Status'] : undefined;

        if (recorded === 'Pending' || recorded === undefined) {
          const left = await takeBackReason();
          return errorResult(
            `Ivanti reported the ${args.decision} as ${String(result.status ?? 'done')} but the ` +
              'approval is still pending, so the vote did not register. Nothing was decided — ' +
              `ask them to do it in Ivanti rather than trying again.${left === undefined ? '' : ` ${left}`}`,
          );
        }

        // Moved is not the same as moved the RIGHT way: "no longer Pending" was all this checked.
        const readAs = decisionOf(recorded);
        if (readAs !== undefined && readAs !== args.decision) {
          deps.logger.error('approval vote recorded the opposite decision', { decision: args.decision });
          return errorResult(
            `They decided to ${args.decision}, but the vote row now reads '${recorded}' — the ` +
              'OPPOSITE. It is no longer pending, so it cannot be voted again here. Tell them ' +
              'exactly that, and have it corrected in Ivanti.',
          );
        }

        deps.logger.info('approval vote cast', { decision: args.decision });

        const approvalRecId = vote['ParentLink_RecID'];
        const approval =
          typeof approvalRecId === 'string' && approvalRecId !== ''
            ? await transport
                .request<OdataRecord>(transport.routes.record('frs_approvals', approvalRecId))
                .catch(() => undefined)
            : undefined;
        const approvalStatus = approval?.['Status'];

        return jsonResult({
          decision: recorded,
          votedFor: person.displayName,
          ...(args.reason === undefined ? {} : { reason: args.reason }),
          recordedBy: 'this server, on their behalf — their decision, its hands',
          approval: approvalStatus ?? null,
          ...(readAs === undefined
            ? {
                decisionNote:
                  `The vote row now reads '${recorded}', which this server cannot place as an ` +
                  'approval or a denial on this tenant. Tell them it reads that — not that it was ' +
                  'approved or denied.',
              }
            : {}),
          ...(approvalStatus === 'Pending'
            ? {
                note:
                  'Their vote is recorded, but the approval behind it has not moved yet — it may ' +
                  'be waiting on other approvers, or on a workflow that runs separately. Do not ' +
                  'tell them the request is approved; tell them their vote is in.',
              }
            : approvalStatus === undefined || approvalStatus === null
              ? {
                  // A null here used to mean anything: no parent, a failed read, an empty body.
                  note:
                    (typeof approvalRecId === 'string' && approvalRecId !== ''
                      ? 'The approval this vote belongs to could not be read back'
                      : 'This vote row names no approval it belongs to') +
                    ', so whether the request itself has moved is unknown. Tell them their vote ' +
                    'is in — not that the request is approved.',
                }
              : {}),
        });
      }),
  });
}
