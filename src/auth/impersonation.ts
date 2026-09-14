// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { ImpersonatedSession } from '../ivanti/session/impersonated-session.js';

/**
 * The one Ivanti session a conversation may hold on someone's behalf.
 *
 * A sibling of `identity-pin.ts`, with the same lifetime and for the same reason: a server is
 * created per connection, so this object's lifetime *is* the conversation's, and a per-connection
 * object cannot leak into another the way a map keyed by session id can.
 *
 * The two answer different questions and are deliberately not merged. The pin decides **who** this
 * conversation is helping — a decision this server makes and enforces. This holds Ivanti's answer
 * to **what they may see**, which only exists when impersonation is configured and reachable. Most
 * deployments have a pin and no session here, and that is the ordinary, fully supported shape.
 */
export interface ImpersonationSlot {
  /** The session, once `act_as` has opened one. */
  session: () => ImpersonatedSession | undefined;
  /**
   * Opens a session for this login, or hands back the one already open.
   *
   * Repeating the same login is a no-op, matching the pin — a model that calls `act_as` twice with
   * the same person should not pay for a second handshake, or worse, strand the first session.
   *
   * @throws when a *different* login is requested. The pin refuses that first, so reaching this is
   * a bug rather than a user error; refusing here keeps the two from disagreeing about who this
   * conversation is for.
   */
  open: (login: string) => Promise<ImpersonatedSession>;
  /** Releases and clears. Safe to call when nothing is open, and never throws. */
  release: () => Promise<void>;
}

export type SessionOpener = (login: string) => Promise<ImpersonatedSession>;

export function createImpersonationSlot(open: SessionOpener): ImpersonationSlot {
  let current: ImpersonatedSession | undefined;
  let openedFor: string | undefined;
  // Concurrent first calls share one handshake, the way the service-account session does: a cold
  // conversation that fired two tool calls would otherwise open two Ivanti sessions and leak one.
  let pending: Promise<ImpersonatedSession> | undefined;

  return {
    session: () => current,

    async open(login): Promise<ImpersonatedSession> {
      // The login is claimed when the handshake STARTS, not when it finishes.
      //
      // Both of these used to sit behind `current !== undefined`, which is only assigned after a
      // handshake resolves — so while the first was in flight the guard could not fire, and
      // `pending ??= open(login)` joined a second caller to it without comparing the login. The
      // joiner was handed the first person's session, and line below then recorded THEIR login as
      // the owner of a handshake that was never run for them. No data crossed — the pin commits
      // in registration order and refuses the loser — but the slot was left labelled with the
      // refused person, and a later `act_as` for the one who IS pinned was then refused by the
      // slot, naming somebody else. In `enduser` mode, where a model is told to retry `act_as`
      // whenever a record tool refuses, that is a stuck conversation.
      const held = openedFor;
      if (held !== undefined && held.toLowerCase() !== login.toLowerCase()) {
        throw new Error(
          `This conversation already acts as ${held} in Ivanti, so it cannot also act as ${login}.`,
        );
      }

      if (current !== undefined) return current;

      if (pending === undefined) {
        openedFor = login;
        pending = open(login);
      }

      try {
        current = await pending;
        return current;
      } catch (error) {
        // Nothing was opened, so nothing is held: a failed handshake must not leave the
        // conversation bound to a person it cannot act as.
        openedFor = undefined;
        throw error;
      } finally {
        pending = undefined;
      }
    },

    async release(): Promise<void> {
      const held = current;
      current = undefined;
      openedFor = undefined;
      // Teardown must never become the error a caller sees; an unreleased session expires anyway.
      if (held !== undefined) await held.release().catch(() => undefined);
    },
  };
}
