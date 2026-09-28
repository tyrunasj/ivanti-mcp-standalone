// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { IvantiApiError } from '../../ivanti/http/errors.js';
import { formFixture } from '../../ivanti/session/form.fixture.js';
import { explainRequiredFields, RequiredFieldsError } from './explain-required-fields.js';

const FORM = formFixture({
  displayNames: { description: 'Symptom', customer: 'ProfileLink', owner: 'Owner' },
  fieldLabels: { Symptom: 'Description', ProfileLink: 'Customer', Owner: 'Owner' },
  linkFields: { ProfileLink: 'ProfileLink_RecID' },
});

const refusal = (message: string): IvantiApiError =>
  new IvantiApiError({
    status: 400,
    method: 'POST',
    url: 'https://t/x',
    body: JSON.stringify({ code: 'ISM_4000', message: [message] }),
  });

describe('explainRequiredFields', () => {
  it('translates the display name Ivanti names into the field to write', () => {
    const explained = explainRequiredFields(
      refusal('Incident((new)).NotEmpty: Required field Incident.Description value must be provided.'),
      FORM,
    );

    expect(explained).toBeInstanceOf(RequiredFieldsError);
    expect(explained?.message).toContain('the field is `Symptom`');
  });

  it('says how to set a link, which is a pair and not a text field', () => {
    const explained = explainRequiredFields(
      refusal('Required field Incident.Customer value must be provided.'),
      FORM,
    );

    expect(explained?.message).toContain('`ProfileLink_RecID`');
    expect(explained?.message).toContain('`ProfileLink_Category`');
  });

  it('reports every field at once, and says the rules are conditional', () => {
    const explained = explainRequiredFields(
      refusal(
        'NotEmpty: Required field Incident.Category value must be provided; NotEmpty: Required field Incident.Owner value must be provided.',
      ),
      FORM,
    );

    // Moving an incident to Active requires both; nothing asked for them while it was Logged.
    expect(explained?.fields).toEqual(['Category', 'Owner']);
    expect(explained?.message).toContain('conditional');
  });

  it('still helps when no form could be resolved', () => {
    const explained = explainRequiredFields(
      refusal('Required field Task.TaskType value must be provided.'),
      undefined,
    );

    expect(explained?.message).toContain('`TaskType`');
  });

  it('leaves other failures alone', () => {
    expect(explainRequiredFields(refusal('No such entry exists'), FORM)).toBeUndefined();
    expect(explainRequiredFields(new Error('network'), FORM)).toBeUndefined();
  });
});

describe('the rest of the required rules', () => {
  const RULES = formFixture({
    displayNames: { description: 'Symptom' },
    requiredRuleFields: ['Category', 'Owner', 'OwnerTeam', 'Symptom', 'Subject'],
  });

  /**
   * A refusal names only what Ivanti checked before stopping — measured at one field on one create
   * and three on another — so it is never evidence that the rest are satisfied.
   */
  it('names the other governed fields, so the retry is one call', () => {
    const explained = explainRequiredFields(
      refusal('Incident((new)).NotEmpty: Required field Incident.Description value must be provided.'),
      RULES,
      ['Subject'],
    );

    expect(explained?.message).toContain('`Category`');
    expect(explained?.message).toContain('`Owner`');
    expect(explained?.message).toContain('only what Ivanti checked before stopping');
    // The one Ivanti already named, resolved through the display name, is not repeated…
    expect(explained?.message).not.toMatch(/rules on[^.]*`Symptom`/);
    // …nor is one the caller already sent.
    expect(explained?.message).not.toMatch(/rules on[^.]*`Subject`/);
  });

  it('claims only that a rule governs them, never that they are required', () => {
    const explained = explainRequiredFields(
      refusal('Incident((new)).NotEmpty: Required field Incident.Description value must be provided.'),
      RULES,
    );

    expect(explained?.message).toContain('depends on that state; the form does not say');
  });

  it('says nothing extra when the form ships no rules', () => {
    const explained = explainRequiredFields(
      refusal('Incident((new)).NotEmpty: Required field Incident.Description value must be provided.'),
      formFixture({ displayNames: { description: 'Symptom' } }),
    );

    expect(explained?.message).not.toContain('required rules on');
  });
});
