// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { entityFixture, field } from '../../ivanti/connection.fixture.js';
import { rowFields } from './row-fields.js';

const INCIDENT = entityFixture('incident');
const TICKET = { RecId: 'a', IncidentNumber: 1, Subject: 'Printer', Status: 'Active', Symptom: 'x' };

describe('rowFields', () => {
  it('means everything by "*", not a field called "*"', () => {
    expect(rowFields([TICKET], '*', INCIDENT)).toEqual({ fields: undefined });
  });

  it('takes the caller’s list as given', () => {
    expect(rowFields([TICKET], 'Subject, Symptom', INCIDENT)).toEqual({
      fields: ['Subject', 'Symptom'],
    });
  });

  it('keeps the preference list where it fits, and says nothing', () => {
    const shown = rowFields([TICKET], undefined, INCIDENT);

    expect(shown.fields).toContain('Subject');
    expect(shown.fields).not.toContain('Symptom');
    expect(shown.note).toBeUndefined();
  });

  it('falls back to the rows’ own fields where it does not, and says so', () => {
    const workOrder = entityFixture('workorder', { fields: [field('RecId'), field('WorkOrderRef')] });

    const shown = rowFields([{ RecId: 'w1', WorkOrderRef: 'WO-7', Summary: 'x' }], undefined, workOrder);

    expect(shown.fields).toEqual(expect.arrayContaining(['WorkOrderRef', 'Summary']));
    expect(shown.note).toContain('NOT ONE OF THE ONES THE DEFAULT KNOWS');
  });
});
