// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { visibleFields, type EntityMetadata } from '../../ivanti/metadata/csdl.js';
import { suggestNames } from '../../ivanti/metadata/suggest-names.js';
import type { ResolvedForm } from '../../ivanti/session/form-context.js';

/**
 * Refuses a field the object does not have, before the write is sent.
 *
 * The schema is already in hand — `resolveObject` fetched it — and until now it was consulted only
 * in the CATCH, to explain a refusal Ivanti had already made. That is one round trip later than
 * necessary, and it left the tool description carrying the whole burden: "FIELD NAMES ARE NOT
 * GUESSABLE" is said in the manifest, in the server instructions, and was still not enough — this
 * guard exists because a caller wrote `Status` on an `externalcontact`, which has no such field,
 * having already fetched the 94 that it does have.
 *
 * Two kinds of wrong name, answered differently, because the fix differs:
 *
 * - a name that is nothing — answered with the nearest real fields;
 * - a name that is the tenant's LABEL for a real field — answered with the field it labels.
 *   `Description` is a label on an incident and the field is `Symptom`, and a caller told only
 *   "no such field" would reasonably conclude the object cannot hold a description.
 *
 * It never refuses on an empty field list. An unknown entity set makes Ivanti fabricate a
 * field-less entity type and return it as valid CSDL, and refusing every field of it would turn a
 * naming error into a wall of nonsense about fields that do not exist because the OBJECT does not.
 */
export function assertKnownFields(
  written: readonly string[],
  entity: EntityMetadata,
  form?: ResolvedForm,
): void {
  const fields = visibleFields(entity);
  if (fields.length === 0) return;

  const known = new Set(fields.map((field) => field.name.toLowerCase()));
  const unknown = written.filter((name) => !known.has(name.toLowerCase()));
  if (unknown.length === 0) return;

  const names = fields.map((field) => field.name);
  const explained = unknown.map((name) => {
    const labelled = form?.displayNames[name.toLowerCase()];
    if (labelled !== undefined) {
      return `\`${name}\` is what this tenant CALLS a field, not the field — write \`${labelled}\``;
    }
    const near = orTypos(suggestNames(name, names, 3), name, names);
    return near.length === 0
      ? `\`${name}\` is not a field on this object`
      : `\`${name}\` is not a field on this object — did you mean ${near.map((n) => `\`${n}\``).join(', ')}?`;
  });

  throw new FieldNotOnObjectError(
    `${explained.join('; ')}. Nothing was written. Call get_object_metadata for ${entity.name} ` +
      'rather than reusing a field name that worked on another object — they differ per object, ' +
      'and a tenant renames them.',
    unknown,
  );
}

/** Typed so it reads as a caller's mistake to fix, not as a failure of this server. */
export class FieldNotOnObjectError extends Error {
  readonly fields: string[];

  constructor(message: string, fields: string[]) {
    super(message);
    this.name = 'FieldNotOnObjectError';
    this.fields = fields;
  }
}

/**
 * A near-miss `suggestNames` cannot see, because it ranks by containment.
 *
 * That is right for an entity name — the wrong guess is usually a substring of the real one, which
 * is how `Type` reaches `CIType`. It is wrong for a typo: `Sympton` neither contains `Symptom` nor
 * is contained by it, so the field a caller obviously meant scored nothing and they were told only
 * that it does not exist. Distance is the second question, asked only when the first found nothing.
 */
function orTypos(found: string[], attempted: string, names: readonly string[]): string[] {
  if (found.length > 0) return found;

  // One transposition, insertion, deletion or substitution in a name of this length. Two is not
  // a typo any more, it is a different word, and suggesting one would be noise.
  const budget = attempted.length <= 4 ? 1 : 2;

  return names
    .map((name) => ({ name, distance: editDistance(attempted.toLowerCase(), name.toLowerCase()) }))
    .filter((entry) => entry.distance <= budget)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((entry) => entry.name);
}

/** Damerau-Levenshtein: adjacent transposition counts as one, because `Sympton` is one slip. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return Number.MAX_SAFE_INTEGER;

  const rows: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) rows[0]![j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      }
      rows[i]![j] = best;
    }
  }

  return rows[a.length]![b.length]!;
}
