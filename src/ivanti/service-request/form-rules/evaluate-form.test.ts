// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateForm } from './evaluate-form.js';
import { parseFormPackage, type FormParameter } from './form-package.js';

// The New Employee Setup form as the portal received it (HAR, 2026-10-25), trimmed to the
// parameters that carry rules.
const onboarding = parseFormPackage(
  JSON.parse(
    readFileSync(new URL('./onboarding.fixture.json', import.meta.url), 'utf8'),
  ) as unknown,
);

const NOW = (): Date => new Date('2026-10-25T08:00:00Z');

function evaluate(answers: Record<string, string | boolean>) {
  return evaluateForm({ parameters: onboarding, answers, now: NOW });
}

describe('parseFormPackage', () => {
  it('reads the rules as trees, in form order', () => {
    expect(onboarding.map((parameter) => parameter.name)[0]).toBe('FirstName');
    const type = onboarding.find((parameter) => parameter.name === 'ComputerType');
    expect(type?.visibility?.FieldRefs).toEqual(['ComputerRequired']);
    expect(type?.required?.Source).toBe('$(ComputerRequired == true)');
  });

  it('yields nothing from a payload that is not a package', () => {
    expect(parseFormPackage(null)).toEqual([]);
    expect(parseFormPackage({ lstParamCategories: 'no' })).toEqual([]);
  });
});

describe('evaluateForm — conditional fields', () => {
  it('hides everything behind an unticked checkbox', () => {
    const result = evaluate({});

    expect(result.hidden).toEqual(
      expect.arrayContaining(['ComputerType', 'UltraPortable', 'PrimaryMonitor', '2ndMonitor', 'MobilePhone']),
    );
    expect(result.visible).toEqual(expect.arrayContaining(['ComputerRequired', 'MobilePhoneRequired']));
  });

  it('shows and requires the type once the computer is wanted', () => {
    const result = evaluate({ ComputerRequired: true });

    expect(result.visible).toContain('ComputerType');
    expect(result.required).toContain('ComputerType');
    expect(result.missing).toContain('ComputerType');
    // Neither type is chosen, so the type-dependent extras stay hidden.
    expect(result.hidden).toEqual(expect.arrayContaining(['UltraPortable', 'PrimaryMonitor']));
  });

  it('follows a combo: a notebook has the extras, a desktop has the monitor', () => {
    const notebook = evaluate({ ComputerRequired: true, ComputerType: 'Notebook' });
    expect(notebook.visible).toEqual(expect.arrayContaining(['UltraPortable', 'PortReplicator']));
    expect(notebook.hidden).toContain('PrimaryMonitor');

    const desktop = evaluate({ ComputerRequired: true, ComputerType: 'Desktop' });
    expect(desktop.visible).toContain('PrimaryMonitor');
    expect(desktop.hidden).toEqual(expect.arrayContaining(['UltraPortable', 'PortReplicator']));
  });

  it('chains: the second monitor appears and is required once ticked', () => {
    const result = evaluate({ ComputerRequired: true, ComputerType: 'Desktop', SecondaryMonitor: true });

    expect(result.visible).toContain('2ndMonitor');
    expect(result.missing).toContain('2ndMonitor');
    expect(evaluate({ ComputerRequired: true, ComputerType: 'Desktop', SecondaryMonitor: true, '2ndMonitor': { value: 'x' } } as never).missing).not.toContain('2ndMonitor');
  });

  it('reports an answer that has become hidden, so it can be dropped', () => {
    const result = evaluate({ ComputerRequired: false, ComputerType: 'Notebook' });

    expect(result.answeredButHidden).toEqual(['ComputerType']);
  });

  it('never requires a hidden parameter', () => {
    expect(evaluate({}).required).not.toContain('ComputerType');
  });

  it('settles answers given by RecId and reports keys it does not know', () => {
    const recId = onboarding.find((parameter) => parameter.name === 'ComputerRequired')?.recId ?? '';
    const result = evaluate({ [recId]: true, Bogus: 'x' });

    expect(result.visible).toContain('ComputerType');
    expect(result.unknownAnswers).toEqual(['Bogus']);
  });

  it('offers a default where there is a rule for one, until answered', () => {
    expect(evaluate({}).defaults).toMatchObject({ EmploymentType_1: 'Full Time' });
    // Required, but the portal fills it in: nothing to ask.
    expect(evaluate({}).required).toContain('EmploymentType_1');
    expect(evaluate({}).missing).not.toContain('EmploymentType_1');
    expect(evaluate({ EmploymentType_1: 'Part Time' }).defaults).not.toHaveProperty('EmploymentType_1');
  });
});

describe('evaluateForm — cascading lists', () => {
  const parameters: FormParameter[] = [
    { name: 'Department_1', type: 'combo', sequence: 1, constraints: [], hidden: false },
    {
      name: 'Requester',
      type: 'combo',
      sequence: 2,
      constraints: [{ ConstraintFieldName: 'Department', FormFieldName: 'Department_1' }],
      hidden: false,
    },
  ];

  it('says what a child list is waiting for', () => {
    expect(evaluateForm({ parameters, answers: {} }).options['Requester']).toEqual({
      constraints: [{ queryFieldName: 'Department', value: '' }],
      waitingOn: ['Department_1'],
    });
  });

  it('hands over the exact constraints once the parent is answered', () => {
    const result = evaluateForm({
      parameters,
      answers: { Department_1: { value: 'Sales', recId: 'x' } },
    });

    expect(result.options['Requester']).toEqual({
      constraints: [{ queryFieldName: 'Department', value: 'Sales' }],
      waitingOn: [],
    });
  });
});

describe('evaluateForm — what it cannot read', () => {
  it('names an unknown function instead of guessing', () => {
    const parameters: FormParameter[] = [
      {
        name: 'X',
        type: 'text',
        sequence: 1,
        constraints: [],
        hidden: false,
        visibility: { Tree: { Kind: 5, FunctionName: 'NoSuchThing', Arguments: [] }, FieldRefs: [] },
      },
    ];

    const result = evaluateForm({ parameters, answers: {} });

    expect(result.cannotTell).toEqual({ X: ['function NoSuchThing'] });
  });
});
