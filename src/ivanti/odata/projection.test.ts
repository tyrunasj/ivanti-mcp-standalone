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
