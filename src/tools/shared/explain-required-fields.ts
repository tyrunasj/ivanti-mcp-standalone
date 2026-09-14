// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { IvantiApiError } from '../../ivanti/http/errors.js';
import type { ResolvedForm } from '../../ivanti/session/form-context.js';

/**
 * Ivanti's required-field refusal, which names the **display** name.
 *
 * `Required field Incident.Description value must be provided` means the field `Symptom`; a
 * caller who takes the message literally writes a field that does not exist. Worse, `Customer`
 * is not a field at all — it is a link, written as a `_RecID` plus a `_Category`.
 *
 * Both translations are **per object**, which is why they come from that object's form rather
 * than a table: "Description" is `Symptom` on an incident and a service request, `Description` on
 * a change, and `Details` on a knowledge article; "Customer" labels `ProfileLink` on an incident
 * while the same field is "Contact Link" on a service request.
 *
 * These rules are also conditional: moving an incident to Active requires Category and Owner,
 * which nothing asks for while it is Logged.
 */
const REQUIRED_FIELD = /Required field [\w#]+\.([\w#]+) value must be provided/gi;

export class RequiredFieldsError extends Error {
  readonly fields: string[];

  constructor(message: string, fields: string[]) {
    super(message);
    this.name = 'RequiredFieldsError';
    this.fields = fields;
  }
}

/** How the caller should set one required thing, once its display name is resolved. */
function describe(displayName: string, form: ResolvedForm | undefined): string {
  const field = form?.displayNames[displayName.toLowerCase()] ?? displayName;
  const idField = form?.linkFields[field];

  if (idField !== undefined) {
    const base = idField.replace(/_RecID$/i, '');
    return (
      `${displayName} — a link, not a text field: set \`${idField}\` to the target record's RecId ` +
      `and \`${base}_Category\` to the object it lives in (for example "Employee")`
    );
  }

  return field === displayName ? `\`${field}\`` : `${displayName} — the field is \`${field}\``;
}

/**
 * Turns a required-field refusal into instructions, or returns undefined when the failure was
 * something else.
 */
export function explainRequiredFields(
  error: unknown,
  form: ResolvedForm | undefined,
): RequiredFieldsError | undefined {
  if (!(error instanceof IvantiApiError)) return undefined;

  const names = [...error.body.matchAll(REQUIRED_FIELD)].map((match) => match[1] ?? '');
  const unique = [...new Set(names.filter((name) => name !== ''))];
  if (unique.length === 0) return undefined;

  return new RequiredFieldsError(
    `Ivanti refused the write: it requires ${unique.map((name) => describe(name, form)).join('; ')}. ` +
      'Nothing was written. These rules are conditional — a status change can require fields that ' +
      'nothing asked for before — so set them in the same call.',
    unique,
  );
}
