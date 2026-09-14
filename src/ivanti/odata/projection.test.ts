// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { parseFieldList, projectRow, projectRows } from './projection.js';

const ROW = { RecId: 'a', IncidentNumber: 10244, Subject: 'Wi-Fi', Owner: '', Price: 0 };

describe('projectRow', () => {
  it('keeps only the named fields', () => {
    expect(projectRow(ROW, ['RecId', 'Subject'])).toEqual({ RecId: 'a', Subject: 'Wi-Fi' });
  });

  it('ignores a field the entity does not have rather than erroring', () => {
    expect(projectRow(ROW, ['RecId', 'NotAField'])).toEqual({ RecId: 'a' });
  });

  it('returns the row whole when it matches no requested field', () => {
    expect(projectRow(ROW, ['Nothing', 'Matches'])).toBe(ROW);
  });

  it('drops empties only when asked, and never drops zero', () => {
    expect(projectRow(ROW, ['Owner', 'Price'], { dropEmpty: true })).toEqual({ Price: 0 });
  });
});

describe('projectRows', () => {
  it('passes rows through untouched when no fields are named', () => {
    expect(projectRows([ROW], undefined)).toEqual([ROW]);
    expect(projectRows([ROW], [])).toEqual([ROW]);
  });

  it('projects every row', () => {
    expect(projectRows([ROW, ROW], ['RecId'])).toEqual([{ RecId: 'a' }, { RecId: 'a' }]);
  });
});

describe('parseFieldList', () => {
  it('splits and trims, tolerating the spaces a caller will include', () => {
    expect(parseFieldList('RecId, Subject ,Status')).toEqual(['RecId', 'Subject', 'Status']);
  });

  it('is undefined for nothing meaningful, so the caller can skip projecting', () => {
    expect(parseFieldList(undefined)).toBeUndefined();
    expect(parseFieldList('  ,  ')).toBeUndefined();
  });
});

/**
 * Casing, and why it is not a cosmetic concern.
 *
 * `projectRow` matched with `field in row` — case-sensitive — while `ignoredFieldNames` compares
 * lowercased. A name with the wrong casing was therefore dropped from every row AND omitted from
 * `ignoredFields`: silently gone, and reported as not gone. Ivanti spells keys both ways on the
 * same record (`RecId`, but `ProfileLink_RecID`), so a model normalising casing is routine.
 *
 * `get_record`'s own description promises "Names the object does not have come back in
 * `ignoredFields` with a warning — never silently dropped", and the whole-row fallback made the
 * other half of it worse: nothing matched, so the caller got all ~180 fields of the record the
 * same description tells them to avoid.
 */
describe('projectRow is case-insensitive about the names it is given', () => {
  const row = { RecId: 'r1', Subject: 'Printer jam', ProfileLink_RecID: 'e1', Status: 'Active' };

  it.each([
    ['a lowercased name', 'subject', 'Subject'],
    ['an uppercased name', 'STATUS', 'Status'],
    ["Ivanti's own inconsistent id casing", 'ProfileLink_RecId', 'ProfileLink_RecID'],
  ])('resolves %s', (_label, asked, stored) => {
    const projected = projectRow(row, [asked]);

    // The ROW's spelling is what comes back, so the caller sees what Ivanti calls it.
    expect(projected).toEqual({ [stored]: row[stored as keyof typeof row] });
  });

  it('still returns the whole row when nothing matches at all', () => {
    expect(projectRow(row, ['NotAFieldAnywhere'])).toEqual(row);
  });

  it('keeps an exact match exact when both spellings are present', () => {
    const both = { Status: 'Active', status: 'lowercase one' };

    expect(projectRow(both, ['status'])).toEqual({ status: 'lowercase one' });
    expect(projectRow(both, ['Status'])).toEqual({ Status: 'Active' });
  });
});
