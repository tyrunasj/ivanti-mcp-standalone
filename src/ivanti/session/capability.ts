// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import type { AdminCatalog } from './admin-catalog.js';
import type { IvantiSession, SessionIdentity } from './asmx-session.js';

/**
 * What this credential can actually do, decided once at startup.
 *
 * A tenant API key may carry any role, and the ASMX half of Ivanti is reachable only if the
 * handshake succeeds. Rather than registering tools that will fail for half the customers, the
 * tier decides which tools exist at all — an unregistered tool never appears in `tools/list`.
 */
/**
 * | Tier | What the credential turned out to be | What it adds |
 * |---|---|---|
 * | `odata` | the API key alone | every read tool; the catalog is ~194 names from metadata graphs |
 * | `session` | the ASMX handshake opens | the role's own workspaces, and the identity |
 * | `admin` | the admin console answers too | the complete catalog — 1324 objects, with descriptions |
 *
 * Higher tiers only ever *add*. A feature that exists only at `admin` must degrade, never break:
 * most customers will not hand an MCP server a key with admin rights.
 */
export type CapabilityTier = 'odata' | 'session' | 'admin';

export interface Capability {
  tier: CapabilityTier;
  /** Present from the `session` tier up: who the server signs in as. */
  identity?: SessionIdentity;
  /** Why the tier is not higher — the session failed, or the admin console refused. */
  reason?: string;
}

/**
 * Opens the session once to find out whether it opens at all.
 *
 * Failure is **not** fatal: the OData tier is a genuinely useful server — reads need no session —
 * and refusing to start would punish exactly the customers who cannot issue an admin key.
 */
export async function probeCapability(
  session: IvantiSession,
  admin: AdminCatalog,
  logger: Logger,
  maxTier: CapabilityTier = 'admin',
): Promise<Capability> {
  if (maxTier === 'odata') {
    logger.info('ivanti tier capped by configuration', { maxTier });
    return { tier: 'odata', reason: 'capped by IVANTI_MAX_TIER' };
  }

  let identity: SessionIdentity;
  try {
    identity = await session.identity();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    logger.warn('ivanti session unavailable; serving the OData tier only', {
      reason: reason.slice(0, 200),
    });
    return { tier: 'odata', reason };
  }

  if (maxTier === 'session') {
    logger.info('ivanti tier capped by configuration', { maxTier, role: identity.role });
    return { tier: 'session', identity, reason: 'capped by IVANTI_MAX_TIER' };
  }

  // The admin console is tried, not assumed. The call doubles as the catalog fetch, so a tenant
  // that allows it pays one round trip and gets 1324 objects for it.
  try {
    await admin.list();
    return { tier: 'admin', identity };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    logger.info('ivanti admin console unavailable; using the role workspaces instead', {
      role: identity.role,
      reason: reason.slice(0, 200),
    });
    return { tier: 'session', identity, reason };
  }
}
