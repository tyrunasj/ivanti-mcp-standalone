// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { isIvantiNotFound } from '../http/errors.js';
import type { IvantiTransport } from '../http/transport.js';
import type { OdataRecord } from '../odata/response.js';

/**
 * One record by RecId, or `undefined` when Ivanti says it is not there.
 *
 * "Not there" is Ivanti's own dialect — a 404, or a 400 whose body says the key is invalid — and
 * an empty body for a read by key. Every other failure rethrows: a 500, a gateway's 502, the
 * transport's own timeout. The read was copied at six call sites and the copy that took a bare
 * `.catch(() => undefined)` reported an outage as a fact about the record, twice rated high. One
 * definition, so a guard built on this cannot disable itself when it cannot be evaluated.
 */
export async function readRecordOrAbsent(
  transport: IvantiTransport,
  entitySet: string,
  recId: string,
): Promise<OdataRecord | undefined> {
  try {
    return await transport.request<OdataRecord>(transport.routes.record(entitySet, recId));
  } catch (error: unknown) {
    if (isIvantiNotFound(error)) return undefined;
    throw error;
  }
}
