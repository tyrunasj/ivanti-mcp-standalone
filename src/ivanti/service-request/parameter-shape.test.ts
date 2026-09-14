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

  it('leaves `required` absent when the expression is conditional', () => {
    expect(decodeParameter({ RequiredExpression: '$(x)' }).required).toBeUndefined();
  });
});
