// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { visibleFields, type EntityMetadata } from '../../ivanti/metadata/csdl.js';
import { suggestNames } from '../../ivanti/metadata/suggest-names.js';
import { FieldNameError } from './explain-field-error.js';

/**
 * `$orderby`, checked here because Ivanti will not check it and will not complain.
 *
 * A mistyped **filter** field answers `400 ISM_4000`, which `explainFieldError` turns into a
 * named, suggestible rejection. A mistyped **orderBy** field answers **204 No Content** — and so
 * does a mistyped direction. Measured live on `incidents`:
 *
 * | `$orderby` | answer |
 * |---|---|
 * | *(omitted)* | 200, `@odata.count` 548 |
 * | `CreatedDateTime asc` | 200, `@odata.count` 548 |
 * | `CreatedDate asc` | **204** |
 * | `NotAFieldAtAll asc` | **204** |
 * | `CreatedDateTime bogus` | **204** |
 *
 * 204 is one of Ivanti's three encodings for "no rows", so 548 records become `returned: 0` with
 * no error anywhere. A tester lost an answer to exactly this: `CreatedDate` instead of
 * `CreatedDateTime` turned 85 open incidents into none, and the tool's own wording then told them
 * to report it as a visibility problem rather than a typo. One missing `Time`.
 *
 * So this runs *before* the request, like `assertSupportedFilter` — the only defence against a
 * failure that arrives dressed as a successful empty answer.
 */

/** `Field`, `Field asc`, `Field desc` — case-insensitive, comma-separated. All verified live. */
const CLAUSE = /^(?<field>[A-Za-z_][A-Za-z0-9_]*)(?:\s+(?<direction>asc|desc))?$/i;

export function assertOrderBy(orderBy: string | undefined, entity: EntityMetadata): void {
  if (orderBy === undefined || orderBy.trim() === '') return;

  const names = visibleFields(entity).map((field) => field.name);
  const known = new Map(names.map((name) => [name.toLowerCase(), name]));

  for (const raw of orderBy.split(',')) {
    const clause = raw.trim();
    if (clause === '') continue;

    const parsed = CLAUSE.exec(clause);
    if (parsed?.groups === undefined) {
      throw new FieldNameError(
        `'${clause}' is not a valid sort clause. Use \`Field\`, \`Field asc\` or \`Field desc\`, ` +
          'separated by commas. Ivanti answers anything else with an empty result rather than an ' +
          'error, so this is refused here instead.',
        [clause],
      );
    }

    const { field } = parsed.groups;
    if (field === undefined || known.has(field.toLowerCase())) continue;

    const close = suggestNames(field, names, 3);
    throw new FieldNameError(
      `${entity.name} has no field named '${field}', so it cannot be sorted by it` +
        (close.length > 0 ? ` (did you mean: ${close.join(', ')}?)` : '') +
        '. Ivanti answers an unknown sort field with NO ROWS rather than an error — the records ' +
        'are there; the sort name is wrong. Call get_object_metadata with a `search` for the ' +
        'right name.',
      [field],
    );
  }
}
