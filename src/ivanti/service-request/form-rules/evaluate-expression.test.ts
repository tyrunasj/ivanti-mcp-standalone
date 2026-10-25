// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { evaluateExpression, evaluateRule } from './evaluate-expression.js';

// "Category required UNLESS Status == 'Logged'": if (Status == 'Logged') false else true.
const CATEGORY_REQUIRED = {
  Kind: 4,
  Condition: {
    Kind: 3,
    Op: 0,
    Left: { Kind: 1, FieldIndex: 0 },
    Right: { Kind: 0, Value: 'Logged' },
  },
  WhenTrue: { Kind: 0, Value: false },
  WhenFalse: { Kind: 0, Value: true },
};

describe('evaluateExpression', () => {
  it('evaluates a conditional rule against the controller value', () => {
    expect(evaluateRule(CATEGORY_REQUIRED, ['Status'], () => 'Open')).toBe(true);
    expect(evaluateRule(CATEGORY_REQUIRED, ['Status'], () => 'Logged')).toBe(false);
  });

  it('comparison ops: == and !=', () => {
    const eq = {
      Kind: 3,
      Op: 0,
      Left: { Kind: 1, FieldIndex: 0 },
      Right: { Kind: 0, Value: 'Closed' },
    };
    const ne = {
      Kind: 3,
      Op: 1,
      Left: { Kind: 1, FieldIndex: 0 },
      Right: { Kind: 0, Value: 'Closed' },
    };
    expect(evaluateExpression(eq, ['Status'], () => 'Closed')).toBe(true);
    expect(evaluateExpression(ne, ['Status'], () => 'Closed')).toBe(false);
  });

  it('logical ops: OR / AND / NOT', () => {
    const t = { Kind: 0, Value: true };
    const f = { Kind: 0, Value: false };
    expect(evaluateExpression({ Kind: 3, Op: 11, Left: t, Right: f }, [], () => null)).toBe(true);
    expect(evaluateExpression({ Kind: 3, Op: 10, Left: t, Right: f }, [], () => null)).toBe(false);
    expect(evaluateExpression({ Kind: 2, Op: 1, Arg: f }, [], () => null)).toBe(true); // NOT false
  });

  it('IsNull(field) — true when blank', () => {
    const isNull = { Kind: 5, FunctionName: 'IsNull', Arguments: [{ Kind: 1, FieldIndex: 0 }] };
    expect(evaluateExpression(isNull, ['Link'], () => '')).toBe(true);
    expect(evaluateExpression(isNull, ['Link'], () => 'x')).toBe(false);
  });

  it('Op 17 — set membership against a Kind-8 value set (toolbar rules)', () => {
    // `ParentLink_Category in {Incident, ServiceReq}`
    const inSet = {
      Kind: 3,
      Op: 17,
      Left: { Kind: 1, FieldIndex: 0 },
      Right: {
        Kind: 8,
        SetValues: [
          { Kind: 0, Value: 'Incident' },
          { Kind: 0, Value: 'ServiceReq' },
        ],
      },
    };
    expect(evaluateExpression(inSet, ['ParentLink_Category'], () => 'ServiceReq')).toBe(true);
    expect(evaluateExpression(inSet, ['ParentLink_Category'], () => 'Problem')).toBe(false);
    expect(evaluateExpression(inSet, ['ParentLink_Category'], () => '')).toBe(false);
  });

  it('resolves a field by Details.Selector when the ref is absent', () => {
    const node = { Kind: 1, FieldIndex: 9, Details: { Selector: 'Impact' } };
    expect(evaluateExpression(node, [], (f) => (f === 'Impact' ? 'High' : null))).toBe('High');
  });

  it('strips an (old) prefix from a field ref', () => {
    const node = { Kind: 1, FieldIndex: 0 };
    expect(evaluateExpression(node, ['(old)Status'], (f) => (f === 'Status' ? 'Open' : null))).toBe(
      'Open',
    );
  });

  it('ordering ops coerce numeric strings', () => {
    const less = {
      Kind: 3,
      Op: 2,
      Left: { Kind: 1, FieldIndex: 0 },
      Right: { Kind: 0, Value: '10' },
    };
    expect(evaluateExpression(less, ['Priority'], () => '5')).toBe(true); // 5 < 10
    expect(evaluateExpression(less, ['Priority'], () => '20')).toBe(false);
  });

  it('concatenating a date formats it (not the raw JS string)', () => {
    const add = {
      Kind: 3,
      Op: 8,
      Left: { Kind: 0, Value: 'when: ' },
      Right: { Kind: 1, FieldIndex: 0 },
    };
    const date = new Date(Date.UTC(2026, 5, 1, 9, 5));
    const out = evaluateExpression(add, ['D'], () => date) as string;
    expect(out).toBe('when: 06/01/2026 9:05 AM');
  });

  it('arithmetic: + adds numbers but concatenates strings', () => {
    const add = (op: number, l: unknown, r: unknown) =>
      evaluateExpression(
        { Kind: 3, Op: op, Left: { Kind: 0, Value: l }, Right: { Kind: 0, Value: r } },
        [],
        () => null,
      );
    expect(add(8, 2, 3)).toBe(5); // numeric add
    expect(add(8, 'a', 'b')).toBe('ab'); // string concat
    expect(add(6, '4', '5')).toBe(20); // multiply
  });

  it('+ adds numeric strings (e.g. Number() output) but still concats text', () => {
    const add = (l: unknown, r: unknown) =>
      evaluateExpression(
        { Kind: 3, Op: 8, Left: { Kind: 0, Value: l }, Right: { Kind: 0, Value: r } },
        [],
        () => null,
      );
    expect(add('42', 1)).toBe(43); // numeric string + number → add
    expect(add('1.5', '2.5')).toBe(4); // two numeric strings → add
    expect(add('id-', '7')).toBe('id-7'); // non-numeric left → concat (contract preserved)
    // `Number("42") + 1` — Number() returns the string "42", so this exercises the fix.
    const numberPlusOne = {
      Kind: 3,
      Op: 8,
      Left: { Kind: 5, FunctionName: 'Number', Arguments: [{ Kind: 0, Value: '42' }] },
      Right: { Kind: 0, Value: 1 },
    };
    expect(evaluateExpression(numberPlusOne, [], () => null)).toBe(43);
  });

  it('IN / NOT IN against a Set', () => {
    const set = {
      Kind: 8,
      SetValues: [
        { Kind: 0, Value: 'A' },
        { Kind: 0, Value: 'B' },
      ],
    };
    const inExpr = { Kind: 3, Op: 13, Left: { Kind: 1, FieldIndex: 0 }, Right: set };
    const notIn = { Kind: 3, Op: 14, Left: { Kind: 1, FieldIndex: 0 }, Right: set };
    expect(evaluateExpression(inExpr, ['X'], () => 'a')).toBe(true); // case-insensitive
    expect(evaluateExpression(inExpr, ['X'], () => 'C')).toBe(false);
    expect(evaluateExpression(notIn, ['X'], () => 'C')).toBe(true);
  });

  it('OR coalesces to the first truthy operand (auto-fill use)', () => {
    const or = {
      Kind: 3,
      Op: 11,
      Left: { Kind: 1, FieldIndex: 0 },
      Right: { Kind: 0, Value: 'fallback' },
    };
    expect(evaluateExpression(or, ['Name'], () => '')).toBe('fallback');
    expect(evaluateExpression(or, ['Name'], () => 'given')).toBe('given');
  });

  it('case expression returns the matching action, else the ELSE action', () => {
    const node = {
      Kind: 12,
      CaseValue: { Kind: 1, FieldIndex: 0 },
      WhenItems: [
        { PatternsOrValues: [{ Kind: 0, Value: 'High' }], WhenAction: { Kind: 0, Value: 1 } },
        { PatternsOrValues: [{ Kind: 0, Value: 'Low' }], WhenAction: { Kind: 0, Value: 3 } },
      ],
      ElseAction: { Kind: 0, Value: 2 },
    };
    expect(evaluateExpression(node, ['Impact'], () => 'High')).toBe(1);
    expect(evaluateExpression(node, ['Impact'], () => 'Low')).toBe(3);
    expect(evaluateExpression(node, ['Impact'], () => 'Medium')).toBe(2);
  });

  it('dispatches to injected functions, unknown functions yield null', () => {
    const node = { Kind: 5, FunctionName: 'CurrentLoginId', Arguments: [] };
    expect(
      evaluateExpression(node, [], () => null, { functions: { currentloginid: () => 'admin' } }),
    ).toBe('admin');
    expect(
      evaluateExpression({ Kind: 5, FunctionName: 'Nope', Arguments: [] }, [], () => null),
    ).toBe(null);
  });

  it('built-in Trim function', () => {
    const node = { Kind: 5, FunctionName: 'Trim', Arguments: [{ Kind: 0, Value: '  hi  ' }] };
    expect(evaluateExpression(node, [], () => null)).toBe('hi');
  });

  describe('stored expressions (Kind 16 — `$[this]Name()`)', () => {
    // A stored XSC_GetLongitude that reads the record's Longitude field.
    const storedExpressions = {
      xsc_getlongitude: ({ field }: { field: (n: string) => unknown }) =>
        Number(field('Longitude')) || 0,
    };
    const longitudeIs = (v: unknown) => (f: string) => (f === 'Longitude' ? v : null);

    it('resolves a Kind-16 ExpressionName and gives it field access', () => {
      const node = { Kind: 16, ExpressionName: 'XSC_GetLongitude' };
      expect(evaluateExpression(node, [], longitudeIs('42'), { storedExpressions })).toBe(42);
    });

    it('matches the ExpressionName case-insensitively', () => {
      const node = { Kind: 16, ExpressionName: 'xsc_getLONGITUDE' };
      expect(evaluateExpression(node, [], longitudeIs('7'), { storedExpressions })).toBe(7);
    });

    it('a numeric result adds (not concatenates) in arithmetic', () => {
      // $[this]XSC_GetLongitude() + 1
      const add = {
        Kind: 3,
        Op: 8,
        Left: { Kind: 16, ExpressionName: 'XSC_GetLongitude' },
        Right: { Kind: 0, Value: 1 },
      };
      expect(evaluateExpression(add, [], longitudeIs('42'), { storedExpressions })).toBe(43);
    });

    it('an unknown stored expression returns null', () => {
      const node = { Kind: 16, ExpressionName: 'NoSuchExpr' };
      expect(evaluateExpression(node, [], () => null, { storedExpressions })).toBeNull();
    });

    it('a Kind-16 node resolves to null when no registry is passed', () => {
      const node = { Kind: 16, ExpressionName: 'XSC_GetLongitude' };
      expect(evaluateExpression(node, [], longitudeIs('42'))).toBeNull();
    });

    it('passes evaluated arguments through to the stored expression', () => {
      const node = {
        Kind: 16,
        ExpressionName: 'Echo',
        Arguments: [{ Kind: 0, Value: 'a' }, null],
      };
      const expr = ({ args }: { args: unknown[] }) => args;
      expect(
        evaluateExpression(node, [], () => null, { storedExpressions: { echo: expr } }),
      ).toEqual(['a', null]);
    });
  });

  describe('ordering operators (<, <=, >, >=)', () => {
    const cmp = (op: number, l: unknown, r: unknown) =>
      evaluateExpression(
        { Kind: 3, Op: op, Left: { Kind: 0, Value: l }, Right: { Kind: 0, Value: r } },
        [],
        () => null,
      );

    it('<= is true on equal, > and >= behave at the boundary', () => {
      expect(cmp(3, 5, 5)).toBe(true); // 5 <= 5
      expect(cmp(3, 6, 5)).toBe(false); // 6 <= 5
      expect(cmp(4, 6, 5)).toBe(true); // 6 > 5
      expect(cmp(4, 5, 5)).toBe(false); // 5 > 5
      expect(cmp(5, 5, 5)).toBe(true); // 5 >= 5
      expect(cmp(5, 4, 5)).toBe(false); // 4 >= 5
    });

    it('a non-numeric operand coerces to 0', () => {
      expect(cmp(2, 'abc', '1')).toBe(true); // 0 < 1
      expect(cmp(4, '1', 'abc')).toBe(true); // 1 > 0
    });
  });

  describe('arithmetic operators (-, /, %)', () => {
    const calc = (op: number, l: unknown, r: unknown) =>
      evaluateExpression(
        { Kind: 3, Op: op, Left: { Kind: 0, Value: l }, Right: { Kind: 0, Value: r } },
        [],
        () => null,
      );

    it('subtracts, divides, and modulos numeric strings', () => {
      expect(calc(9, '10', '3')).toBe(7); // -
      expect(calc(7, '10', '4')).toBe(2.5); // /
      expect(calc(12, '10', '3')).toBe(1); // %
    });

    it('division by zero is guarded to 0 (no Infinity/NaN leaks into the form)', () => {
      expect(calc(7, '5', '0')).toBe(0);
      expect(calc(7, '5', 'notnum')).toBe(0); // coerces to 0 → guarded
    });

    it('unknown binary op fails soft to false', () => {
      // Op 15 is not implemented (date-interval/bitwise) → default branch.
      expect(calc(15, 1, 2)).toBe(false);
    });
  });

  describe('+ add-vs-concat edge cases', () => {
    const add = (l: unknown, r: unknown) =>
      evaluateExpression(
        { Kind: 3, Op: 8, Left: { Kind: 0, Value: l }, Right: { Kind: 0, Value: r } },
        [],
        () => null,
      );

    it('concatenates when either side is non-numeric, treating null as empty', () => {
      expect(add(null, 'x')).toBe('x'); // null → ''
      expect(add('x', null)).toBe('x');
      expect(add(null, null)).toBe(''); // both blank
      expect(add('a', 5)).toBe('a5'); // mixed → concat
    });
  });

  describe('unary operators', () => {
    const un = (op: number, value: unknown) =>
      evaluateExpression({ Kind: 2, Op: op, Arg: { Kind: 0, Value: value } }, [], () => null);

    it('negate (0) coerces numeric strings, NOT (1) inverts truthiness', () => {
      expect(un(0, '5')).toBe(-5);
      expect(un(0, 'abc')).toBe(-0); // non-numeric → 0
      expect(un(1, '')).toBe(true); // NOT falsy
      expect(un(1, 'x')).toBe(false); // NOT truthy
    });

    it('bitwise-complement (2) and an unknown unary op (null)', () => {
      expect(un(2, '5')).toBe(~5); // -6
      expect(un(9, 'x')).toBeNull(); // default branch
    });
  });

  describe('fail-soft / null paths', () => {
    it('a null/primitive node returns itself (null) rather than throwing', () => {
      expect(evaluateExpression(null, [], () => null)).toBeNull();
      expect(evaluateExpression(undefined, [], () => null)).toBeNull();
      expect(evaluateExpression('raw', [], () => null)).toBe('raw');
    });

    it('an unknown node Kind falls back to its Value, else null', () => {
      expect(evaluateExpression({ Kind: 99, Value: 'v' }, [], () => null)).toBe('v');
      expect(evaluateExpression({ Kind: 99 }, [], () => null)).toBeNull();
    });

    it('a field reference with no ref and no selector resolves to null', () => {
      // FieldIndex past the end of fieldRefs and no Details.Selector.
      expect(evaluateExpression({ Kind: 1, FieldIndex: 5 }, ['Only'], () => 'x')).toBeNull();
    });

    it('a Kind-7 node compiles to a RegExp with flags', () => {
      const re = evaluateExpression(
        { Kind: 7, Value: 'a.c', Flags: 'i' },
        [],
        () => null,
      ) as RegExp;
      expect(re).toBeInstanceOf(RegExp);
      expect(re.test('ABC')).toBe(true);
    });

    it('a Kind-8 set evaluates each member', () => {
      const set = {
        Kind: 8,
        SetValues: [
          { Kind: 0, Value: 'A' },
          { Kind: 1, FieldIndex: 0 },
        ],
      };
      expect(evaluateExpression(set, ['F'], () => 'B')).toEqual(['A', 'B']);
    });
  });

  describe('conditional (Kind 4) and case (Kind 12) branch coverage', () => {
    it('conditional treats a non-true condition as the WhenFalse branch', () => {
      const node = {
        Kind: 4,
        Condition: { Kind: 0, Value: 'truthy-but-not-true' },
        WhenTrue: { Kind: 0, Value: 'yes' },
        WhenFalse: { Kind: 0, Value: 'no' },
      };
      // Condition must be strictly === true; a truthy string takes the false branch.
      expect(evaluateExpression(node, [], () => null)).toBe('no');
    });

    it('case with no CaseValue matches the first truthy pattern', () => {
      const node = {
        Kind: 12,
        WhenItems: [
          { PatternsOrValues: [{ Kind: 0, Value: true }], WhenAction: { Kind: 0, Value: 'hit' } },
        ],
        ElseAction: { Kind: 0, Value: 'else' },
      };
      // No CaseValue → subject defaults to `true`, so `true == true` matches.
      expect(evaluateExpression(node, [], () => null)).toBe('hit');
    });

    it('case matches a RegExp pattern against the subject', () => {
      const node = {
        Kind: 12,
        CaseValue: { Kind: 1, FieldIndex: 0 },
        WhenItems: [
          {
            PatternsOrValues: [{ Kind: 7, Value: '^I', Flags: '' }],
            WhenAction: { Kind: 0, Value: 'starts-with-I' },
          },
        ],
        ElseAction: { Kind: 0, Value: 'else' },
      };
      expect(evaluateExpression(node, ['Cat'], () => 'Incident')).toBe('starts-with-I');
      expect(evaluateExpression(node, ['Cat'], () => 'Problem')).toBe('else');
    });

    it('case returns null when a matched WhenAction / the ElseAction is absent', () => {
      const matchNoAction = {
        Kind: 12,
        CaseValue: { Kind: 0, Value: 'x' },
        WhenItems: [{ PatternsOrValues: [{ Kind: 0, Value: 'x' }] }], // no WhenAction
      };
      expect(evaluateExpression(matchNoAction, [], () => null)).toBeNull();
      const noElse = { Kind: 12, CaseValue: { Kind: 0, Value: 'x' }, WhenItems: [] };
      expect(evaluateExpression(noElse, [], () => null)).toBeNull();
    });
  });

  describe('loose equality + coercion quirks', () => {
    it('treats null, undefined and empty string as equal', () => {
      const eq = (l: unknown, r: unknown) =>
        evaluateExpression(
          { Kind: 3, Op: 0, Left: { Kind: 0, Value: l }, Right: { Kind: 0, Value: r } },
          [],
          () => null,
        );
      expect(eq(null, '')).toBe(true);
      expect(eq(undefined, '')).toBe(true);
      expect(eq(null, undefined)).toBe(true);
      expect(eq('1', 1)).toBe(true); // stringified compare
      expect(eq('1', '01')).toBe(false); // string equality, not numeric
    });

    it('!= is the strict inverse of ==', () => {
      const ne = (l: unknown, r: unknown) =>
        evaluateExpression(
          { Kind: 3, Op: 1, Left: { Kind: 0, Value: l }, Right: { Kind: 0, Value: r } },
          [],
          () => null,
        );
      expect(ne(null, '')).toBe(false);
      expect(ne('a', 'b')).toBe(true);
    });
  });

  describe('AND / OR short-circuit semantics', () => {
    it('AND returns the left falsy operand without evaluating the right', () => {
      const right = { Kind: 5, FunctionName: 'boom', Arguments: [] };
      const and = { Kind: 3, Op: 10, Left: { Kind: 0, Value: '' }, Right: right };
      // Left is falsy → returns left ('') and never dispatches the (unknown) fn.
      expect(evaluateExpression(and, [], () => null)).toBe('');
    });

    it('AND returns the right operand when the left is truthy', () => {
      const and = {
        Kind: 3,
        Op: 10,
        Left: { Kind: 0, Value: 'x' },
        Right: { Kind: 0, Value: 'y' },
      };
      expect(evaluateExpression(and, [], () => null)).toBe('y');
    });
  });
});
