// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import {
  ALL_FIELDS,
  COMPACT_ROW_FIELDS,
  compactFieldsFor,
  resolveRowFields,
} from './compact-fields.js';

describe('resolveRowFields', () => {
  it('defaults to the compact set — a page of whole records is 187,000 characters', () => {
    expect(resolveRowFields(undefined, undefined)).toEqual({
      fields: COMPACT_ROW_FIELDS,
      defaulted: true,
    });
  });

  it('honours an explicit list', () => {
    expect(resolveRowFields(['Subject'], 'Subject')).toEqual({
      fields: ['Subject'],
      defaulted: false,
    });
  });

  it('returns whole records only when the caller says so outright', () => {
    expect(resolveRowFields(undefined, ALL_FIELDS)).toEqual({ fields: undefined, defaulted: false });
    expect(resolveRowFields(['*'], ' * ')).toEqual({ fields: undefined, defaulted: false });
  });
});

describe('compactFieldsFor', () => {
  it('names the populated fields the fallback left out, and only those', () => {
    // An object that shares none of the ticket names, with more populated columns than are shown.
    const row: Record<string, unknown> = { RecId: 'r1', Empty: null };
    for (let i = 1; i <= 12; i += 1) row[`Col${String(i)}`] = i;

    const { fields, fellBack, rest } = compactFieldsFor([row]);

    expect(fellBack).toBe(true);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest).not.toContain('Empty');
    for (const name of rest) expect(fields).not.toContain(name);
  });

  it('treats a present-but-null ticket column as no match at all', () => {
    // The audit case, measured: `audit_incident` HAS Subject/Status/Owner as columns and every
    // one is null, so eight real rows came back looking blank while their actual content was
    // never requested.
    const auditRow = {
      RecId: 'a1',
      Subject: null,
      Status: null,
      Owner: null,
      OwnerTeam: null,
      AuditHistoryDescription: '[Status] changed from [Active] to [Closed]',
      AuditHistoryUser: 'JSmith',
    };

    const { fields, fellBack } = compactFieldsFor([auditRow]);
    expect(fellBack).toBe(true);
    expect(fields).toContain('AuditHistoryDescription');
    expect(fields).toContain('AuditHistoryUser');
  });

  it('keeps the preference list when the values are real', () => {
    const { fields, fellBack } = compactFieldsFor([
      { RecId: 'r1', IncidentNumber: 10244, Subject: 'Printer', Status: 'Active' },
    ]);

    expect(fellBack).toBe(false);
    expect(fields).toEqual(expect.arrayContaining(['IncidentNumber', 'Subject', 'Status']));
  });
});
