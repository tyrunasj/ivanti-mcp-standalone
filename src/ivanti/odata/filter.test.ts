// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import {
  assertSupportedFilter,
  findUnsupportedFilter,
  maskStringLiterals,
} from './filter.js';

describe('maskStringLiterals', () => {
  it('hides literal contents but keeps the quotes and length', () => {
    expect(maskStringLiterals("Name eq 'abc'")).toBe("Name eq '~~~'");
  });

  it('handles the doubled-quote escape', () => {
    expect(maskStringLiterals("Name eq 'O''Brien'")).toBe("Name eq '~~~~~~~~'");
  });

  it('masks with a non-word character, or every quoted value looks like a binary literal', () => {
    // `X'…'` is an OData v2 literal; masking with `x` made "Name eq 'a'" match it.
    expect(maskStringLiterals("Name eq 'a'")).not.toMatch(/[A-Za-z]'/);
  });
});

describe('findUnsupportedFilter — accepts what Ivanti supports', () => {
  for (const filter of [
    "Status eq 'Active'",
    "(Status eq 'Active') and (Priority eq 1)",
    "Owner eq 'a' or Owner eq 'b'",
    "not (Status eq 'Closed')",
    'CreatedDateTime gt 2026-01-01T00:00:00Z',
    "Subject ne null and Priority le 3",
    '',
  ]) {
    it(`allows ${filter || '(empty)'}`, () => {
      expect(findUnsupportedFilter(filter)).toBeUndefined();
    });
  }
});

describe('findUnsupportedFilter — refuses what Ivanti silently drops', () => {
  for (const [filter, name] of [
    ["contains(Subject,'disk')", 'contains'],
    ["startswith(Name,'A')", 'startswith'],
    ["endswith(Name,'z')", 'endswith'],
    ['year(CreatedDateTime) eq 2026', 'year'],
    ["substringof('x',Subject)", 'substringof'],
    ["tolower(Name) eq 'x'", 'tolower'],
  ] as const) {
    it(`refuses ${name}()`, () => {
      expect(findUnsupportedFilter(filter)).toEqual({ kind: 'function', name });
    });
  }

  it('refuses OData v2 typed literals', () => {
    expect(findUnsupportedFilter("Created gt datetime'2026-01-01'")).toEqual({
      kind: 'typed-literal',
      literal: "datetime'…'",
    });
    expect(findUnsupportedFilter("Id eq guid'abc'")?.kind).toBe('typed-literal');
  });
});

describe('findUnsupportedFilter — no false positives from string contents', () => {
  it('ignores a parenthesis inside a quoted value', () => {
    expect(findUnsupportedFilter("Subject eq 'disk full (urgent)'")).toBeUndefined();
  });

  it('ignores a function-looking value inside a quoted string', () => {
    expect(findUnsupportedFilter("Subject eq 'contains(x)'")).toBeUndefined();
  });

  it('ignores the word datetime inside a quoted value', () => {
    expect(findUnsupportedFilter("Subject eq 'datetime''s are hard'")).toBeUndefined();
  });
});

describe('assertSupportedFilter', () => {
  it('passes a supported filter', () => {
    expect(() => assertSupportedFilter("Status eq 'Active'")).not.toThrow();
    expect(() => assertSupportedFilter(undefined)).not.toThrow();
  });

  it('explains that the filter would be silently ignored', () => {
    expect(() => assertSupportedFilter("contains(Subject,'x')")).toThrow(
      /silently ignored.*full unfiltered set/s,
    );
  });
});
