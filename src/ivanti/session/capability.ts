// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import type { AdminCatalog } from './admin-catalog.js';
import type { IvantiSession, SessionIdentity } from './asmx-session.js';
import type { CentralConfig } from './central-config.js';

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
  /**
   * Whether `act_as` can open an Ivanti session **as** the person, rather than only deciding who
   * "my" means.
   *
   * A second axis, not a higher tier. The tier says what the *service account* reaches; this says
   * whether a *person's* own access can be applied instead — and it reaches OData only, since the
   * form and admin surfaces refuse a CentralConfig session. False is the normal, fully supported
   * state: it is what every deployment without the ConfigDB pair runs.
   */
  canImpersonate: boolean;
  /** Why not, when it is configured and still unavailable. */
  impersonationReason?: string;
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
  centralConfig?: CentralConfig,
): Promise<Capability> {
  // Probed first, and independently of the tier: impersonation drives OData, which every tier
  // has. A deployment capped to `odata` can still act as the person.
  const impersonation = await probeImpersonation(centralConfig, logger);

  if (maxTier === 'odata') {
    logger.info('ivanti tier capped by configuration', { maxTier });
    return { tier: 'odata', reason: 'capped by IVANTI_MAX_TIER', ...impersonation };
  }

  let identity: SessionIdentity;
  try {
    identity = await session.identity();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    logger.warn('ivanti session unavailable; serving the OData tier only', {
      reason: reason.slice(0, 200),
    });
    return { tier: 'odata', reason, ...impersonation };
  }

  if (maxTier === 'session') {
    logger.info('ivanti tier capped by configuration', { maxTier, role: identity.role });
    return { tier: 'session', identity, reason: 'capped by IVANTI_MAX_TIER', ...impersonation };
  }

  // The admin console is tried, not assumed. The call doubles as the catalog fetch, so a tenant
  // that allows it pays one round trip and gets 1324 objects for it.
  try {
    await admin.list();
    return { tier: 'admin', identity, ...impersonation };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    logger.info('ivanti admin console unavailable; using the role workspaces instead', {
      role: identity.role,
      reason: reason.slice(0, 200),
    });
    return { tier: 'session', identity, reason, ...impersonation };
  }
}

type ImpersonationCapability = Pick<Capability, 'canImpersonate' | 'impersonationReason'>;

/**
 * Three outcomes, three log lines, and **none of them stops the server**.
 *
 * A configured-but-unreachable ConfigDB is a `warn` rather than a startup failure for the same
 * reason a refused admin console is: the deployment is still a useful server, and refusing to
 * start would turn a transient outage at someone else's host into an outage here. The line says
 * what was lost so the degradation is visible rather than silent.
 */
async function probeImpersonation(
  centralConfig: CentralConfig | undefined,
  logger: Logger,
): Promise<ImpersonationCapability> {
  if (centralConfig === undefined) {
    logger.info('ivanti impersonation not configured; act_as decides who "my" means, no more');
    return { canImpersonate: false };
  }

  try {
    await centralConfig.probe();
    logger.info('ivanti impersonation available; act_as will open a session as the person');
    return { canImpersonate: true };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    logger.warn('ivanti impersonation configured but unavailable; act_as decides scope only', {
      reason: reason.slice(0, 200),
    });
    return { canImpersonate: false, impersonationReason: reason };
  }
}
