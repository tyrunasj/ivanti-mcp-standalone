// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ImpersonationSlot } from '../../auth/impersonation.js';
import type { PinnedPerson } from '../../auth/identity-pin.js';
import type { ImpersonatedSession } from '../../ivanti/session/impersonated-session.js';
import type { Logger } from '../../logger.js';
import { noteOutcome, type CallUsage } from '../../usage/call-usage.js';
import { errorResult } from '../shared/result.js';
import type { CallContext, ToolDefinition } from '../tool-definition.js';
import { ACT_AS } from './identity-gate.js';
import type { Conversation } from './conversation.js';

export type RunHandler = (
  tool: ToolDefinition,
  args: Record<string, unknown>,
  call: CallContext,
  usage: CallUsage,
  startedIn: number,
) => Promise<CallToolResult>;

/**
 * Runs a handler on the person's own Ivanti session where the conversation holds one, keeping that
 * session alive and retrying a read once when Ivanti refuses it partway.
 */
export function createSessionKeeper(conversation: Conversation, logger: Logger): RunHandler {
  /**
   * Makes sure the person's Ivanti session is one Ivanti will still honour, opening a new one for
   * the same login when it is not. On the ordinary call this is no work at all: the slot hands back
   * the session it holds unless that one is known dead or past its expiry.
   *
   * Returns the refusal when no session can be had. Never falls back to the service account — a
   * caller who asked to act as someone and was quietly answered as this server's own account has
   * been told something false about whose data they are reading.
   */
  const keepSession = async (
    tool: ToolDefinition,
    slot: ImpersonationSlot,
    person: PinnedPerson,
  ): Promise<{ live: ImpersonatedSession } | { refused: CallToolResult }> => {
    try {
      // `act_as` refuses to pin anyone without a login where it opens sessions, so this is a
      // backstop rather than a case.
      if (person.loginId === undefined) throw new Error('They have no Ivanti login to sign in as.');
      return { live: await slot.open(person.loginId) };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'The reason is unknown.';
      logger.warn('the person\'s ivanti session could not be re-opened', {
        tool: tool.name,
        ...conversation.session(),
        reason: reason.slice(0, 200),
      });
      noteOutcome('SessionUnavailable');
      return {
        refused: errorResult(
          `This conversation acts as ${person.displayName} in Ivanti, and the session it held for ` +
            'them has ended. Opening a new one failed, so nothing was sent — this server does not ' +
            `answer as its own account instead. ${reason} The next call tries again.`,
        ),
      };
    }
  };

  /**
   * The slot as one call sees it: always the session the call started on.
   *
   * The conversation's slot empties when the conversation ends, and an empty slot means "use the
   * service account" to everything that routes a request. A call still running at that moment —
   * a re-initialize, an idle expiry noticed by another call — would have sent the rest of its
   * requests, writes included, as this server's own account. Its result is discarded afterwards,
   * but a write is not undone by discarding what it answered.
   */
  const pinnedTo = (slot: ImpersonationSlot, held: ImpersonatedSession): ImpersonationSlot => ({
    session: () => held,
    open: (login) => slot.open(login),
    discard: (dead): void => {
      slot.discard(dead);
    },
    release: () => slot.release(),
  });

  /**
   * Runs the handler, on the person's own Ivanti session where the conversation holds one — and
   * when Ivanti refuses that session partway, re-opens it once for the same login and retries.
   *
   * A session dies without saying so: it lapses, the tenant evicts it, the tenant restarts. Before
   * this, the cached one was handed back regardless and every later call — `act_as` for the same
   * person included — answered 401 until the conversation ended.
   *
   * The retry is automatic only for a read-only tool. A write refused partway may already have
   * done part of its work — a create that stored the record and then failed to read it back — and
   * repeating it would do that part twice, so it is reported instead.
   */
  const run = async (
    tool: ToolDefinition,
    args: Record<string, unknown>,
    call: CallContext,
    usage: CallUsage,
    startedIn: number,
  ): Promise<CallToolResult> => {
    const slot = call.impersonation;
    // `act_as` opens the session itself; everything else runs on the one it opened.
    const person = tool.name === ACT_AS ? undefined : call.pin?.person();
    if (slot === undefined || person === undefined) return tool.handler(args, call);

    const kept = await keepSession(tool, slot, person);
    if ('refused' in kept) return kept.refused;

    // Judged on this handler's outcome alone, not on anything noted earlier in the call.
    const noted = usage.outcome;
    usage.outcome = undefined;
    usage.personRefused = undefined;
    const result = await tool.handler(args, { ...call, impersonation: pinnedTo(slot, kept.live) });
    // A 401 on the PERSON'S session is Ivanti refusing that credential, not the request. One on
    // the service account's own calls — schema, directory, the tenant's offset — is not about the
    // person's session, which is kept. Anything else is the call's answer.
    const refused = usage.personRefused === true;
    usage.outcome ??= noted;
    if (!refused || conversation.id() !== startedIn) return result;

    // Named, so a refusal that arrives after another call already replaced it discards nothing.
    slot.discard(kept.live);
    logger.info('ivanti refused the person\'s session; opening a new one', {
      tool: tool.name,
      ...conversation.session(),
    });
    const renewed = await keepSession(tool, slot, person);
    if ('refused' in renewed) return renewed.refused;

    if (tool.config.annotations.readOnlyHint !== true) {
      noteOutcome('SessionRenewed');
      return errorResult(
        `Ivanti refused that call as unauthenticated (401): the session this conversation held as ` +
          `${person.displayName} had most likely ended. A new one is open now, but the call was not ` +
          'repeated — it changes records, and part of it may have gone through before the ' +
          'refusal. Check the record, then call it again if it is still needed.',
      );
    }

    // Once. A second refusal on a session opened a moment ago is reported as it is.
    usage.outcome = undefined;
    usage.personRefused = undefined;
    return tool.handler(args, { ...call, impersonation: pinnedTo(slot, renewed.live) });
  };

  return run;
}
