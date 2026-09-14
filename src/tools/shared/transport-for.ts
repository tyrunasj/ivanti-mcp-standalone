// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { IvantiTransport } from '../../ivanti/http/transport.js';
import type { ImpersonatedSession } from '../../ivanti/session/impersonated-session.js';
import type { CallContext } from '../tool-definition.js';

/**
 * Which credential a record operation runs under: the service account, or the person.
 *
 * **The one place that decides.** Threading a SID through thirty call sites would mean thirty
 * chances to forget one, and a forgotten one does not fail — it quietly answers as the service
 * account, which is the failure mode this whole feature exists to remove.
 *
 * Returns the process-wide transport unless this conversation has an impersonated session open,
 * so a deployment without the ConfigDB pair takes the identical path it always has.
 *
 * ## What must NOT go through here
 *
 * Impersonation answers "what may *this person* see". Three kinds of call are not that, and
 * keeping them on the service account is deliberate rather than an oversight:
 *
 * - **The metadata catalog.** A tenant's schema is a tenant fact, cached once for the process. Read
 *   per person it would be re-fetched per conversation and could differ between them.
 * - **The person directory.** `act_as` uses it to resolve who the caller means — before any
 *   session exists. Impersonating that lookup is circular.
 * - **Tenant-wide facts** such as the UTC offset and a link field's `_Category` spelling. They
 *   describe the tenant, not the person, and `parent-link.ts` caches them keyed by transport —
 *   a per-conversation transport would turn a process-wide cache into a per-conversation one.
 *
 * The ASMX surfaces never reach here at all: forms, pick lists, quick actions and the admin
 * console answer **551** to a CentralConfig session whatever role it holds.
 */

/**
 * Memoised per session rather than per call, so a conversation builds one transport and not one
 * per request. A `WeakMap` because the entry should die with the session it belongs to: the slot
 * drops the session on release, and a `Map` here would hold every conversation's forever.
 */
const perSession = new WeakMap<ImpersonatedSession, IvantiTransport>();

export function transportFor(base: IvantiTransport, context: CallContext): IvantiTransport {
  const session = context.impersonation?.session();
  if (session === undefined) return base;

  const existing = perSession.get(session);
  if (existing !== undefined) return existing;

  const scoped = base.asPerson(session.sid);
  perSession.set(session, scoped);
  return scoped;
}
