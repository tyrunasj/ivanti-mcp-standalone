// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { IvantiTransport } from '../../ivanti/http/transport.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import { readRows } from '../shared/read-rows.js';

/**
 * Whether `targetId` is on the far side of `relationship` from the record, read from Ivanti.
 *
 * One definition for the read that happens BEFORE a link or unlink (to refuse or to word the
 * answer) and the one AFTER it (to confirm): Ivanti's `ISM_2000` in a 200 is not evidence that the
 * relationship changed, so the related rows are the only proof either way.
 *
 * @throws whatever the read throws — callers decide whether that is a refusal or a best effort.
 */
export async function isLinkedTo(
  transport: IvantiTransport,
  entitySet: string,
  recordId: string,
  relationship: string,
  targetId: string,
): Promise<boolean> {
  const url = transport.routes.related(entitySet, recordId, relationship);
  const rows = readRows<OdataRecord>(await transport.request<OdataRecord>(url), url);
  return rows.some(
    (row) => typeof row['RecId'] === 'string' && row['RecId'].toLowerCase() === targetId.toLowerCase(),
  );
}

/** The after-read: whether the target is linked, or why that could not be established. */
export async function confirmLinked(
  transport: IvantiTransport,
  entitySet: string,
  recordId: string,
  relationship: string,
  targetId: string,
): Promise<boolean | Error> {
  try {
    return await isLinkedTo(transport, entitySet, recordId, relationship, targetId);
  } catch (error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** The wording when the after-read itself failed, so the write is neither claimed nor denied. */
export function notConfirmed(verb: 'link' | 'unlink', targetId: string, cause: Error): string {
  return (
    `Ivanti accepted the ${verb} of ${targetId}, but reading the relationship back failed: ` +
    `${cause.message.slice(0, 200)}. So it is not confirmed. Check with get_related_records ` +
    `before saying it ${verb === 'link' ? 'is linked' : 'was removed'}.`
  );
}
