// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { entityFixture, field } from '../../ivanti/connection.fixture.js';
import { COMPACT_FELL_BACK_NOTE, compactRows } from './compact-rows.js';

const INCIDENT = entityFixture('incident');
const TICKET = { RecId: 'a', IncidentNumber: 1, Subject: 'Printer', Status: 'Active', Symptom: 'x' };

describe('compactRows', () => {
  it('means everything by "*", not a field called "*"', () => {
    expect(compactRows([TICKET], '*', INCIDENT)).toEqual({ fields: undefined, defaulted: false });
  });

  it('takes the caller’s list as given', () => {
    expect(compactRows([TICKET], 'Subject, Symptom', INCIDENT)).toEqual({
      fields: ['Subject', 'Symptom'],
      defaulted: false,
    });
  });

  it('keeps the preference list where it fits, and says nothing', () => {
    const shown = compactRows([TICKET], undefined, INCIDENT);

    expect(shown.fields).toContain('Subject');
    expect(shown.fields).not.toContain('Symptom');
    expect(shown.defaulted).toBe(true);
    expect(shown.note).toBeUndefined();
    expect(shown.otherFields).toBeUndefined();
  });

  it('falls back to the rows’ own fields where it does not, and says so', () => {
    const workOrder = entityFixture('workorder', { fields: [field('RecId'), field('WorkOrderRef')] });

    const shown = compactRows(
      [{ RecId: 'w1', WorkOrderRef: 'WO-7', Summary: 'x' }],
      undefined,
      workOrder,
    );

    expect(shown.fields).toEqual(expect.arrayContaining(['WorkOrderRef', 'Summary']));
    expect(shown.note).toBe(COMPACT_FELL_BACK_NOTE);
  });

  it('decides the note and the projection from the one answer, extras included', () => {
    // Two fields the preference list does not know, offered by the schema as required/validated:
    // the default FITS them. The note used to come from a predicate that ignored the schema and
    // announced "not one of the ones the default knows" over ordinary compact rows.
    const workOrder = entityFixture('workorder', {
      fields: [
        field('RecId'),
        field('Status', { validated: true }),
        field('WorkOrderRef', { nullable: false }),
      ],
    });
    const rows = [{ RecId: 'w1', Status: 'Open', WorkOrderRef: 'WO-7' }];

    const shown = compactRows(rows, undefined, workOrder);

    expect(shown.fields).toEqual(expect.arrayContaining(['Status', 'WorkOrderRef']));
    expect(shown.note).toBeUndefined();
    expect(shown.otherFields).toBeUndefined();
  });

  it('names only the populated fields the fallback left out', () => {
    const row: Record<string, unknown> = { RecId: 'w1', Blank: null };
    for (let i = 1; i <= 12; i += 1) row[`Col${String(i)}`] = i;

    const shown = compactRows([row], undefined);

    expect(shown.note).toBe(COMPACT_FELL_BACK_NOTE);
    expect(shown.otherFields?.length).toBeGreaterThan(0);
    expect(shown.otherFields).not.toContain('Blank');
    for (const name of shown.otherFields ?? []) expect(shown.fields).not.toContain(name);
  });
});
