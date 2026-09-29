// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { visibleFields, type EntityMetadata } from '../../ivanti/metadata/csdl.js';
import { compactFieldsFor, resolveRowFields } from '../../ivanti/odata/compact-fields.js';
import { parseFieldList } from '../../ivanti/odata/projection.js';

/**
 * Which fields a search hit shows: the caller's list, everything for `"*"`, or a default decided
 * against THIS object's rows — the decision `list_records` makes.
 *
 * Both search tools had their own shortcut and both were wrong. `fulltext_search_object` handed
 * `fields` straight to the projection, so `"*"` became a field NAME no row has and every hit came
 * back as its RecId alone. Both defaulted to the fixed preference list with no fallback, so a
 * tenant's own Business Object — which shares none of those names — answered with rows nobody
 * could tell apart. The list is a preference; `compactFieldsFor` is what makes it one.
 */
export function rowFields(
  rows: readonly Record<string, unknown>[],
  raw: string | undefined,
  entity: EntityMetadata,
): { fields: string[] | undefined; note?: string } {
  const projection = resolveRowFields(parseFieldList(raw), raw);
  if (!projection.defaulted || rows.length === 0) return { fields: projection.fields };

  // A better-than-a-name-list candidate source: the object's own validated and required fields,
  // used only where the rows actually carry them.
  const compact = compactFieldsFor(
    rows,
    visibleFields(entity)
      .filter((field) => field.validated || !field.nullable)
      .map((field) => field.name),
  );

  return compact.fellBack
    ? {
        fields: compact.fields,
        note:
          'THIS OBJECT IS NOT ONE OF THE ONES THE DEFAULT KNOWS, so the rows below show its own ' +
          'first few fields instead. That choice is arbitrary, not a judgement about which ' +
          'fields matter — name the ones you want in `fields`, or pass "*".',
      }
    : { fields: compact.fields };
}
