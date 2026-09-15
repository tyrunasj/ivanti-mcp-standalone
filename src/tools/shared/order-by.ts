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
    // An EMPTY clause used to be skipped, which quietly let the degenerate strings through — a
    // trailing comma is the commonest way a generated list ends, and both callers send the
    // caller's raw string rather than a re-join of what was validated here. Whatever Ivanti makes
    // of `Priority asc,` it is not a sort it checked, and the tools then report the result under
    // zeroNote's "THIS IS A REAL ZERO: the field and sort names were checked against the object
    // before the request" — an invariant this function would not have enforced.
    if (clause === '') {
      throw new FieldNameError(
        `'${orderBy}' has an empty sort clause — usually a stray or trailing comma. Ivanti does ` +
          'not reject a malformed sort; it answers with no rows, which is indistinguishable from ' +
          'a real empty result. Remove the comma.',
        [orderBy],
      );
    }

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

/**
 * One field name, checked against the object before it is interpolated anywhere.
 *
 * `group_count` takes a `groupBy` and puts it in a filter **as a field name**, unquoted — the
 * value beside it is quoted, the name is not. Nothing validated it, and when the caller supplies
 * `values` the pick-list walk that would otherwise have rejected an unknown field is skipped
 * entirely. So `groupBy: "Status ne 'zzz' or Status"` produced
 *
 *   Status ne 'zzz' or Status eq '<value>' and (ProfileLink_RecID eq '<their recid>')
 *
 * and OData binds `and` tighter than `or`, so the own-records constraint applied to only the
 * second disjunct. What escaped was counts rather than rows — the request sends `$top: 1` — but a
 * count is a working equality oracle over other people's records.
 *
 * Refusing the name locally is the same shape as `assertOrderBy` and `assertSupportedFilter`, and
 * for the same reason: Ivanti's answer to the malformed version is a successful-looking one.
 */
export function assertFieldName(name: string, entity: EntityMetadata, argument: string): void {
  const names = visibleFields(entity).map((field) => field.name);
  // Nothing to check against. `parseCsdl` drops field-less entity types — that is how a typo
  // arrives — so an entity that reaches here with no visible fields is a narrow fixture rather
  // than a tenant, and refusing every name would be inventing an answer we do not have.
  if (names.length === 0) return;
  if (names.some((known) => known.toLowerCase() === name.trim().toLowerCase())) return;

  const close = suggestNames(name, names, 3);
  throw new FieldNameError(
    `${entity.name} has no field named '${name}', so \`${argument}\` cannot use it` +
      (close.length > 0 ? ` (did you mean: ${close.join(', ')}?)` : '') +
      '. Call get_object_metadata with a `search` for the right name.',
    [name],
  );
}
