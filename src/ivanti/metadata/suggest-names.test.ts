// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { editDistance, suggestNames, toStem } from './suggest-names.js';

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

  it('finds a slip of the fingers, which neither contains the real name nor is contained by it', () => {
    expect(suggestNames('Incidnet', ['incident', 'ci', 'change'])).toEqual(['incident']);
    expect(suggestNames('Sympton', FIELDS)).toEqual(['Symptom']);
  });

  it('does not offer a short name just because it occurs inside the guess', () => {
    // `ci` is a real object — and two letters of `Incidnet`, which is not a reason to suggest it.
    expect(suggestNames('Incidnet', ['ci'])).toEqual([]);
  });

  it('keeps a real piece of the name ahead of a slip', () => {
    expect(suggestNames('Status', ['StatusReason', 'Statux'])).toEqual(['StatusReason', 'Statux']);
  });

  it('allows one slip in a short name and two in a longer one, and none in two letters', () => {
    expect(suggestNames('Ownr', ['Owner'])).toEqual(['Owner']);
    expect(suggestNames('Ownr', ['Owners'])).toEqual([]);
    expect(suggestNames('Subjcet', ['Subject'])).toEqual(['Subject']);
    expect(suggestNames('ab', ['ac'])).toEqual([]);
  });
});

describe('editDistance', () => {
  it('counts an adjacent transposition as one edit', () => {
    expect(editDistance('incidnet', 'incident', 2)).toBe(1);
    expect(editDistance('kitten', 'sitting', 3)).toBe(3);
  });

  it('gives up when the lengths alone are too far apart', () => {
    expect(editDistance('a', 'abcdef', 2)).toBe(3);
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
