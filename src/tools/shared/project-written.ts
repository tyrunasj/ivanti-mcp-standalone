// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { ALL_FIELDS, COMPACT_ROW_FIELDS } from '../../ivanti/odata/compact-fields.js';
import { parseFieldList, projectRow } from '../../ivanti/odata/projection.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';

/**
 * What a write hands back, which used to be everything.
 *
 * `create_record` and `update_record` returned the confirmed record whole — ~180 fields and about
 * 10 KB of JSON per call, measured — while `list_records` has defaulted to a compact set since
 * B2 precisely because a page of full records costs a context window. The write path was simply
 * missed. The values have already been verified by `confirmWrite` before this runs, so the
 * confirmation exists to show the caller what happened, not to re-transmit the row.
 *
 * The default is the fields that were WRITTEN plus the compact identifying set: the caller sees
 * exactly what they changed, confirmed in the record's own words, alongside enough to say which
 * record it was. `"*"` restores the whole thing.
 */
export function projectWritten(
  record: OdataRecord | undefined,
  returnFields: string | undefined,
  written: readonly string[],
): OdataRecord | undefined {
  if (record === undefined) return undefined;
  if (returnFields?.trim() === ALL_FIELDS) return record;

  const asked = parseFieldList(returnFields);
  const fields = asked ?? [...new Set([...COMPACT_ROW_FIELDS, ...written])];
  return projectRow(record, fields);
}
