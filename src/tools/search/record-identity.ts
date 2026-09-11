import type { OdataRecord } from '../../ivanti/odata/response.js';

/** The first of these a record has is its human-facing number. */
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
  return title ?? (identifier === undefined ? 'Untitled record' : `#${identifier}`);
}

/** The context line under a hit: enough to choose between two similar records. */
export function recordSummary(row: OdataRecord): string {
  const parts: string[] = [];
  for (const field of SUMMARY_FIELDS) {
    const value = row[field];
    if (typeof value === 'string' && value.trim() !== '') parts.push(`${field}: ${value}`);
    else if (typeof value === 'number') parts.push(`${field}: ${String(value)}`);
  }
  return parts.join(' · ');
}
