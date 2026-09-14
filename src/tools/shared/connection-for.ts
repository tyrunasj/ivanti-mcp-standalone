// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { IvantiConnection } from '../../ivanti/connect.js';
import type { IvantiToolDeps } from './deps.js';
import { transportFor } from './transport-for.js';
import { createFormContext } from '../../ivanti/session/form-context.js';
import type { ImpersonatedSession } from '../../ivanti/session/impersonated-session.js';
import { createWorkspaceCatalog } from '../../ivanti/session/workspaces.js';
import type { CallContext } from '../tool-definition.js';

/**
 * The connection a tool call runs on: the service account's, or the person's.
 *
 * **The one place that decides**, for every surface at once. A person's view of Ivanti differs
 * from the service account's on four members and agrees on the rest:
 *
 * - `transport` — OData and REST, authenticated by their SID rather than the API key
 * - `session` — the ASMX surface, on their SID and CSRF
 * - `workspaces` and `forms` — which objects their **role** has workspaces for, and what the
 *   create form for each looks like under it. These are role-dependent, so a catalog built for the
 *   service account's role would describe a different Ivanti from the one they see.
 *
 * Everything else is a fact about the **tenant** rather than about the person, and stays on the
 * service account on purpose: the metadata catalog (a schema, cached once), the admin catalog (a
 * list of objects, and most people cannot reach the admin console), the person directory (what
 * `act_as` resolves people through — impersonating it would be circular) and the tenant UTC
 * offset.
 *
 * An earlier version of this file swapped only `transport`, on the belief that a CentralConfig
 * session was refused by every ASMX service. It was refused because `SelectRole` had not been
 * called; see `impersonated-session.ts`.
 */

/** One view per session, not per call — a `WeakMap` so it dies with the session it belongs to. */
const perSession = new WeakMap<ImpersonatedSession, IvantiConnection>();

export function connectionFor(deps: IvantiToolDeps, context: CallContext): IvantiConnection {
  const base = deps.connection;
  const session = context.impersonation?.session();
  if (session === undefined) return base;

  const existing = perSession.get(session);
  if (existing !== undefined) return existing;

  // Built the way `connectIvanti` builds them, on the person's session instead. Each caches for
  // the life of the session, exactly as the service account's cache for the life of the process.
  const logger = deps.logger;
  const workspaces = createWorkspaceCatalog(session, logger);
  const scoped: IvantiConnection = {
    ...base,
    transport: transportFor(base.transport, context),
    session,
    workspaces,
    forms: createFormContext(session, workspaces, logger),
  };
  perSession.set(session, scoped);
  return scoped;
}
