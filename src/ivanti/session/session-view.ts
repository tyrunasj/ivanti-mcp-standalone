// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import { createFormContext, type FormContext } from './form-context.js';
import type { IvantiSession } from './asmx-session.js';
import { createWorkspaceCatalog, type WorkspaceCatalog } from './workspaces.js';

/**
 * Everything derived from an ASMX session. These members depend on WHICH session — and so on which
 * role — and not on the tenant.
 *
 * The one function that builds them, used by `connectIvanti` for the service account and by
 * `connectionFor` for a person. A member added here is therefore person-scoped by construction;
 * built in two places, a new one would stay on the service account's role under the person's name
 * (`switch_role` had exactly that bug).
 */
export interface SessionView {
  readonly session: IvantiSession;
  readonly workspaces: WorkspaceCatalog;
  readonly forms: FormContext;
}

export function sessionView(session: IvantiSession, logger: Logger): SessionView {
  const workspaces = createWorkspaceCatalog(session, logger);
  return { session, workspaces, forms: createFormContext(session, workspaces, logger) };
}
