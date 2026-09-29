// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { comparable, compareStored } from './compare-stored.js';

/**
 * The allowances are the risky half: each one is a way to call a value stored, and a loose one
 * reports success for a write that did not take. So every allowance is paired with the nearest
 * value that must still fail.
 */
describe('compareStored', () => {
  it('compares by the value when the schema is not in hand', () => {
    // A JS number is a number; an ISO string is a date.
    expect(compareStored(5, '5.0')).toBe('same');
    expect(compareStored(5, '6')).toBe('different');
    expect(compareStored('2026-10-01T10:00:00Z', '2026-10-01T12:00:00+02:00')).toBe('same');
    expect(compareStored('2026-10-01T10:00:00Z', '2026-10-01T10:05:00Z')).toBe('different');
  });

  it('keeps a string field a string, even when it holds something date-shaped', () => {
    expect(compareStored('2026-10-01', '2026-09-30T22:00:00Z', 'Edm.String')).toBe('different');
  });

  it('treats empty, null and absent as the same nothing', () => {
    expect(compareStored('', null)).toBe('same');
    expect(compareStored(null, undefined)).toBe('same');
    expect(compareStored('x', null)).toBe('different');
    expect(compareStored(null, 'x')).toBe('different');
  });

  it('reads a flag in the spellings Ivanti and a caller use', () => {
    expect(compareStored('False', false, 'Edm.Boolean')).toBe('same');
    expect(compareStored(1, true, 'Edm.Boolean')).toBe('same');
    expect(compareStored(true, null, 'Edm.Boolean')).toBe('different');
  });

  it('falls back to text when a value does not parse as its type', () => {
    expect(compareStored('n/a', 'N/A', 'Edm.Int32')).toBe('same');
    expect(compareStored('soon', 'later', 'Edm.DateTimeOffset')).toBe('different');
  });

  it('reads entities the way a field that renders HTML stores them', () => {
    expect(compareStored('Fish & chips < £5', 'Fish &amp; chips &lt; &#163;5')).toBe('same');
    expect(compareStored('a b', 'a&nbsp;b')).toBe('same');
    expect(compareStored('Fish & chips', 'Fish &amp; peas')).toBe('different');
  });

  it('does not judge markup or structure', () => {
    expect(compareStored('<p>x</p>', 'x')).toBe('incomparable');
    expect(compareStored('x', '<div>x</div>')).toBe('incomparable');
    expect(compareStored({ a: 1 }, '{"a":1}')).toBe('incomparable');
  });
});

describe('comparable', () => {
  it('serialises a structure rather than printing [object Object]', () => {
    expect(comparable({ a: 1 })).toBe('{"a":1}');
    expect(comparable(null)).toBe('');
    expect(comparable(10n)).toBe('10');
  });
});
