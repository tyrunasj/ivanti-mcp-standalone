import { describe, expect, it } from 'vitest';
import {
  ALL_FIELDS,
  COMPACT_ROW_FIELDS,
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
      compactMissedObject(['RecId', 'IncidentNumber', 'Subject', 'CreatedDateTime']),
    ).toBeUndefined();
  });

  it('names the usable fields when the compact set matched only audit columns', () => {
    // Measured: `attachment` shares none of the ticket field names, so the rows came back as a
    // RecId and two timestamps and one row was indistinguishable from the next.
    const missed = compactMissedObject([
      'RecId',
      'CreatedDateTime',
      'CreatedBy',
      'LastModDateTime',
      'ATTACHNAME',
      'AttachmentSize',
    ]);

    expect(missed).toEqual(['ATTACHNAME', 'AttachmentSize']);
  });
});
