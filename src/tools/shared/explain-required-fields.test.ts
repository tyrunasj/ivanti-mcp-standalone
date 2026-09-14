// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { IvantiApiError } from '../../ivanti/http/errors.js';
import type { ResolvedForm } from '../../ivanti/session/form-context.js';
import { explainRequiredFields, RequiredFieldsError } from './explain-required-fields.js';

const FORM: ResolvedForm = {
  layoutName: 'L',
  viewName: 'v',
  formName: 'F',
  validatedFields: {},
  displayNames: { description: 'Symptom', customer: 'ProfileLink', owner: 'Owner' },
  fieldLabels: { Symptom: 'Description', ProfileLink: 'Customer', Owner: 'Owner' },
  linkFields: { ProfileLink: 'ProfileLink_RecID' },
};

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
