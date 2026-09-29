// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { OdataRecord } from '../../ivanti/odata/response.js';

/**
 * Whose vote row this is — the one rule `list_approvals` and `vote_on_approval` both apply.
 *
 * `Owner` holds a different identifier depending on the row — a LOGIN on some, a DISPLAY NAME on
 * others, and an EMAIL on others still (measured live: `tyrunasj@synergy.eu` on a request this
 * server had just filed). `Owner_Valid` is the employee RecId and never varies.
 *
 * **When `Owner_Valid` is there, it decides alone.** It used to be one clause in an OR with the
 * `Owner` spellings, so a row whose `Owner_Valid` named SOMEONE ELSE still matched on the display
 * name — and two people called John Smith could each vote on the other's approval, recorded as the
 * other's decision. A display name is not an identity. The spellings of `Owner` decide only on a
 * row that carries no `Owner_Valid` at all.
 *
 * The listing uses the same rule to drop the rows its `Owner eq '<display name>'` clause fetches
 * for a namesake, so it never offers a row the vote would then refuse.
 */

export interface Approver {
  recId?: string;
  loginId?: string;
  primaryEmail?: string;
  displayName?: string;
}

/**
 * Whether one of the person's identifiers is what the row records.
 *
 * Case-folded, and runs of whitespace collapse: Ivanti assembles a display name from its parts and
 * leaves the gap where a middle name is not set, so it stores `Becky   Smith` with three spaces.
 * An absent identifier never matches — `undefined` and `''` are not an owner.
 */
function sameIdentifier(mine: string | undefined, onRow: string): boolean {
  if (mine === undefined || mine === '' || onRow === '') return false;
  const fold = (value: string): string => value.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
  return fold(mine) === fold(onRow);
}

const text = (row: OdataRecord, field: string): string => {
  const value = row[field];
  return typeof value === 'string' ? value : '';
};

/**
 * - `theirs` — the row is the person's.
 * - `namesake` — `Owner` reads as them, but `Owner_Valid` names a different employee: somebody who
 *   shares their name, login spelling or address. Told apart so a refusal can say so, rather than
 *   naming the same person on both sides of "not".
 * - `someone-else` — neither.
 */
export type VoteOwnership = 'theirs' | 'namesake' | 'someone-else';

export function voteOwnership(person: Approver, row: OdataRecord): VoteOwnership {
  const owner = text(row, 'Owner');
  const ownerValid = text(row, 'Owner_Valid');
  const spelledAsThem =
    sameIdentifier(person.loginId, owner) ||
    sameIdentifier(person.primaryEmail, owner) ||
    sameIdentifier(person.displayName, owner);

  if (ownerValid.trim() !== '') {
    if (sameIdentifier(person.recId, ownerValid)) return 'theirs';
    return spelledAsThem ? 'namesake' : 'someone-else';
  }
  return spelledAsThem ? 'theirs' : 'someone-else';
}
