// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { setRequestObserver } from './ivanti/http/request-observer.js';
import { recordIvantiRequest, recordIvantiRequestNotSent } from './metrics/server-metrics.js';
import { countIvantiRequest } from './usage/call-usage.js';

/**
 * Wires what `ivanti/` reports about each request to the call's usage tally and the metrics.
 * Composition, so it lives above both: `ivanti/` may not import either.
 */
export function observeIvantiRequests(): void {
  setRequestObserver({
    sent: countIvantiRequest,
    answered: recordIvantiRequest,
    notSent: recordIvantiRequestNotSent,
  });
}
