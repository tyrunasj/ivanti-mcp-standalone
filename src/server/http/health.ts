// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * What an unauthenticated caller gets: alive or not, and nothing else.
 *
 * A liveness probe cannot authenticate, so this endpoint must answer without a token — which
 * means anything it discloses is public. Version strings fingerprint the build for CVE
 * matching, and uptime reveals deploy timing, so neither belongs here.
 */
export const MINIMAL_HEALTH: MinimalHealth = { status: 'ok' };

export interface MinimalHealth {
  status: 'ok';
}

export interface HealthPayload {
  status: 'ok';
  name: string;
  version: string;
  protocolVersion: string;
  sdkVersion: string;
  timestamp: string;
  uptimeSeconds: number;
  sessions: number;
}

export interface HealthDeps {
  name: string;
  version: string;
  protocolVersion: string;
  sdkVersion: string;
  sessions: () => number;
  /** Injectable so the payload can be asserted exactly in tests. */
  now?: () => Date;
  uptimeSeconds?: () => number;
}

/**
 * Builds the health payload for an **authorized** caller.
 *
 * Deliberately reports no memory or CPU figures. Resource load handed to an attacker turns
 * blind probing into a guided attack — they can watch whether their load is landing and how
 * close the session cap is. Anyone entitled to that data can read it from the container
 * runtime, which is where process metrics belong.
 */
export function buildHealth(deps: HealthDeps): HealthPayload {
  const now = deps.now ?? ((): Date => new Date());
  const uptime = (deps.uptimeSeconds ?? ((): number => process.uptime()))();

  return {
    status: 'ok',
    name: deps.name,
    version: deps.version,
    protocolVersion: deps.protocolVersion,
    sdkVersion: deps.sdkVersion,
    timestamp: now().toISOString(),
    uptimeSeconds: Math.round(uptime * 10) / 10,
    sessions: deps.sessions(),
  };
}
