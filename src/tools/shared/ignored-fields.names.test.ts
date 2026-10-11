// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { ALL_FIELDS } from '../../ivanti/odata/compact-fields.js';
import { ignoredFieldNames, ignoredFieldsNote } from './ignored-fields.js';

describe('ignoredFieldNames', () => {
  const rows = [{ RecId: 'a', Subject: 's' }, { RecId: 'b', Status: 'Active' }];

  it('names requested fields no row carries, case-insensitively', () => {
    expect(ignoredFieldNames(rows, ['subject', 'ApprovalStatus', 'status'])).toEqual(['ApprovalStatus']);
  });

  it('is judged across rows: present on any one is present', () => {
    expect(ignoredFieldNames(rows, ['Status'])).toEqual([]);
  });

  it('says nothing for no rows, no request, the all-fields marker or a blank', () => {
    expect(ignoredFieldNames([], ['X'])).toEqual([]);
    expect(ignoredFieldNames(rows, undefined)).toEqual([]);
    expect(ignoredFieldNames(rows, [ALL_FIELDS, ''])).toEqual([]);
  });
});

describe('ignoredFieldsNote', () => {
  it('warns that a missing key is not an empty value, singular and plural', () => {
    expect(ignoredFieldsNote(['A'])).toContain('named A, so it was left out');
    expect(ignoredFieldsNote(['A', 'B'])).toContain('named A, B, so they were left out');
    expect(ignoredFieldsNote(['A'])).toContain('A MISSING KEY IS NOT AN EMPTY VALUE');
  });
});
