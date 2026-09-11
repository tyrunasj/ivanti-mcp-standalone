import { describe, expect, it } from 'vitest';
import { describeSubtypes, findSubtypes } from './subtypes.js';

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
  it('finds the subtypes of a base type, with the set the record tools take', () => {
    // Lowercase, because that is how CSDL spells the name; the routes are case-insensitive.
    expect(findSubtypes(NAMES, 'Tasks')).toEqual([
      { object: 'task__assignment', entitySet: 'task__assignments' },
      { object: 'task__workorder', entitySet: 'task__workorders' },
    ]);
  });

  it('does not mistake a name that merely starts the same way', () => {
    // `taskcatalog` is its own object, not a subtype of `task`.
    expect(findSubtypes(NAMES, 'Tasks').map((s) => s.object)).not.toContain('taskcatalog');
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
