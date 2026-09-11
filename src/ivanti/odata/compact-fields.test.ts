import { describe, expect, it } from 'vitest';
import { ALL_FIELDS, COMPACT_ROW_FIELDS, resolveRowFields } from './compact-fields.js';

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
