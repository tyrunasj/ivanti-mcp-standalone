// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { IvantiApiError } from '../../ivanti/http/errors.js';
import { visibleFields, type EntityMetadata } from '../../ivanti/metadata/csdl.js';
import { suggestNames } from '../../ivanti/metadata/suggest-names.js';

/**
 * A field name the caller got wrong. Typed so it is reported as a rejection the caller can fix,
 * rather than logged as a failure of the server.
 */
export class FieldNameError extends Error {
  readonly fields: string[];

  constructor(message: string, fields: string[]) {
    super(message);
    this.name = 'FieldNameError';
    this.fields = fields;
  }
}

/** How Ivanti phrases "that is not a field", across its surfaces. */
const FIELD_ERROR = /no such entry exists|could not find a property|invalid property/i;

/**
 * Turns Ivanti's generic refusal into one that names the field that was wrong.
 *
 * Ivanti answers a mistyped field with `400 ISM_4000 "No such entry exists"` and does not say
 * which token it disliked — the same code it uses for a missing record. The fields are already
 * known here, so the caller can be told what to use instead and recover in one retry rather
 * than by guessing.
 */
export function explainFieldError(
  error: unknown,
  entity: EntityMetadata,
  referenced: readonly string[],
): FieldNameError | undefined {
  if (!(error instanceof IvantiApiError)) return undefined;
  if (error.status !== 400 || !FIELD_ERROR.test(error.body)) return undefined;

  const fields = visibleFields(entity).map((field) => field.name);
  const known = new Set(fields.map((name) => name.toLowerCase()));
  const unknown = referenced.filter((name) => !known.has(name.toLowerCase()));
  if (unknown.length === 0) return undefined;

  const explained = unknown.map((name) => {
    const close = suggestNames(name, fields, 3);
    return close.length > 0 ? `'${name}' (did you mean: ${close.join(', ')}?)` : `'${name}'`;
  });

  return new FieldNameError(
    `${entity.name} has no field named ${explained.join(', ')}. ` +
      `It has ${String(fields.length)} fields — call get_object_metadata with a \`search\` to find ` +
      'the right name. Ivanti reports this as a bad request, not as an empty result.',
    unknown,
  );
}
