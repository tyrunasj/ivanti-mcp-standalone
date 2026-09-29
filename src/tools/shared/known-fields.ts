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
    const near = suggestNames(name, names, 3);
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
