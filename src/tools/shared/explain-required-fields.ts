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
  written: readonly string[] = [],
): RequiredFieldsError | undefined {
  if (!(error instanceof IvantiApiError)) return undefined;

  const names = [...error.body.matchAll(REQUIRED_FIELD)].map((match) => match[1] ?? '');
  const unique = [...new Set(names.filter((name) => name !== ''))];
  if (unique.length === 0) return undefined;

  return new RequiredFieldsError(
    `Ivanti refused the write: it requires ${unique.map((name) => describe(name, form)).join('; ')}. ` +
      'Nothing was written. These rules are conditional — a status change can require fields that ' +
      'nothing asked for before — so set them in the same call.' +
      alsoGoverned(unique, form, written),
    unique,
  );
}

/**
 * The rest of the fields a required rule governs, so the retry is one call rather than several.
 *
 * **A refusal names what Ivanti got as far as checking, which need not be all of it.** Measured on
 * this tenant: a create carrying only `Subject` was refused with three fields named, while one
 * carrying almost everything was refused with a single `Category` — so the caller cannot tell a
 * nearly-complete write from one that will fail again, and a refusal naming one field is not
 * evidence that one field is all that is missing. The form ships the whole list, so the first
 * refusal can carry it.
 *
 * It is offered as candidates and never as a requirement, because the form gives the fields a rule
 * governs and NOT the condition — several of these will not apply to the state this record is
 * heading for, and presenting them as required would trade one wrong certainty for another.
 */
function alsoGoverned(
  named: readonly string[],
  form: ResolvedForm | undefined,
  written: readonly string[],
): string {
  if (form === undefined || form.requiredRuleFields.length === 0) return '';

  const resolved = new Set(named.map((name) => (form.displayNames[name.toLowerCase()] ?? name).toLowerCase()));
  const already = new Set(written.map((name) => name.toLowerCase()));

  const rest = form.requiredRuleFields.filter(
    (field) => !resolved.has(field.toLowerCase()) && !already.has(field.toLowerCase()),
  );
  if (rest.length === 0) return '';

  return (
    ` This object has required rules on ${rest.map((field) => `\`${field}\``).join(', ')} as well, ` +
    'and a refusal names only what Ivanti checked before stopping — so being told about one is no ' +
    'evidence the rest are satisfied. Check these against the state you are writing before ' +
    'retrying, rather than discovering them a round trip at a time. Which of them actually apply ' +
    'depends on that state; the form does not say.'
  );
}
