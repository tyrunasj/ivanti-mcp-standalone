// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { visibleFields, type EntityMetadata } from '../../ivanti/metadata/csdl.js';
import { compactFieldsFor, resolveRowFields } from '../../ivanti/odata/compact-fields.js';
import { parseFieldList } from '../../ivanti/odata/projection.js';

/** Said when the default fell back to an object's own fields. The one sentence, in every tool. */
export const COMPACT_FELL_BACK_NOTE =
  'THIS OBJECT IS NOT ONE OF THE ONES THE DEFAULT KNOWS, so the rows below show its own first ' +
  'few fields instead. That choice is arbitrary, not a judgement about which fields matter — ' +
  'name the ones you want in `fields`, or pass "*".';

/** Said when the default fitted. */
export const COMPACT_FITTED_NOTE =
  'a compact default set — pass `fields` for others, or "*" for whole records';

export interface CompactRows {
  /** What to project, or `undefined` for whole records. */
  fields: string[] | undefined;
  /** True when the caller named no fields and the compact default was applied. */
  defaulted: boolean;
  /** Present only when the default did not fit and the object's own fields were shown. */
  note?: string;
  /** With `note`: the populated fields that were left out, for the caller to choose from. */
  otherFields?: string[];
}

/**
 * Which fields a set of rows shows: the caller's list, everything for `"*"`, or a default decided
 * against THESE rows — and the note that goes with that decision.
 *
 * Projection and note are decided by the one `compactFieldsFor` answer. `list_records` used to
 * project from `compactFieldsFor(rows, extras)` but decide its note from a second predicate that
 * ignored the extras, so rows that fitted on the object's own required fields were announced as
 * "not one of the ones the default knows". The search tools, `list_records` and
 * `get_related_records` now share this, so the same payload key teaches the same rule.
 *
 * The list is a preference; `compactFieldsFor` is what makes it one. A tenant's own Business
 * Object shares none of the preference names and would otherwise answer with rows nobody could
 * tell apart. `entity` adds the object's own validated and required fields as candidates — pass
 * it only when the rows are that object's own (a related row belongs to the target's schema).
 */
export function compactRows(
  rows: readonly Record<string, unknown>[],
  raw: string | undefined,
  entity?: EntityMetadata,
): CompactRows {
  const projection = resolveRowFields(parseFieldList(raw), raw);
  if (!projection.defaulted || rows.length === 0) {
    return { fields: projection.fields, defaulted: projection.defaulted };
  }

  const compact = compactFieldsFor(
    rows,
    entity === undefined
      ? []
      : visibleFields(entity)
          .filter((field) => field.validated || !field.nullable)
          .map((field) => field.name),
  );

  return compact.fellBack
    ? {
        fields: compact.fields,
        defaulted: true,
        note: COMPACT_FELL_BACK_NOTE,
        otherFields: compact.rest,
      }
    : { fields: compact.fields, defaulted: true };
}
