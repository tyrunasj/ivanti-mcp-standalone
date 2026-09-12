import { describe, expect, it } from 'vitest';
import { projectWritten } from './project-written.js';

const RECORD = {
  RecId: 'r1',
  IncidentNumber: 10244,
  Subject: 'Printer',
  Status: 'Active',
  Symptom: 'It jams',
  Owner: 'JSmith',
  Filler: 'x'.repeat(50),
};

describe('projectWritten', () => {
  it('returns what was written plus enough to identify the record', () => {
    const projected = projectWritten(RECORD, undefined, ['Symptom']);

    // The written field, confirmed in the record's own words...
    expect(projected).toMatchObject({ Symptom: 'It jams', RecId: 'r1', IncidentNumber: 10244 });
    // ...and not the ~180-field row a write used to hand back.
    expect(projected).not.toHaveProperty('Filler');
  });

  it('gives back the whole record for "*"', () => {
    expect(projectWritten(RECORD, '*', ['Symptom'])).toEqual(RECORD);
  });

  it('honours an explicit list over the default', () => {
    expect(Object.keys(projectWritten(RECORD, 'Subject', ['Symptom']) ?? {})).toEqual(['Subject']);
  });
});
