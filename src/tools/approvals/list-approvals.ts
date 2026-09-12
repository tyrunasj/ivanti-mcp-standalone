import { z } from 'zod';
import { buildQuery, MAX_TOP, quoteOdataString, readTotal, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import { toEntitySet } from '../../ivanti/metadata/entity-names.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { resolveSubject } from '../shared/own-records.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

/**
 * Whose approvals are waiting.
 *
 * An approval step (`frs_approval`) holds no approver; the people are on its vote-tracking rows
 * (`frs_approvalvotetracking`), where `Owner` is the approver's login and `PrimaryParentObject`
 * and `PrimaryParentID` say what is waiting. So "what needs my approval" is a filter on that
 * object, and `act_as` supplies the login.
 *
 * Casting one lives in `vote_on_approval`, which explains why the row — rather than the
 * approval — is the only safe place to do it.
 */

const VOTES = 'frs_approvalvotetrackings';

export function createListApprovalsTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'list_approvals',
    title: 'List approvals',
    description:
      "ONE PERSON'S approval queue — the service requests, changes and knowledge articles " +
      'waiting on them specifically.\n\n' +
      'To act on one, use vote_on_approval — it casts the decision on the row that belongs to ' +
      'them, which is what makes it theirs. Get an explicit decision from them first.\n\n' +
      'Defaults to whoever this conversation is acting for; call `act_as` first.\n\n' +
      'NOT FOR TENANT-WIDE QUESTIONS. "How many changes are waiting for approval" is a count of ' +
      "PARENT records by status — count_records on change with \"Status eq 'Pending Approval'\" " +
      '— not a query of this. An approval row exists only where one was actually routed to a ' +
      'named person, so a change can sit in Pending Approval with no approval record at all: ' +
      'measured on this tenant, two changes pending against zero approval rows. Counting the ' +
      'approval object for that question answers zero and is wrong.',
    annotations: {
      title: 'List approvals',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      person: z
        .string()
        .optional()
        .describe("The approver's login id. Defaults to whoever this conversation is acting for."),
      includeDecided: z
        .boolean()
        .optional()
        .describe('Include approvals already voted on. Default false — only what is still pending.'),
      top: z.number().int().min(1).max(MAX_TOP).optional().describe('Rows to return. Default 25.'),
    },
    handler: (args, context) =>
      runTool('list_approvals', deps.logger, async () => {
        const pinned = context.pin?.person();
        // Refuses in `enduser` both when nobody is pinned and when the name is somebody else's.
        const login = resolveSubject(deps, context, args.person, (person) => person.loginId);

        if (login === undefined) {
          return errorResult(
            'Whose approvals? Call `act_as` with the person you are helping, and I will use ' +
              'them.',
          );
        }

        const conditions = [`Owner eq ${quoteOdataString(login)}`];
        if (args.includeDecided !== true) conditions.push("Status eq 'Pending'");

        const url = withQuery(
          deps.connection.transport.routes.entitySet(VOTES),
          buildQuery({
            filter: conditions.join(' and '),
            orderBy: 'DueDateTime asc',
            top: args.top ?? 25,
            count: true,
          }),
        );

        const payload = await deps.connection.transport.request<OdataRecord>(url);
        const rows = readCollection<OdataRecord>(payload, url);
        const total = readTotal(payload, rows.length);

        /**
         * What is actually being approved.
         *
         * The approval row names only an object and a number, and an approver is NOT the
         * requester — so in `enduser` every route onward is closed to them by the own-records
         * gate, and the tool told a model to "say what they are approving" while making that
         * impossible. Two independent testers hit this as their worst finding. The subject sits
         * one read away and the credential can reach it, so it is read HERE, with the approver's
         * authority, rather than left to a caller who is not allowed to ask.
         */
        const subjectOf = async (row: OdataRecord): Promise<Record<string, unknown>> => {
          const object = row['PrimaryParentObject'];
          const recId = row['PrimaryParentRecId'];
          if (typeof object !== 'string' || object === '' || typeof recId !== 'string') return {};

          const entity = await deps.connection.metadata.entity(object).catch(() => undefined);
          if (entity === undefined) return {};

          const record = await deps.connection.transport
            .request<OdataRecord>(
              deps.connection.transport.routes.record(toEntitySet(`${entity.name}#`), recId),
            )
            .catch(() => undefined);
          if (record === undefined) return {};

          const text = (field: string): string | undefined => {
            const value = record[field];
            return typeof value === 'string' && value !== '' ? value : undefined;
          };

          return {
            ...(text('Subject') === undefined ? {} : { subject: text('Subject') }),
            ...(text('ProfileFullName') === undefined
              ? {}
              : { requestedBy: text('ProfileFullName') }),
            ...(text('Status') === undefined ? {} : { recordStatus: text('Status') }),
          };
        };

        const subjects = await Promise.all(rows.map(subjectOf));

        const approvals = rows.map((row, index) => ({
          ...subjects[index],
          // The id `vote_on_approval` takes. A tool needs it; a sentence to the person does not —
          // tell them what is waiting, not the hex string it is filed under.
          approvalId: row['RecId'] ?? null,
          waitingOn: row['PrimaryParentObject'] ?? null,
          reference: row['PrimaryParentID'] ?? null,
          // NOT `status`: a field by that name beside a request reference reads as "the request
          // is approved", which it is not — the vote is one step, the approval another.
          yourVote: row['Status'] ?? null,
          // The vote row's own date, which is NOT the approval's: measured on a live tenant the
          // two differed by three years, so reporting this one unlabelled turned a 16-month
          // overdue approval into "due in 2028".
          voteDue: row['DueDateTime'] ?? null,
          ...(row['Reason'] === null || row['Reason'] === undefined ? {} : { reason: row['Reason'] }),
          ...(row['VotedDateTime'] === null || row['VotedDateTime'] === undefined
            ? {}
            : { votedAt: row['VotedDateTime'] }),
        }));

        return jsonResult({
          approver: pinned?.displayName ?? login,
          returned: approvals.length,
          ...(total === undefined ? {} : { total: total.total, totalIsExact: total.exact }),
          voting:
            'vote_on_approval casts their decision, on their own approvals only. Ask them ' +
            'explicitly first — an approval is a control somebody relies on.',
          // The write response says this; a later "did that go through?" reaches only this tool,
          // and a tester would have overclaimed from it had they not still held the write.
          reading:
            '`yourVote` is THEIR vote, not the state of the thing being approved. A vote of ' +
            'Approved does not mean the request is approved — it may still be waiting on other ' +
            'approvers or on a workflow. Say their vote is in, not that it is approved.',
          approvals,
        });
      }),
  });
}
