// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { visibleFields, type EntityMetadata } from '../../ivanti/metadata/csdl.js';
import { suggestNames } from '../../ivanti/metadata/suggest-names.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import type { ResolvedForm } from '../../ivanti/session/form-context.js';
import { FieldNameError } from './explain-field-error.js';

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

/**
 * The write, keyed by the schema's own spelling of every field — or a refusal.
 *
 * `assertKnownFields` matches case-insensitively, and until this existed that was the whole of
 * it: the caller's spelling went on to everything after. Everything after looks names up
 * EXACTLY — the form's validated fields, the CSDL's `validated` flag, the read-back — so
 * `{ status: 'Bogus' }` passed the name check, matched no validated field, skipped the picklist
 * and the read-back both, and went out unresolved and unconfirmed while the tool reported
 * success. One name, two spellings, two different answers.
 *
 * So the spelling is settled HERE, once, before anything else reads it. Two keys that differ only
 * by case are refused rather than merged: the schema has the field once, and which of the two
 * values would land is not something this server gets to pick for the caller.
 */
export function knownFields(
  fields: OdataRecord,
  entity: EntityMetadata,
  form?: ResolvedForm,
): OdataRecord {
  assertKnownFields(Object.keys(fields), entity, form);

  const spelling = new Map(visibleFields(entity).map((field) => [field.name.toLowerCase(), field.name]));
  const canonical: OdataRecord = {};
  const seen = new Map<string, string[]>();

  for (const [name, value] of Object.entries(fields)) {
    const lower = name.toLowerCase();
    seen.set(lower, [...(seen.get(lower) ?? []), name]);
    // An empty schema keeps the caller's spelling — see `assertKnownFields` for why it is let
    // through at all.
    canonical[spelling.get(lower) ?? name] = value;
  }

  const clashes = [...seen.values()].filter((names) => names.length > 1);
  if (clashes.length > 0) {
    throw new FieldNameError(
      `${clashes.map((names) => names.map((name) => `\`${name}\``).join(' and ')).join('; ')} ` +
        `${clashes.length === 1 ? 'name' : 'each name'} ONE field — the object has it once, so ` +
        'which value would land is a guess. Nothing was written. Send each field once, spelled ' +
        'as get_object_metadata spells it.',
      clashes.flat(),
    );
  }

  return canonical;
}

/**
 * Typed so it reads as a caller's mistake to fix, not as a failure of this server.
 *
 * A `FieldNameError`, because that is the class `runTool` already treats as a refusal. Standing
 * alone it fell through to the catch-all, which logs the caller's typo at error level as a fault
 * of this server and counts it as one in the usage report.
 */
export class FieldNotOnObjectError extends FieldNameError {
  constructor(message: string, fields: string[]) {
    super(message, fields);
    this.name = 'FieldNotOnObjectError';
  }
}
