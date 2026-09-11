import { describe, expect, it } from 'vitest';
import { suggestNames, toStem } from './suggest-names.js';

const FIELDS = ['CIType', 'LastAuditType', 'Symptom', 'Subject', 'Status', 'OwnerTeam'];

describe('suggestNames', () => {
  it('finds the real name a guess is contained in', () => {
    expect(suggestNames('Type', FIELDS)).toEqual(['CIType', 'LastAuditType']);
  });

  it('prefers the closest in length among equally placed matches', () => {
    expect(suggestNames('Type', FIELDS)[0]).toBe('CIType');
  });

  it('finds a name contained in an over-long guess', () => {
    expect(suggestNames('SubjectLine', FIELDS)).toContain('Subject');
  });

  it('returns nothing when nothing is close, rather than noise', () => {
    expect(suggestNames('Elephant', FIELDS)).toEqual([]);
  });

  it('ignores an exact match — that was never the problem', () => {
    expect(suggestNames('Status', FIELDS)).not.toContain('Status');
  });

  it('respects the limit', () => {
    expect(suggestNames('t', FIELDS, 2)).toHaveLength(2);
  });

  it('is empty for an empty attempt', () => {
    expect(suggestNames('', FIELDS)).toEqual([]);
  });
});

describe('toStem', () => {
  it('strips the English plural that is usually the mistake', () => {
    expect(toStem('Categories')).toBe('Categor');
    expect(toStem('Incidents')).toBe('Incident');
    expect(toStem('Statuses')).toBe('Status');
  });

  it('leaves a name with no plural ending alone', () => {
    expect(toStem('Incident')).toBe('Incident');
  });
});
