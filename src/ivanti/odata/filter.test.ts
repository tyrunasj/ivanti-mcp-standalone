// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import {
  assertSupportedFilter,
  findUnsupportedFilter,
  maskStringLiterals,
  referencedFieldNames,
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

/**
 * The own-records scope is `(<caller's filter>) and <mine>`, so a caller's filter that closes the
 * wrapper early escapes it: this exact filter, in `enduser`, read everyone's active tickets.
 */
describe('findUnsupportedFilter — refuses a filter whose structure is not what it reads as', () => {
  it('refuses a `)` that closes a group never opened — the scope escape', () => {
    expect(findUnsupportedFilter("Status eq 'Active') or (Status ne 'x'")).toEqual({
      kind: 'unbalanced-parentheses',
      detail: 'closes-unopened',
    });
  });

  it('refuses one that dips below zero even when the count evens out', () => {
    // Balanced by count, and still an escape: `) or (` closes the wrapper and reopens a group.
    expect(findUnsupportedFilter("A eq 1) or (B eq 2")?.kind).toBe('unbalanced-parentheses');
    expect(findUnsupportedFilter("A eq 1)) or ((B eq 2")?.kind).toBe('unbalanced-parentheses');
  });

  it('refuses a `(` that is never closed', () => {
    expect(findUnsupportedFilter("(Status eq 'Active' or Priority eq 1")).toEqual({
      kind: 'unbalanced-parentheses',
      detail: 'left-open',
    });
  });

  it('refuses a quoted value that is never closed', () => {
    // An open quote swallows the rest of the filter — including, once scoped, the constraint.
    expect(findUnsupportedFilter("Subject eq 'x")).toEqual({ kind: 'unterminated-string' });
    expect(findUnsupportedFilter("Name eq 'O'Brien'")).toEqual({ kind: 'unterminated-string' });
  });

  it('does not count a parenthesis inside a value', () => {
    expect(findUnsupportedFilter("Subject eq ')' or Subject eq '(('")).toBeUndefined();
    expect(findUnsupportedFilter("Name eq 'O''Brien (x'")).toBeUndefined();
  });

  it('explains each refusal in words a caller can act on', () => {
    expect(() => assertSupportedFilter("A eq 1) or (B eq 2")).toThrow(/never opened/);
    expect(() => assertSupportedFilter("(A eq 1")).toThrow(/never closed/);
    expect(() => assertSupportedFilter("A eq 'x")).toThrow(/O''Brien/);
  });
});

describe('referencedFieldNames', () => {
  it('names the fields, and not the letters inside a bare date', () => {
    // `T00` and `Z` used to be offered as fields that do not exist, beside the one that was wrong.
    expect(
      referencedFieldNames({
        filter: 'CreatedDateTime gt 2026-01-01T00:00:00Z and LastModDateTime lt 2026-02-01T08:30:00.5+02:00',
      }),
    ).toEqual(['CreatedDateTime', 'LastModDateTime']);
  });

  it('ignores number literals and their type suffixes', () => {
    expect(referencedFieldNames({ filter: 'Cost gt 12.5M and Weight lt 1e5 and Qty eq 100L' })).toEqual(
      ['Cost', 'Weight', 'Qty'],
    );
  });

  it('keeps a field name that ends in digits', () => {
    expect(referencedFieldNames({ filter: 'Field2 eq 3' })).toEqual(['Field2']);
  });

  it('still strips quoted values and typed literals', () => {
    expect(
      referencedFieldNames({ filter: "Status eq 'Owner' and Created gt datetime'2026-01-01'" }),
    ).toEqual(['Status', 'Created']);
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
