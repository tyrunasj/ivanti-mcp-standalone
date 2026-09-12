import { z } from 'zod';
import { parseFieldList, projectRows } from '../../ivanti/odata/projection.js';
import { buildQuery, quoteOdataString, readTotal, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

/**
 * The objects that carry assignable work, and what "done" means on each.
 *
 * The terminal statuses are a **stated assumption**, not something Ivanti will tell us.
 * `IsInFinalState` looks like the field for this and is a trap: a closed record stores it as
 * false, and filtering on it returns zero rows for both values. So the exclusion is spelled out
 * here, reported back in the response, and can be turned off.
 */
const WORK_OBJECTS = [
  { object: 'incidents', identifier: 'IncidentNumber', closed: ['Closed', 'Resolved'] },
  { object: 'tasks', identifier: 'AssignmentID', closed: ['Completed', 'Cancelled', 'Rejected'] },
  {
    object: 'servicereqs',
    identifier: 'ServiceReqNumber',
    closed: ['Closed', 'Fulfilled', 'Cancelled', 'Approval Rejected'],
  },
  {
    object: 'changes',
    identifier: 'ChangeNumber',
    closed: ['Closed', 'Cancelled', 'Denied', 'Rejected', 'Completed'],
  },
  { object: 'problems', identifier: 'ProblemNumber', closed: ['Closed', 'Cancelled', 'Resolved'] },
] as const;

/** Tried in order: Ivanti stores the assignee as a login id, so that is the reliable match. */
const PERSON_FIELDS = [
  { field: 'LoginID', matchedOn: 'loginId' },
  { field: 'PrimaryEmail', matchedOn: 'email' },
  { field: 'DisplayName', matchedOn: 'displayName' },
] as const;

interface Person {
  loginId: string;
  matchedOn: string;
  displayName?: string;
  email?: string;
}

export function createListAssignedWorkTool(deps: IvantiToolDeps): ToolDefinition {
  const { transport } = deps.connection;

  const findPerson = async (person: string): Promise<Person | undefined> => {
    for (const attempt of PERSON_FIELDS) {
      const url = withQuery(
        transport.routes.entitySet('employees'),
        buildQuery({ filter: `${attempt.field} eq ${quoteOdataString(person)}`, top: 2 }),
      );
      const rows = readCollection<OdataRecord>(await transport.request<OdataRecord>(url), url);
      const loginId = rows[0]?.['LoginID'];
      if (typeof loginId !== 'string' || loginId === '') continue;

      const displayName = rows[0]?.['DisplayName'];
      const email = rows[0]?.['PrimaryEmail'];
      return {
        loginId,
        matchedOn: attempt.matchedOn,
        ...(typeof displayName === 'string' ? { displayName } : {}),
        ...(typeof email === 'string' ? { email } : {}),
      };
    }
    return undefined;
  };

  return defineTool({
    name: 'list_assigned_work',
    title: 'List assigned work',
    description:
      "Everything assigned to ONE person across incidents, tasks, service requests, changes and " +
      'problems — the "what is on my plate" question in a single call rather than five.\n\n' +
      'YOU MUST NAME THE PERSON. This server signs in with a tenant API key, so its identity is ' +
      'a service account, not whoever is asking. There is no "me" it can resolve: if the user ' +
      'says "my open tickets" and you do not know their Ivanti login, ask.\n\n' +
      'A login id matches best — Ivanti stores the assignee as `JSmith`, not `Jane Smith`. An ' +
      'email or a display name is tried after it. The response says who was matched and on ' +
      'which field; check it before reporting, because a display name can be the wrong Jane.\n\n' +
      'CLOSED WORK IS EXCLUDED BY DEFAULT, and which statuses count as closed is this server\'s ' +
      'assumption rather than a fact Ivanti exposes. Each group reports the exact filter used.\n\n' +
      'An object the API key cannot read reports an error on its own group instead of sinking ' +
      'the whole answer, so a partial result is visibly partial.',
    annotations: {
      title: 'List assigned work',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      person: z
        .string()
        .optional()
        .describe(
          'Login id (best), email address, or display name of the assignee. Defaults to whoever ' +
            'this conversation is acting for, if `act_as` has been called.',
        ),
      includeClosed: z
        .boolean()
        .optional()
        .describe('Include records in a terminal status. Default false.'),
      top: z
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .describe('Rows per object, default 5. Totals are reported regardless.'),
      fields: z.string().optional().describe('Comma-separated fields to return per row.'),
    },
    handler: (args, context) =>
      runTool('list_assigned_work', deps.logger, async () => {
        const pinned = context.pin?.person();
        // Whoever the conversation is acting for, unless the caller named someone. A named
        // person is legitimate here — an analyst looking at a colleague's queue is the job — so
        // this defaults rather than restricts. `enduser` does not register this tool at all.
        const asked = args.person ?? pinned?.loginId ?? pinned?.displayName;

        if (asked === undefined) {
          return errorResult(
            'Whose work? Name the person — their login id is the reliable one — or call ' +
              '`act_as` first and I will use them.',
          );
        }

        const person = await findPerson(asked);
        if (person === undefined) {
          return jsonResult({
            person: null,
            message:
              `No employee matches '${asked}' by login id, email address or display name. ` +
              'Ivanti stores assignees as login ids; ask the user for theirs rather than guessing.',
          });
        }

        const top = args.top ?? 5;
        const fields = parseFieldList(args.fields);

        const groups = await Promise.all(
          WORK_OBJECTS.filter((work) => deps.gate.allows(work.object)).map(async (work) => {
            const conditions = [`Owner eq ${quoteOdataString(person.loginId)}`];
            if (args.includeClosed !== true) {
              for (const status of work.closed) {
                conditions.push(`Status ne ${quoteOdataString(status)}`);
              }
            }
            const filter = conditions.join(' and ');

            try {
              const url = withQuery(
                transport.routes.entitySet(work.object),
                buildQuery({ filter, top, count: true }),
              );
              const payload = await transport.request<OdataRecord>(url);
              const rows = readCollection<OdataRecord>(payload, url);
              const total = readTotal(payload, rows.length);

              return {
                object: work.object,
                filter,
                returned: rows.length,
                ...(total === undefined
                  ? {}
                  : { total: total.total, totalIsExact: total.exact }),
                rows: projectRows(
                  rows,
                  fields ?? ['RecId', work.identifier, 'Subject', 'Status', 'OwnerTeam'],
                ),
              };
            } catch (error: unknown) {
              // One refused object must not hide the other four.
              return {
                object: work.object,
                filter,
                error: error instanceof Error ? error.message : 'failed',
              };
            }
          }),
        );

        return jsonResult({ person, closedExcluded: args.includeClosed !== true, groups });
      }),
  });
}
