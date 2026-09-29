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
  /**
   * The session, once `act_as` has opened one — still handed back when it is known dead, because
   * `undefined` here means "use the service account", and a dead session must never mean that.
   * `open` is what replaces a dead one.
   */
  session: () => ImpersonatedSession | undefined;
  /**
   * Opens a session for this login, or hands back the one already open.
   *
   * Repeating the same login is a no-op, matching the pin — a model that calls `act_as` twice with
   * the same person should not pay for a second handshake, or worse, strand the first session.
   * **Unless the one held is dead**: refused by Ivanti (`discard`), or past the expiry CentralConfig
   * gave it. Handing that back would answer every later call with a 401, so it is replaced by a
   * fresh handshake for the same login.
   *
   * @throws when a *different* login is requested. The pin refuses that first, so reaching this is
   * a bug rather than a user error; refusing here keeps the two from disagreeing about who this
   * conversation is for.
   */
  open: (login: string) => Promise<ImpersonatedSession>;
  /**
   * Marks a session Ivanti has refused as dead, so the next `open` replaces it.
   *
   * Takes the session rather than meaning "whatever is held": a refusal can arrive late, from a
   * call that started on a session already replaced, and it must not discard the fresh one.
   */
  discard: (dead: ImpersonatedSession) => void;
  /**
   * Releases and clears — including a handshake still in flight, whose session is given back
   * rather than stored when it lands. Resolves once every release request has settled. Safe to
   * call when nothing is open, and never throws.
   */
  release: () => Promise<void>;
}

export type SessionOpener = (login: string) => Promise<ImpersonatedSession>;

/**
 * How long before CentralConfig's stated expiry a session stops being handed out, so a call does
 * not start on one that lapses halfway through it.
 */
export const EXPIRY_MARGIN_MS = 30_000;

interface Attempt {
  /** Which incarnation of the slot started it; `release` moves on, and a late landing is refused. */
  generation: number;
  login: string;
  promise: Promise<ImpersonatedSession>;
}

const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * When a session stops being usable, if CentralConfig said so believably.
 *
 * `SessionKeyExpire` carries no time zone. Read in the wrong one, a session could look expired
 * the moment it was opened, and every call would re-open it — so an expiry that has already
 * passed when the session is handed over is disregarded rather than trusted. A 401 still catches
 * a session that really has lapsed.
 */
function believableExpiry(session: ImpersonatedSession): number | undefined {
  if (session.expiresAt === undefined) return undefined;
  const at = Date.parse(session.expiresAt) - EXPIRY_MARGIN_MS;
  return Number.isFinite(at) && at > Date.now() ? at : undefined;
}

export function createImpersonationSlot(open: SessionOpener): ImpersonationSlot {
  let current: ImpersonatedSession | undefined;
  let expiresAt: number | undefined;
  let dead = false;
  // The login this slot is bound to, claimed when a handshake STARTS rather than when it finishes.
  let openedFor: string | undefined;
  // Concurrent first calls share one handshake, the way the service-account session does: a cold
  // conversation that fired two tool calls would otherwise open two Ivanti sessions and leak one.
  let pending: Attempt | undefined;
  // Bumped by every `release`. A handshake carries the generation it started in, and one that
  // lands in a later generation belongs to a conversation that is over.
  //
  // Without it, a conversation that ended while `act_as` was still opening a session — a stdio
  // re-initialize, an idle expiry — had nothing to release yet, and the handshake then landed and
  // stored the first person's session in the NEXT conversation's slot. Every `act_as` there for
  // anyone else was refused, naming somebody the new conversation had never heard of, until the
  // process restarted. And `release` left `pending` set, so a later `open` for another person
  // could join that handshake and be handed the first person's session.
  let generation = 0;

  const usable = (): boolean =>
    current !== undefined && !dead && (expiresAt === undefined || Date.now() < expiresAt);

  const start = (login: string): Attempt => {
    const started = generation;
    // Replaced, not reused: RemoveSession ends nothing on Ivanti's side (docs/notes.md), but it is
    // the documented teardown, and a later Ivanti may honour it. Nothing waits on it.
    const stale = current;
    current = undefined;
    expiresAt = undefined;
    dead = false;
    if (stale !== undefined) void stale.release().catch(() => undefined);

    openedFor = login;
    const attempt: Attempt = {
      generation: started,
      login,
      promise: open(login)
        .then(
          async (session) => {
            if (started !== generation) {
              // The conversation it was opened for is over. Given back here, where `release` waits
              // for it, and never stored or handed to whoever asks next.
              await session.release().catch(() => undefined);
              throw new Error(
                `The conversation ended while an Ivanti session was being opened as ${login}, so ` +
                  'it was given back rather than kept.',
              );
            }
            current = session;
            expiresAt = believableExpiry(session);
            dead = false;
            return session;
          },
          (error: unknown) => {
            // Nothing was opened, so nothing is held: a failed handshake must not leave the
            // conversation bound to a person it cannot act as.
            if (started === generation) openedFor = undefined;
            throw error;
          },
        )
        .finally(() => {
          if (pending === attempt) pending = undefined;
        }),
    };
    pending = attempt;
    return attempt;
  };

  return {
    session: () => current,

    discard(session): void {
      if (session === current) dead = true;
    },

    async open(login): Promise<ImpersonatedSession> {
      // Both of these once sat behind `current !== undefined`, which is only assigned after a
      // handshake resolves — so while the first was in flight the guard could not fire, and a
      // second caller was joined to it without comparing the login. The joiner was handed the first
      // person's session, and the slot was left labelled with the refused person.
      const held = openedFor;
      if (held !== undefined && !sameLogin(held, login)) {
        throw new Error(
          `This conversation already acts as ${held} in Ivanti, so it cannot also act as ${login}.`,
        );
      }

      if (usable() && current !== undefined) return current;

      // Joined only when it is this login's handshake, in this generation — never another's.
      const joinable =
        pending !== undefined && pending.generation === generation && sameLogin(pending.login, login);
      const attempt = joinable && pending !== undefined ? pending : start(login);
      return attempt.promise;
    },

    async release(): Promise<void> {
      generation += 1;
      const held = current;
      const inflight = pending?.promise;
      current = undefined;
      expiresAt = undefined;
      dead = false;
      openedFor = undefined;
      pending = undefined;
      // Teardown must never become the error a caller sees; an unreleased session expires anyway.
      // An in-flight handshake gives its own session back when it lands, so waiting for it is
      // waiting for that release too.
      await Promise.all([
        held?.release().catch(() => undefined),
        inflight?.catch(() => undefined),
      ]);
    },
  };
}
