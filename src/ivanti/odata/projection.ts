// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { OdataRecord } from './response.js';

/**
 * Client-side field projection.
 *
 * `$select` cannot be delegated to Ivanti: on a single-record GET it answers **200 with only
 * `@odata.context`** — 182 fields become none — and on saved searches it keeps every key and
 * blanks the values. Measured live. So the server always asks for the whole record and narrows
 * it here, which also means a requested field the entity lacks is simply absent rather than an
 * error.
 */
export interface ProjectOptions {
  /**
   * Also drop null, empty-string and false values. **Never drops 0**: a free catalogue item
   * (Price 0) and a first form field (SequenceNum 0) are real data, and a plain falsy test
   * would silently delete both.
   */
  dropEmpty?: boolean;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === false;
}

/** Keeps only the named fields. A row that matches none of them is returned whole. */
export function projectRow(
  row: OdataRecord,
  fields: readonly string[],
  options: ProjectOptions = {},
): OdataRecord {
  const projected: OdataRecord = {};

  // Case-insensitively, against the row's own keys, and emitting the ROW's spelling.
  //
  // This used to be `field in row`, which is case-sensitive, while `ignoredFieldNames` compares
  // lowercased — so a name whose casing was wrong was dropped from every row AND left out of
  // `ignoredFields`, which is precisely the pair of outcomes that machinery exists to prevent.
  // Ivanti spells keys both ways (`RecId`, but `ProfileLink_RecID`), so a model normalising
  // casing is routine rather than careless: `fields: "ProfileLink_RecId, subject"` returned rows
  // carrying only RecId, with nothing saying anything had been left out.
  const byLowercase = new Map(Object.keys(row).map((key) => [key.toLowerCase(), key]));

  for (const field of fields) {
    const key = field in row ? field : byLowercase.get(field.toLowerCase());
    if (key === undefined) continue;
    if (options.dropEmpty === true && isEmpty(row[key])) continue;
    projected[key] = row[key];
  }

  // Returning an empty object would look like a record with no data; the caller asked for fields
  // this entity does not have, and the row itself is the more useful answer.
  return Object.keys(projected).length > 0 ? projected : row;
}

/**
 * The identifier every other tool needs, kept whether or not it was asked for.
 *
 * Naming `fields` used to drop `RecId`, so a caller who narrowed the columns got rows they could
 * not then read, update, annotate or delete — the id is the only handle the record tools take,
 * and nothing in the answer carried it. Adding it back costs one key per row and removes a
 * whole round trip.
 */
const ALWAYS = 'RecId';

export function projectRows(
  rows: readonly OdataRecord[],
  fields: readonly string[] | undefined,
  options: ProjectOptions = {},
): OdataRecord[] {
  if (fields === undefined || fields.length === 0) return [...rows];
  const withId = fields.includes(ALWAYS) ? fields : [ALWAYS, ...fields];
  return rows.map((row) => projectRow(row, withId, options));
}

/** Splits a comma-separated field list, tolerating the spaces a caller will include. */
export function parseFieldList(select: string | undefined): string[] | undefined {
  if (select === undefined) return undefined;
  const fields = select
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field !== '');
  return fields.length > 0 ? fields : undefined;
}
