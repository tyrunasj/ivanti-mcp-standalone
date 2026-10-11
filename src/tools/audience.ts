// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Config } from '../config/env-schema.js';
import type { CapabilityTier } from '../ivanti/session/capability.js';

/**
 * Which families of tool a deployment gets, decided from its mode and capability tier alone.
 *
 * Narrowing happens at registration, never inside a handler: a tool that is not registered never
 * appears in `tools/list`, so the model cannot call it at all. Kept apart from the list of tools
 * so that "who gets what" changes in one place and the list only says what each family holds.
 */
export interface Audience {
  /** `enduser`: every record tool stands behind the own-records rule. */
  ownRecordsOnly: boolean;
  /** `full` only: `enduser` opens the self-service role and stays there. */
  switchRole: boolean;
  /** A staff question: who is *working* a record, where an end user only asks who it is *for*. */
  assignedWork: boolean;
  /** Tools that live on a workspace or a create form, which OData cannot see. */
  sessionTools: boolean;
  /** An end user gets the tenant's procedures only where the deployment named which ones. */
  quickActions: boolean;
  /** Staff surfaces that answer across everyone or for the service account. */
  staffSurfaces: boolean;
  /** `unlink_records` could sever a third record, which no ownership check would catch. */
  linking: boolean;
}

export function audienceFor(
  config: Config,
  tier: CapabilityTier,
  allowedQuickActions: number,
): Audience {
  const enduser = config.MCP_MODE === 'enduser';
  const sessionTools = tier !== 'odata';
  return {
    ownRecordsOnly: enduser,
    switchRole: !enduser,
    assignedWork: !enduser,
    sessionTools,
    quickActions: sessionTools && (!enduser || allowedQuickActions > 0),
    staffSurfaces: sessionTools && !enduser,
    linking: !enduser,
  };
}
