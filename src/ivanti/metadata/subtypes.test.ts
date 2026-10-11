// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { IvantiApiError } from '../http/errors.js';
import { describeSubtypes, findSubtypes, isBaseTypeRefusal } from './subtypes.js';

const NAMES = [
  'incident',
  'task',
  'task__assignment',
  'task__workorder',
  'taskcatalog',
  'ci',
  'ci__computer',
];

describe('findSubtypes', () => {
  it('takes a CSDL name as it is: a real trailing s is not a plural', () => {
    expect(findSubtypes(['ci__address', 'ci__address__x'], 'ci__address')).toEqual([
      { object: 'ci__address__x', entitySet: 'ci__address__xs' },
    ]);
  });

  it('finds the subtypes of a base type, with the set the record tools take', () => {
    // Lowercase, because that is how CSDL spells the name; the routes are case-insensitive.
    expect(findSubtypes(NAMES, 'task')).toEqual([
      { object: 'task__assignment', entitySet: 'task__assignments' },
      { object: 'task__workorder', entitySet: 'task__workorders' },
    ]);
  });

  it('does not mistake a name that merely starts the same way', () => {
    // `taskcatalog` is its own object, not a subtype of `task`.
    expect(findSubtypes(NAMES, 'task').map((s) => s.object)).not.toContain('taskcatalog');
  });

  it('is empty for an object with no subtypes', () => {
    expect(findSubtypes(NAMES, 'Incidents')).toEqual([]);
  });

  it('accepts any naming dialect', () => {
    expect(findSubtypes(NAMES, 'CI#')).toEqual([
      { object: 'ci__computer', entitySet: 'ci__computers' },
    ]);
  });
});

describe('describeSubtypes', () => {
  it('says what to create instead', () => {
    const sentence = describeSubtypes('task', findSubtypes(NAMES, 'task'));

    expect(sentence).toContain('will not create the base type');
    expect(sentence).toContain('task__assignments, task__workorders');
  });
});

describe('isBaseTypeRefusal', () => {
  const failure = (status: number, body: string) =>
    new IvantiApiError({ status, method: 'POST', url: 'tasks', body });

  it('is a 500 with nothing to say', () => {
    expect(isBaseTypeRefusal(failure(500, ''))).toBe(true);
    expect(isBaseTypeRefusal(failure(500, '  \n'))).toBe(true);
  });

  it('is not a timeout, a refusal, a 500 with a reason, or anything that is not Ivanti\'s', () => {
    expect(isBaseTypeRefusal(failure(0, 'timeout'))).toBe(false);
    expect(isBaseTypeRefusal(failure(401, ''))).toBe(false);
    expect(isBaseTypeRefusal(failure(400, 'Category is required'))).toBe(false);
    expect(isBaseTypeRefusal(failure(500, 'ISM_5000 something'))).toBe(false);
    expect(isBaseTypeRefusal(new Error('x'))).toBe(false);
  });
});
