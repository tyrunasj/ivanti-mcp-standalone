// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { randomBytes } from 'node:crypto';
import { createSessionPin, type SessionPin } from '../../auth/identity-pin.js';
import type { Logger } from '../../logger.js';
import type { CallContext } from '../tool-definition.js';

export type EndReason = 'idle' | 'reinitialized';

/**
 * One conversation: its pin, the context handlers read, and when it is over.
 *
 * One pin per conversation, and a new conversation gets a new one: re-creating is the whole of
 * "this conversation is over", and it leaves the pin's own rules with no reset to be tricked into.
 * `bound()` is re-made with it so handlers read the current pin rather than a captured one.
 *
 * Two signals end one, neither within the model's reach — a tool that could end a conversation
 * could shed the pin, which is the one thing the pin exists to prevent: silence (`idleMs`, which is
 * `MCP_IDENTITY_IDLE_TTL_SECONDS`) and a fresh `initialize`.
 */
export interface Conversation {
  pin: () => SessionPin;
  bound: () => CallContext;
  /** Which conversation a running call belongs to; a call that outlives its own is discarded. */
  id: () => number;
  /** Whether it may be answered at all — false until `act_as` has pinned somebody. */
  mayAnswer: () => boolean;
  /** Records a call at `at`; true when the conversation had gone quiet and was ended by it. */
  touch: (at: number) => boolean;
  /** Everything it held is dropped before this returns; the promise is the Ivanti session given back. */
  end: (reason: EndReason) => Promise<void>;
  /** For state kept elsewhere that must not outlive the conversation. */
  onEnd: (listener: () => void) => void;
  /** Names this server's conversations apart from every other session's and process's. */
  instance: string;
  /** Read at each use: over HTTP the id exists only after `initialize`, which is after this runs. */
  session: () => { sessionId?: string };
}

export function createConversation(
  context: CallContext,
  logger: Logger,
  /** Whether this deployment registers `act_as`, and so requires an identity. */
  identityRequired: boolean,
  /** Omitted means a conversation never goes stale on its own — the shape every test wants. */
  idleMs?: number,
): Conversation {
  let pin = createSessionPin(context.identity);
  let bound: CallContext = { ...context, pin };
  let lastCallAt = Date.now();
  // Counting is cheaper than making forty-one handlers re-read a pin: a handler captures the pin
  // it was given, so one still running when its conversation ends holds a discarded object.
  let id = 0;
  const listeners: (() => void)[] = [];

  const session = (): { sessionId?: string } =>
    context.sessionId === undefined ? {} : { sessionId: context.sessionId };

  const end = (reason: EndReason): Promise<void> => {
    const held = pin.person() !== undefined;
    pin = createSessionPin(context.identity);
    bound = { ...context, pin };
    id += 1;
    for (const listener of listeners) listener();

    // The person is never named here: on an asserted pin it is a claim, and an audit line that
    // records a claim as a fact is worse than one that records nothing.
    if (held) logger.info('conversation ended; identity forgotten', { reason, ...session() });

    // Given back, not left to expire: the next person cannot open a session while this one holds
    // the slot. ALWAYS, not only when somebody was pinned — an `act_as` handshake still in flight
    // has pinned nobody yet, and returning early let it land in the next conversation's slot.
    return context.impersonation?.release() ?? Promise.resolve();
  };

  return {
    pin: () => pin,
    bound: () => bound,
    id: () => id,
    mayAnswer: () => !identityRequired || pin.person() !== undefined,
    touch: (at): boolean => {
      const quiet = idleMs !== undefined && at - lastCallAt >= idleMs;
      lastCallAt = at;
      if (quiet) {
        // Not awaited: what is left after the drop is RemoveSession, which ends nothing on
        // Ivanti's side (docs/notes.md) and made the first call after a quiet spell wait up to
        // its 15 s timeout for no benefit.
        end('idle').catch((error: unknown) => {
          logger.warn('giving back the ivanti session failed', {
            reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
          });
        });
      }
      return quiet;
    },
    end,
    onEnd: (listener): void => {
      listeners.push(listener);
    },
    instance: randomBytes(4).toString('hex'),
    session,
  };
}
