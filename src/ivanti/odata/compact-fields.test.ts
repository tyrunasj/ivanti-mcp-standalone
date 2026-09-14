// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import {
  ALL_FIELDS,
  COMPACT_ROW_FIELDS,
  compactFieldsFor,
  compactMissedObject,
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

describe('compactMissedObject', () => {
  it('says nothing when the compact set identifies the object', () => {
    expect(
      compactMissedObject([
        { RecId: 'r1', IncidentNumber: 10244, Subject: 'Printer', CreatedDateTime: 'x' },
      ]),
    ).toBeUndefined();
  });

  it('names the usable fields when the compact set matched only audit columns', () => {
    // Measured: `attachment` shares none of the ticket field names, so the rows came back as a
    // RecId and two timestamps and one row was indistinguishable from the next.
    const missed = compactMissedObject([
      {
        RecId: 'r1',
        CreatedDateTime: 'x',
        CreatedBy: 'y',
        LastModDateTime: 'z',
        ATTACHNAME: 'plan.doc',
        AttachmentSize: 489,
      },
    ]);

    expect(missed).toEqual(['ATTACHNAME', 'AttachmentSize']);
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

    expect(compactMissedObject([auditRow])).toContain('AuditHistoryDescription');

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
