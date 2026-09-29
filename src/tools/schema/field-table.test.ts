// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { field } from '../../ivanti/connection.fixture.js';
import { fieldRows, renderRows, rowMatches, type FieldFacts } from './field-table.js';

const NONE: FieldFacts = { labels: {}, sometimesRequired: new Set(), readOnly: new Set() };

describe('fieldRows', () => {
  it('folds a link only when all three of its fields are there', () => {
    // A tenant's own field that merely ends in `_RecID` is not a link without its siblings.
    const rows = fieldRows([field('Owner'), field('Owner_RecID'), field('TeamLink'), field('TeamLink_RecID'), field('TeamLink_Category')], NONE);

    expect(rows.map((row) => [row.name, row.type])).toEqual([
      ['Owner', 'String'],
      ['Owner_RecID', 'String'],
      ['TeamLink', 'link'],
    ]);
  });

  it('lets the absolute `required` stand for a link whose halves also carry a rule', () => {
    const rows = fieldRows(
      [field('ProfileLink'), field('ProfileLink_RecID', { nullable: false }), field('ProfileLink_Category')],
      { ...NONE, sometimesRequired: new Set(['ProfileLink', 'ProfileLink_Category']) },
    );

    expect(rows[0]?.flags).toEqual(['required']);
  });

  it('takes a link label from whichever half the form labels', () => {
    const rows = fieldRows([field('SLALink'), field('SLALink_RecID'), field('SLALink_Category')], {
      ...NONE,
      labels: { SLALink: 'Service level', SLALink_RecID: 'SLALink_RecID' },
    });

    // The `_RecID` label only repeats the name, so the next half's is used.
    expect(rows[0]?.label).toBe('Service level');
  });
});

describe('rowMatches', () => {
  it('finds a link by any of its names, and a field by its label', () => {
    const [link] = fieldRows([field('ProfileLink'), field('ProfileLink_RecID'), field('ProfileLink_Category')], NONE);
    const [subject] = fieldRows([field('Symptom')], { ...NONE, labels: { Symptom: 'Description' } });

    expect(link !== undefined && rowMatches(link, 'LINK_CATEGORY')).toBe(true);
    expect(subject !== undefined && rowMatches(subject, 'descr')).toBe(true);
    expect(subject !== undefined && rowMatches(subject, 'owner')).toBe(false);
  });
});

describe('renderRows', () => {
  it('writes a header, drops trailing empty cells, and keeps a `|` in a label from splitting it', () => {
    const rows = fieldRows([field('Subject'), field('Status', { validated: true })], {
      ...NONE,
      labels: { Status: 'State | Stage' },
    });

    expect(renderRows(rows)).toBe(['name|type|label|flags', 'Subject|String', 'Status|String|State / Stage|validated'].join('\n'));
  });
});
