import { describe, expect, it } from 'vitest';
import { entityFixture, field } from '../../ivanti/connection.fixture.js';
import { IvantiApiError } from '../../ivanti/http/errors.js';
import { explainFieldError } from './explain-field-error.js';

const INCIDENT = entityFixture('incident', {
  fields: [field('RecId'), field('Symptom'), field('Subject'), field('Status_Valid', { internalTwin: true })],
});

const refusal = (body: string): IvantiApiError =>
  new IvantiApiError({ status: 400, method: 'GET', url: 'https://t/x', body });

describe('explainFieldError', () => {
  it('names the field Ivanti would not name', () => {
    const explained = explainFieldError(
      refusal('{"code":"ISM_4000","message":["No such entry exists"]}'),
      INCIDENT,
      ['Description', 'Status'],
    );

    expect(explained?.message).toContain("'Description'");
    expect(explained?.message).toContain('3 fields');
  });

  it('suggests a real field when one is close', () => {
    const explained = explainFieldError(
      refusal('could not find a property'),
      INCIDENT,
      ['Subjekt', 'Subj'],
    );

    expect(explained?.message).toContain('did you mean: Subject');
  });

  it('stays out of the way when every referenced field exists', () => {
    // The 400 was about something else; inventing a field explanation would mislead.
    expect(explainFieldError(refusal('No such entry exists'), INCIDENT, ['Symptom'])).toBeUndefined();
  });

  it('ignores failures that are not field problems', () => {
    expect(explainFieldError(refusal('Invalid key'), INCIDENT, ['Nope'])).toBeUndefined();
    expect(explainFieldError(new Error('network'), INCIDENT, ['Nope'])).toBeUndefined();
  });
});
