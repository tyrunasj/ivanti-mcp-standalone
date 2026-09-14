// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { OdataRecord } from '../../ivanti/odata/response.js';

/**
 * Names worth TRYING first, from the Business Objects Ivanti ships.
 *
 * None of these is guaranteed: a tenant defines its own Business Objects and renames fields on
 * the shipped ones, so a record whose number is `WorkOrderRef` and whose subject is `Summary`
 * matches nothing here. Every list below is therefore a preference, and each function falls back
 * to reading the row itself rather than reporting "Untitled record" about a record that is
 * perfectly well named.
 */
const IDENTIFIERS = [
  'IncidentNumber',
  'ServiceReqNumber',
  'ChangeNumber',
  'ProblemNumber',
  'AssignmentID',
  'Name',
  'DisplayName',
];

/** The first of these a record has is its one-line summary. */
const TITLES = ['Subject', 'Name', 'DisplayName', 'Title'];

/** Fields worth showing as context under a search hit, in order. */
const SUMMARY_FIELDS = ['Status', 'Priority', 'Owner', 'OwnerTeam', 'CreatedDateTime'];

/** Columns every object carries, which say nothing about which record this is. */
const AUDIT = new Set(
  ['recid', 'createddatetime', 'createdby', 'lastmoddatetime', 'lastmodby', 'readonly'].map((n) =>
    n.toLowerCase(),
  ),
);

/** How much of an unrecognised field's value is worth putting in a one-line title. */
const TITLE_MAX = 80;

/**
 * The row's own first meaningful text, for an object none of the lists above knows.
 *
 * Short values only: a description or an HTML body is not a title, and a GUID identifies nothing
 * a person would recognise.
 */
function firstOwnText(row: OdataRecord, skip: readonly string[] = []): string | undefined {
  const skipped = new Set([...skip.map((name) => name.toLowerCase())]);
  for (const [field, value] of Object.entries(row)) {
    if (AUDIT.has(field.toLowerCase()) || skipped.has(field.toLowerCase())) continue;
    if (field.endsWith('_RecID') || field.endsWith('_Valid') || field.endsWith('_Category')) continue;
    if (typeof value === 'number') return `${field}: ${String(value)}`;
    if (typeof value === 'string' && value.trim() !== '' && value.length <= TITLE_MAX) {
      return `${field}: ${value}`;
    }
  }
  return undefined;
}

function firstString(row: OdataRecord, candidates: readonly string[]): string | undefined {
  for (const field of candidates) {
    const value = row[field];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

/**
 * The id the `fetch` tool takes back: which object, and which record in it.
 *
 * A RecId alone is not enough — Ivanti keys are unique per object, not per tenant, and nothing
 * in a RecId says what it belongs to.
 */
export function encodeRecordId(entitySet: string, recId: string): string {
  return `${entitySet}:${recId}`;
}

export function decodeRecordId(id: string): { entitySet: string; recId: string } | undefined {
  const separator = id.lastIndexOf(':');
  if (separator <= 0 || separator === id.length - 1) return undefined;
  return { entitySet: id.slice(0, separator), recId: id.slice(separator + 1) };
}

/** A record's own key, when it has one. RecId is always a string in practice, never a number. */
export function recordRecId(row: OdataRecord): string | undefined {
  const recId = row['RecId'];
  return typeof recId === 'string' && recId !== '' ? recId : undefined;
}

/** A one-line title for a search hit: the number and the subject, whichever exist. */
export function recordTitle(row: OdataRecord): string {
  const identifier = firstString(row, IDENTIFIERS);
  const title = firstString(row, TITLES);

  if (identifier !== undefined && title !== undefined && identifier !== title) {
    return `#${identifier} ${title}`;
  }
  if (title !== undefined) return title;
  if (identifier !== undefined) return `#${identifier}`;
  // Nothing on the preference lists — which on a tenant's own Business Object is the normal
  // case, not an error. Read the row rather than calling a well-named record untitled.
  return firstOwnText(row) ?? 'Untitled record';
}

/** The context line under a hit: enough to choose between two similar records. */
export function recordSummary(row: OdataRecord): string {
  const parts: string[] = [];
  for (const field of SUMMARY_FIELDS) {
    const value = row[field];
    if (typeof value === 'string' && value.trim() !== '') parts.push(`${field}: ${value}`);
    else if (typeof value === 'number') parts.push(`${field}: ${String(value)}`);
  }
  if (parts.length > 0) return parts.join(' · ');

  // An object with none of the shipped status/owner fields still has fields of its own, and an
  // empty context line makes two hits impossible to tell apart.
  return firstOwnText(row, [...IDENTIFIERS, ...TITLES]) ?? '';
}
