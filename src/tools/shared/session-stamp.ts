// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { OdataRecord } from '../../ivanti/odata/response.js';

/**
 * The fields Ivanti filled with the signed-in person, which nobody asked it to fill.
 *
 * Ivanti resolves an assignment from the session, so a create made through an impersonated session
 * comes back assigned to the person it was raised FOR. Measured 2026-09-17 on this tenant: acting
 * as Harold Sanders, a create carrying no `Owner` stored `Owner: HSanders` and `OwnerTeam: IT` —
 * the requester's own team — and the record advanced to `Active`. The same create without
 * impersonation stored the service account instead. Supplying the status the tenant starts records
 * in left `Owner` null, which is the shape a queue can pick up.
 *
 * Reported rather than corrected, because correcting it cannot be done without naming tenant
 * things: clearing the assignment is refused while the record sits at the status that required it,
 * and the status to put it back to is the tenant's own word. So the names are DISCOVERED from the
 * stored record — any field holding the acting login — rather than listed here. `Owner` is this
 * tenant's spelling and would be the wrong thing to hard-code, the same mistake as teaching one
 * object's field names as the general rule.
 *
 * Authorship fields come back too, and that is correct: `CreatedBy` naming the person IS what
 * impersonation is for. The note tells the two apart in words rather than by guessing at names.
 */
export function sessionStampedFields(
  created: OdataRecord | undefined,
  written: readonly string[],
  login: string | undefined,
): string[] {
  if (created === undefined || login === undefined || login === '') return [];

  const asked = new Set(written.map((name) => name.toLowerCase()));
  const needle = login.toLowerCase();

  return Object.entries(created)
    .filter(([name, value]) => !asked.has(name.toLowerCase()) && typeof value === 'string' && value.toLowerCase() === needle)
    .map(([name]) => name)
    .sort();
}

/** What to say about them — one sentence per half, because the two halves differ in kind. */
export function sessionStampNote(fields: readonly string[], who: string): string {
  return (
    `Ivanti filled ${fields.join(', ')} with ${who} from the signed-in session — nothing here ` +
    'asked it to. Authorship recording them is the point of acting for someone; an ASSIGNMENT ' +
    'recording them means the record is assigned to the person it was raised for, and will not ' +
    'reach a queue. Pass the status this tenant starts records in to leave it unassigned, or name ' +
    'the assignee explicitly.'
  );
}
