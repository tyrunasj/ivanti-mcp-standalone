// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import type { FormParameter } from './form-rules/form-package.js';
import { settleAnswerKeys } from './answer-keys.js';

const parameter = (name: string, recId?: string): FormParameter => ({
  name,
  ...(recId === undefined ? {} : { recId }),
  type: 'text',
  sequence: 0,
  constraints: [],
  hidden: false,
});

const FORM = [parameter('Department_1', 'AAA1'), parameter('Model', 'BBB2'), parameter('Dup', 'CCC3'), parameter('Dup', 'DDD4')];

describe('settleAnswerKeys', () => {
  it('turns a name into the RecId and leaves a RecId alone', () => {
    const settled = settleAnswerKeys(FORM, { Department_1: 'IT', bbb2: 'iPad' });

    expect(settled?.answers).toEqual({ AAA1: 'IT', BBB2: 'iPad' });
    expect(settled?.renamed).toEqual({ Department_1: 'AAA1' });
    expect(settled?.unknown).toEqual([]);
  });

  it('names a key that is neither, and one name two parameters share', () => {
    const settled = settleAnswerKeys(FORM, { Colour: 'Black', Dup: 'x' });

    expect(settled?.unknown).toEqual(['Colour', 'Dup']);
  });

  it('says nothing when the form does not state its RecIds', () => {
    expect(settleAnswerKeys([parameter('Model')], { Model: 'x' })).toBeUndefined();
    expect(settleAnswerKeys([], { Model: 'x' })).toBeUndefined();
  });
});
