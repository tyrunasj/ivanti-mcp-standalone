// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { auditFields } from '../../auth/identity.js';
import { IdentityRequiredError } from '../../auth/identity-pin.js';
import type { Logger } from '../../logger.js';
import { noteOutcome } from '../../usage/call-usage.js';
import { errorResult } from '../shared/result.js';
import type { ToolDefinition } from '../tool-definition.js';
import type { Conversation } from './conversation.js';

/** The one tool that answers before anyone is pinned, because it is what does the pinning. */
export const ACT_AS = 'act_as';

/**
 * Whether this deployment requires an identity at all. `act_as` is the only tool that answers
 * before one is pinned — and a deployment that does not register it cannot require one. With no
 * tenant configured the only tool is `get_version`, and gating that would leave a server able to
 * answer nothing at all.
 */
export const requiresIdentity = (tools: readonly ToolDefinition[]): boolean =>
  tools.some((tool) => tool.name === ACT_AS);

export interface IdentityGate {
  /**
   * `undefined` lets the call through at once — synchronously, so an ordinary call reaches its
   * handler in the same turn it arrived. Otherwise a promise of the refusal to return instead of
   * running it, itself `undefined` when pinning from the token worked.
   *
   * The gate, at the one place every call passes through. Tool by tool it would be forgettable,
   * and a tool that forgot would not fail — it would answer, for nobody.
   */
  admit: (tool: ToolDefinition) => Promise<CallToolResult | undefined> | undefined;
}

export function createIdentityGate(
  tools: readonly ToolDefinition[],
  conversation: Conversation,
  logger: Logger,
): IdentityGate {
  const actAs = tools.find((tool) => tool.name === ACT_AS);
  // The one in-flight attempt to pin a signed-in conversation, shared by concurrent callers.
  let signingIn: Promise<CallToolResult> | undefined;
  conversation.onEnd(() => {
    signingIn = undefined;
  });

  /**
   * A **signed-in** conversation pins itself, on the first call that needs it.
   *
   * The token already names the person, so making the model call `act_as` to repeat what the
   * issuer said is a round trip that can only go wrong. It runs here rather than at `initialize`
   * for two reasons: pinning does real work against Ivanti — a directory lookup, and an
   * impersonation handshake where that is configured — so a slow or unreachable tenant would fail
   * the *connection* rather than a call; and a token that matched only on a name has to ask for
   * confirmation, which needs somewhere to ask.
   *
   * `act_as`'s own handler does it, never a second copy: the rules about what a token may match,
   * what it must confirm, and what it refuses are subtle enough that two implementations would
   * differ, and the weaker one would be this one. An asserted session is untouched — there is
   * nothing to pin from but a claim, and a claim has to be made deliberately.
   *
   * Returns what `act_as` said when it did not pin, so the caller reports that rather than a
   * generic refusal; `undefined` means it was not attempted or it worked.
   */
  const pinFromToken = async (): Promise<CallToolResult | undefined> => {
    if (actAs === undefined || conversation.pin().identity().provenance !== 'verified') return undefined;

    // One attempt per conversation, shared by concurrent callers — the same shape the Ivanti
    // session handshake has, and for the same reason: a cold conversation that fired two calls
    // would otherwise run two lookups, and the loser would be refused for losing.
    if (signingIn === undefined) {
      logger.info('resolving the signed-in identity without being asked', {
        ...conversation.session(),
        ...auditFields(conversation.pin().identity()),
      });
      signingIn = Promise.resolve(actAs.handler({}, conversation.bound()));
    }

    const attempt = signingIn;
    const answer = await attempt;
    if (conversation.mayAnswer()) return undefined;

    // A question — which of these records is yours — stands until it is answered, so it is kept and
    // asked again. A refusal is not kept: it was a directory lookup that failed, a timeout, a
    // handshake Ivanti refused, and caching it replayed one bad second for the rest of the
    // conversation. Only the attempt this caller shared is forgotten, never a newer one.
    const failed = answer.isError === true;
    if (failed && signingIn === attempt) signingIn = undefined;

    // It could not pin: the token names nobody in Ivanti, or matched a record that has to be
    // confirmed first. Its explanation is the useful one, but the call the caller actually made
    // did not happen — so it is marked as the failure it is, and said to be about identity rather
    // than about what they asked for.
    return {
      ...answer,
      isError: true,
      content: [
        {
          type: 'text' as const,
          text:
            'Before answering that, this conversation had to work out who you are from the ' +
            'signed-in token, and could not:',
        },
        ...answer.content,
        ...(failed
          ? [
              {
                type: 'text' as const,
                text: 'That was not remembered: calling `act_as` tries again, and so does the next call.',
              },
            ]
          : []),
      ],
    };
  };

  const refuse = async (tool: ToolDefinition): Promise<CallToolResult | undefined> => {
    const unresolved = await pinFromToken();
    if (conversation.mayAnswer()) return undefined;

    logger.info('tool refused on identity', { tool: tool.name, reason: 'IdentityRequiredError' });
    noteOutcome('IdentityRequiredError');
    return unresolved ?? errorResult(new IdentityRequiredError().message);
  };

  return {
    admit: (tool): Promise<CallToolResult | undefined> | undefined => {
      if (tool.name === ACT_AS || conversation.mayAnswer()) return undefined;
      return refuse(tool);
    },
  };
}
