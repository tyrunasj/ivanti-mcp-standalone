// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { ALL_FIELDS } from '../../ivanti/odata/compact-fields.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';

/**
 * Field names the caller asked for that the rows do not have.
 *
 * Projection is client-side, so an unknown name is simply absent from the output and the row
 * looks like a record with no value for it. `get_record` has reported this since the last round;
 * `list_records` and `get_related_records` did not, and the gap bit a tester twice by accident —
 * asking `change` for `ApprovalStatus` (which it has no such field) returned rows with no such
 * key, which narrates as "the pending changes have no approval status set". That is a statement
 * about a typo dressed as a statement about the data, and it is the exact failure this whole
 * surface is built to prevent.
 *
 * Judged across the returned rows rather than one, because a field can be legitimately absent
 * from a single row while present on the object.
 */
export function ignoredFieldNames(
  rows: readonly OdataRecord[],
  requested: readonly string[] | undefined,
): string[] {
  if (requested === undefined || rows.length === 0) return [];

  const present = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) present.add(key.toLowerCase());

  return requested.filter(
    (name) => name !== ALL_FIELDS && name !== '' && !present.has(name.toLowerCase()),
  );
}

/** The sentence that goes with it, so both tools say the same thing. */
export function ignoredFieldsNote(ignored: readonly string[]): string {
  return (
    `These rows have no field named ${ignored.join(', ')}, so ${
      ignored.length === 1 ? 'it was' : 'they were'
    } left out rather than returned empty. A MISSING KEY IS NOT AN EMPTY VALUE — do not report ` +
    'the value as absent. Call get_object_metadata with a `search` for the right name.'
  );
}
