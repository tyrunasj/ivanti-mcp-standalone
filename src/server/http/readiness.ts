// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.
import type { Logger } from '../../logger.js';

/**
 * Whether this instance should be sent traffic now: the tenant still answers it.
 *
 * `/health` answers a different question — is the process alive — and it must keep answering yes
 * through a tenant outage: a liveness probe that restarted the container over it would fix
 * nothing and end every conversation. Readiness is what a Kubernetes Service or a load balancer
 * asks before routing, and an instance that says no is skipped until it says yes again.
 *
 * Checked in the background and answered from the last result. A probe gets a few seconds, and an
 * Ivanti request can take longer than that on a good day — waiting on one inside the probe would
 * turn a slow tenant into a flapping pod.
 */
export const READINESS_INTERVAL_MS = 60_000;

/**
 * One failed check is a slow answer as often as an outage; two in a row, a minute apart, is not.
 * The first success makes it ready again.
 */
export const FAILURES_BEFORE_NOT_READY = 2;

export interface ReadinessState {
  ready: boolean;
  /** Why the last check failed. Only an authorized caller is shown it. */
  reason?: string;
  /** When the last check ran; absent until the first one has. */
  checkedAt?: string;
}

export interface Readiness {
  state: () => ReadinessState;
  /** Runs one check now — what the timer does, exposed so it can be asserted without one. */
  checkNow: () => Promise<void>;
  stop: () => void;
}

export interface ReadinessOptions {
  /** Resolves when the dependency answered as it should; rejects with why it did not. */
  check: () => Promise<void>;
  logger: Logger;
  intervalMs?: number;
  now?: () => Date;
}

/**
 * Starts checking in the background. Starts **ready**: it is created after startup has already
 * reached the tenant, and a first answer of "not ready" would only delay the first conversation.
 */
export function startReadiness(options: ReadinessOptions): Readiness {
  const { check, logger } = options;
  const now = options.now ?? ((): Date => new Date());
  let state: ReadinessState = { ready: true };
  let failures = 0;
  let checking: Promise<void> | undefined;

  const run = async (): Promise<void> => {
    try {
      await check();
      if (!state.ready) logger.info('ivanti answering again; ready for traffic');
      failures = 0;
      state = { ready: true, checkedAt: now().toISOString() };
    } catch (error: unknown) {
      failures += 1;
      const reason = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
      const ready = state.ready && failures < FAILURES_BEFORE_NOT_READY;
      if (state.ready && !ready) logger.warn('ivanti not answering; not ready for traffic', { reason, failures });
      state = { ready, reason, checkedAt: now().toISOString() };
    }
  };

  // One at a time: a check still waiting when the next is due is joined, not doubled.
  const checkNow = (): Promise<void> => {
    checking ??= run().finally(() => {
      checking = undefined;
    });
    return checking;
  };

  const timer = setInterval(() => {
    void checkNow();
  }, options.intervalMs ?? READINESS_INTERVAL_MS);
  // Never what keeps the process alive, nor what holds up its exit.
  timer.unref();

  return { state: () => state, checkNow, stop: () => clearInterval(timer) };
}

/** Nothing downstream to check — Ivanti is not configured — so always ready. */
export const ALWAYS_READY: Readiness = {
  state: () => ({ ready: true }),
  checkNow: () => Promise.resolve(),
  stop: () => undefined,
};
