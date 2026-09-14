// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import type { IvantiToolDeps } from '../shared/deps.js';
import { errorResult, jsonResult } from '../shared/result.js';
import { runTool } from '../shared/run-tool.js';
import { defineTool, type ToolDefinition } from '../tool-definition.js';

/**
 * Changes which of the person's Ivanti roles this conversation works under.
 *
 * **`full` mode only.** `enduser` opens the self-service role `ENDUSER_ROLE` names and offers no
 * way out of it — a tool that could change the role would undo the only thing that makes that
 * mode end-user. `selectTools` decides that at registration, so there it does not exist at all.
 *
 * **The role argument is required, and there is no listing mode.** A tool that listed when called
 * bare and mutated when given an argument would have to carry the worse annotation, so merely
 * looking at the roles would read as a state change. The roles are reported in the responses of
 * `act_as` and of this tool instead, which costs nothing and arrives when it is relevant.
 *
 * Bounded by Ivanti's own grant: `SelectRole` accepts only a role the person actually holds, so
 * this cannot reach anything they could not reach by signing in themselves.
 */
export function switchRoleTool(deps: IvantiToolDeps): ToolDefinition {
  return defineTool({
    name: 'switch_role',
    title: 'Switch Ivanti role',
    description:
      'Changes which of this person\'s Ivanti roles the conversation works under. Their access ' +
      'follows the role, so a different role can see different records.\n\n' +
      'Only a role they already hold is accepted — this cannot grant anything. act_as reports ' +
      'which roles those are; call it first.',
    annotations: {
      title: 'Switch Ivanti role',
      // It changes session state, so not read-only — but it destroys nothing and the same call
      // twice lands in the same place.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      role: z
        .string()
        .min(1)
        .describe('The role id, as act_as listed it — e.g. `ServiceDeskAnalyst`, not its label.'),
    },
    handler: (args, context) =>
      runTool('switch_role', deps.logger, async () => {
        const session = context.impersonation?.session();
        if (session === undefined) {
          // Nothing to re-role. Two different causes, and the caller can act on the difference.
          return errorResult(
            context.impersonation === undefined
              ? 'This deployment does not open Ivanti sessions for people, so there is no role ' +
                  'to switch. Every call uses the service account.'
              : 'Nobody is being acted for yet. Call act_as first — the role belongs to their ' +
                  'session, not to this conversation.',
          );
        }

        const wanted = args.role.trim();
        const held = session.roles.find(
          (role) => role.name.toLowerCase() === wanted.toLowerCase(),
        );
        if (held === undefined) {
          // Named, not merely refused: a caller told only "no" retries with a synonym.
          return errorResult(
            `${session.loginId} does not hold the role '${wanted}'. They hold: ` +
              `${session.roles.map((role) => role.name).join(', ')}.`,
          );
        }

        const before = session.role;
        const now = await session.switchTo(held.name);

        deps.logger.info('ivanti role switched', { login: session.loginId, from: before, to: now });

        return jsonResult({
          role: now,
          // Read back rather than assumed: a requested role is a request, and Ivanti answers with
          // what it actually gave.
          ...(now.toLowerCase() === held.name.toLowerCase()
            ? {}
            : { note: `Ivanti applied ${now} rather than ${held.name}.` }),
          previousRole: before,
          otherRoles: session.roles.map((role) => role.name).filter((name) => name !== now),
          effect: 'What records are visible follows this role, from the next call onwards.',
        });
      }),
  });
}
