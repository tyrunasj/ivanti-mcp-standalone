// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { ConfigError } from '../config/load-config.js';
import { TenantRefusedError } from '../ivanti/http/base-path.js';
import type { Logger } from '../logger.js';
import { ListenError } from './start-http.js';

/** `EX_CONFIG`: a supervisor with `RestartPreventExitStatus=78` does not retry it. */
export const EXIT_CONFIG = 78;

export type StartupFailure =
  /** A setting to correct; `message` is what to print. */
  | { kind: 'config'; message: string }
  /** Already logged with what to change. */
  | { kind: 'logged' }
  /** Anything else: an outage or a bug, logged with its stack. */
  | { kind: 'crash' };

/**
 * What a failure before the server is serving means for the exit code. Only a mistake the operator
 * has to fix is a configuration exit — the tenant refusing the key is one, an unreachable tenant
 * is not.
 */
export function classifyStartupFailure(error: unknown): StartupFailure {
  if (error instanceof ConfigError) return { kind: 'config', message: error.message };
  if (error instanceof TenantRefusedError) {
    return { kind: 'config', message: `Invalid configuration:\n  - ${error.message}` };
  }
  if (error instanceof ListenError) return { kind: 'logged' };
  return { kind: 'crash' };
}

/**
 * Closes whatever a failed startup had already opened, best effort: a stdio conversation or an
 * HTTP listener that was serving would otherwise exit with a person's Ivanti session still open on
 * the tenant. One that will not close must not hide the failure that got us here.
 */
export async function closeStarted(
  parts: readonly ({ close: () => Promise<void> } | undefined)[],
  logger: Pick<Logger, 'warn'>,
): Promise<void> {
  const results = await Promise.allSettled(parts.map((part) => (part === undefined ? Promise.resolve() : part.close())));
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn('closing after a failed startup also failed', { error: result.reason });
    }
  }
}
