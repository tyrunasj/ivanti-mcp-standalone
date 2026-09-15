// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { IvantiConnection } from '../../ivanti/connect.js';
import type { Logger } from '../../logger.js';
import type { ObjectGate } from './object-gate.js';
import type { ActionGate } from './action-gate.js';

/**
 * What every Ivanti tool needs and nothing more: the connection built at startup, the gate that
 * says which Business Objects this audience may touch, and somewhere to log. Tools never read
 * configuration or the environment — what they may do was decided when they were selected.
 */
export interface IvantiToolDeps {
  connection: IvantiConnection;
  gate: ObjectGate;
  logger: Logger;
  /**
   * Whether a caller may only see their own records — `enduser` mode, and the reason `act_as`
   * is a gate there rather than a preference.
   *
   * A flag rather than the config object: what a tool may do was decided when it was selected,
   * and handing handlers the configuration would invite them to decide it again, differently.
   */
  ownRecordsOnly: boolean;
  /** Which of the tenant's own procedures this audience may run. Open in `full`. */
  actions: ActionGate;
}

/**
 * Whether this deployment registers the tools a description might point the model at.
 *
 * A description naming a tool that is not in `tools/list` is worse than saying nothing: a model
 * cannot tell "not registered here" from "you called it wrong", so it retries with synonyms.
 * `resources.test.ts` has enforced this for the reference documents since they existed;
 * `description-cross-reference.test.ts` now enforces it here.
 */
export const registersFormTools = (deps: IvantiToolDeps): boolean =>
  deps.connection.capability.tier !== 'odata';

/** `link_records` / `unlink_records` are `full`-only: see register-tools. */
export const registersLinkTools = (deps: IvantiToolDeps): boolean => !deps.ownRecordsOnly;
