// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { decodeParameter, literalRequired, parseConstraints } from './parameter-shape.js';

describe('literalRequired', () => {
  it('reads the three literal forms Ivanti actually stores', () => {
    expect(literalRequired('true')).toBe(true);
    expect(literalRequired('$(true)')).toBe(true);
    expect(literalRequired('$(false)')).toBe(false);
    expect(literalRequired('false')).toBe(false);
  });

  it('says "cannot tell" for a conditional rule rather than guessing', () => {
    // A truthiness test would call this required, and it may not be.
    expect(literalRequired('$(Status == "Active")')).toBeUndefined();
    expect(literalRequired(undefined)).toBeUndefined();
  });
});

describe('parseConstraints', () => {
  it('parses the JSON string Ivanti sends', () => {
    expect(parseConstraints('[{"ConstraintFieldName":"Location"}]')).toEqual([
      { ConstraintFieldName: 'Location' },
    ]);
  });

  it('yields none for empty or unparseable values', () => {
    expect(parseConstraints('')).toEqual([]);
    expect(parseConstraints('not json')).toEqual([]);
    expect(parseConstraints(null)).toEqual([]);
  });
});

describe('decodeParameter', () => {
  it('adds the decoding beside the original, never instead of it', () => {
    const decoded = decodeParameter({
      Name: 'StartDate',
      RequiredExpression: '$(false)',
      ValidationConstraints: '[{"ConstraintFieldName":"Location"}]',
    });

    expect(decoded).toMatchObject({
      RequiredExpression: '$(false)',
      required: false,
      constraints: [{ ConstraintFieldName: 'Location' }],
    });
  });

  it('names the parameters a constrained list is filtered by', () => {
    const decoded = decodeParameter({
      Name: 'Requester',
      ValidationConstraints:
        '[{"ConstraintFieldName":"Department","FormFieldName":"Department_1"}]',
    });

    expect(decoded['filteredBy']).toEqual(['Department_1']);
    expect(decodeParameter({ Name: 'Storage' })['filteredBy']).toBeUndefined();
  });

  it('names the answers that show or require a parameter, ignoring quoted words', () => {
    const names = new Set(['ComputerRequired', 'ComputerType', 'Desktop', 'UltraPortable']);
    const decoded = decodeParameter(
      {
        Name: 'UltraPortable',
        VisibilityExpression:
          '$(ComputerRequired == true && ComputerType != "Desktop" &&\r\n  ComputerType != "")',
        RequiredExpression: '$(false)',
      },
      names,
    );

    expect(decoded['conditionedOn']).toEqual(['ComputerRequired', 'ComputerType']);
  });

  it('does not report a parameter as conditioned on itself, nor on nothing', () => {
    const names = new Set(['2ndMonitor', 'SecondaryMonitor']);
    const decoded = decodeParameter(
      { Name: '2ndMonitor', RequiredExpression: '$(SecondaryMonitor == true)' },
      names,
    );

    expect(decoded['conditionedOn']).toEqual(['SecondaryMonitor']);
    expect(decodeParameter({ Name: 'A', RequiredExpression: '$(true)' }, names)['conditionedOn']).toBeUndefined();
  });

  it('lifts a date rule out of ConfigOptions and drops the layout', () => {
    const decoded = decodeParameter({
      Name: 'StartDate',
      ConfigOptions:
        '{"configData":{"width":250,"dateValidation":{"expr":"$(StartDate>=CurrentDate()+14)"}}}',
    });

    expect(decoded['valueRule']).toBe('$(StartDate>=CurrentDate()+14)');
    expect(decoded['ConfigOptions']).toBeUndefined();
    expect(decodeParameter({ ConfigOptions: 'not json' })['valueRule']).toBeUndefined();
  });

  it('leaves `required` absent when the expression is conditional', () => {
    expect(decodeParameter({ RequiredExpression: '$(x)' }).required).toBeUndefined();
  });
});
