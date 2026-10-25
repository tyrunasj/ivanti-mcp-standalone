// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { DEFAULT_FUNCTIONS, clockFunctions, currentUserFunctions, formFunctions } from './index.js';

const fn = (name: string, ...args: unknown[]) => {
  const f = DEFAULT_FUNCTIONS[name];
  if (f === undefined) throw new Error(`no function ${name}`);
  return f(args);
};

describe('DEFAULT_FUNCTIONS — string', () => {
  it('trim / case / first-letter', () => {
    expect(fn('trim', '  hi  ')).toBe('hi');
    expect(fn('tolowercase', 'AB')).toBe('ab');
    expect(fn('touppercase', 'ab')).toBe('AB');
    expect(fn('touppercasefirst', '  hello world  ')).toBe('Hello world');
    expect(fn('emptystring')).toBe('');
  });

  it('len / find', () => {
    expect(fn('len', 'abc')).toBe(3);
    expect(fn('len', null)).toBeNull();
    expect(fn('find', 'b', 'abc')).toBe(1); // find(needle, haystack)
    expect(fn('find', 'b', 'abcb', 2)).toBe(3); // from index
  });

  it('substring is 1-based, substring0 is 0-based', () => {
    expect(fn('substring', 'abcdef', 2, 3)).toBe('bcd');
    expect(fn('substring0', 'abcdef', 2, 3)).toBe('cde');
  });

  it('padLeft / padRight', () => {
    expect(fn('padleft', '7', '0', 3)).toBe('007');
    expect(fn('padright', '7', '-', 3)).toBe('7--');
  });

  it('stringBefore / stringAfter with modes', () => {
    expect(fn('stringbefore', 'first.second', 'FROMSTART', '.')).toBe('first');
    expect(fn('stringafter', 'first.second', 'TOEND', '.')).toBe('second');
  });

  it('formatNumber fixes decimals (comma-aware)', () => {
    expect(fn('formatnumber', '3,5', 2)).toBe('3.50');
  });
});

describe('DEFAULT_FUNCTIONS — math', () => {
  it('round / roundUp / roundDown / truncate / absoluteValue', () => {
    expect(fn('round', 3.14159, 2)).toBe('3.14');
    expect(fn('roundup', 3.1)).toBe(4);
    expect(fn('rounddown', 3.9)).toBe(3);
    expect(fn('truncate', 3.9)).toBe(3);
    expect(fn('absolutevalue', -5)).toBe(5);
  });

  it('numericEmpty / numericFormat / currencyValue', () => {
    expect(fn('numericempty', '')).toBe(true);
    expect(fn('numericempty', 0)).toBe(false);
    expect(fn('numericformat', 1234.5, 'FIXEDPOINT', 2)).toBe('1234.50');
    expect(fn('currencyvalue', '$1,234.50')).toBe(1234.5);
  });
});

describe('DEFAULT_FUNCTIONS — conversion / regex / logical', () => {
  it('number / boolean / datetime', () => {
    expect(fn('number', '42')).toBe('42');
    expect(fn('boolean', 'TRUE')).toBe(true);
    expect(fn('boolean', 'no')).toBe(false);
    expect(fn('datetime', '2026-04-11T00:00:00Z')).toBeInstanceOf(Date);
  });

  it('regex match / replace', () => {
    const re = fn('regex', '\\d+', 'g') as RegExp;
    expect(fn('isregexmatch', 'abc123', re)).toBe(true);
    expect(fn('replaceregex', 'a1b2', fn('regex', '\\d', 'g'), '#')).toBe('a#b#');
  });

  it('isnull / isnotnull / local; getGlobal needs context (null by default)', () => {
    expect(fn('isnull', '')).toBe(true);
    expect(fn('isnull', 'x')).toBe(false);
    expect(fn('isnotnull', 'x')).toBe(true);
    expect(fn('local', 'value')).toBe('value');
    expect(fn('getglobal', 'AnyConstant')).toBeNull(); // no globals → null, not true
  });
});

describe('formFunctions', () => {
  it('GetGlobal returns the named global constant value', () => {
    const f = formFunctions({ globals: { EnableTicketClassification: 'False', Foo: 'Bar' } });
    expect(f['getglobal']?.(['EnableTicketClassification'])).toBe('False');
    expect(f['getglobal']?.(['Foo'])).toBe('Bar');
    expect(f['getglobal']?.(['Missing'])).toBeNull();
  });

  it('composes current-user + clock + getGlobal', () => {
    const f = formFunctions({
      user: { loginId: 'admin' },
      now: () => new Date(Date.UTC(2026, 0, 1)),
      globals: { X: '1' },
    });
    expect(f['currentloginid']?.([])).toBe('admin');
    expect((f['now']?.([]) as Date).getUTCFullYear()).toBe(2026);
    expect(f['getglobal']?.(['X'])).toBe('1');
  });
});

describe('currentUserFunctions', () => {
  it('reads injected session values', () => {
    const f = currentUserFunctions({
      loginId: 'admin',
      displayName: 'Ada',
      email: 'ada@x.com',
      roleId: 'R1',
      teamNames: ['Service Desk', 'Network'],
      teamIds: ['T1', 'T2'],
      identityType: 'Employee#',
      fields: { Region: 'EMEA', RecId: 'USR1' },
    });
    expect(f['currentloginid']?.([])).toBe('admin');
    // CurrentUserName aliases the login id (compared against CreatedBy etc.).
    expect(f['currentusername']?.([])).toBe('admin');
    expect(f['currentuserdisplayname']?.([])).toBe('Ada');
    expect(f['currentuseremail']?.([])).toBe('ada@x.com');
    expect(f['currentuserrole']?.([])).toBe('R1');
    expect(f['currentuserfield']?.(['Region'])).toBe('EMEA');
    expect(f['currentuserinteam']?.(['network'])).toBe(true); // case-insensitive
    expect(f['currentuserinteam']?.(['Sales'])).toBe(false);
    expect(f['currentuseridentitytype']?.([])).toBe('Employee'); // trailing # stripped
    expect(f['currentuserrecid']?.([])).toBe('USR1');
    expect(f['currentuserteamids']?.([])).toEqual(['T1', 'T2']);
  });

  it('returns null for unset values', () => {
    const f = currentUserFunctions({});
    expect(f['currentusername']?.([])).toBeNull();
    expect(f['currentuserrecid']?.([])).toBeNull();
    expect(f['currentuserteamids']?.([])).toBeNull();
  });
});

describe('clockFunctions', () => {
  const now = () => new Date(Date.UTC(2026, 3, 11, 9, 30, 0)); // 2026-04-11 09:30 UTC
  const f = clockFunctions(now);

  it('current date/time read the injected clock', () => {
    expect((f['now']?.([]) as Date).getTime()).toBe(now().getTime());
    expect((f['today']?.([]) as Date).getUTCHours()).toBe(0); // start of day
    expect((f['tomorrow']?.([]) as Date).getUTCDate()).toBe(12);
    expect((f['yesterday']?.([]) as Date).getUTCDate()).toBe(10);
  });

  it('add / dateAdd / dateDiff / datePart', () => {
    const base = '2026-04-11T00:00:00Z';
    expect((f['adddays']?.([5, base]) as Date).getUTCDate()).toBe(16);
    expect((f['dateadd']?.(['day', 2, base]) as Date).getUTCDate()).toBe(13);
    expect(f['datediff']?.(['day', '2026-04-13T00:00:00Z', base])).toBe(2);
    expect(f['datepart']?.(['month', base])).toBe(4);
    expect(f['datepart']?.(['year', base])).toBe(2026);
  });

  it('diff in whole units and month/year', () => {
    expect(f['diffdays']?.(['2026-04-11T00:00:00Z', '2026-04-14T00:00:00Z'])).toBe(3);
    expect(f['diffmonths']?.(['2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z'])).toBe(3);
  });

  it('beginningOf / endOf', () => {
    expect((f['beginningofmonth']?.(['2026-04-11T09:00:00Z']) as Date).getUTCDate()).toBe(1);
    expect((f['endofyear']?.(['2026-04-11T09:00:00Z']) as Date).getUTCMonth()).toBe(11); // December
  });
});

describe('date functions — edge cases', () => {
  const now = () => new Date(Date.UTC(2026, 3, 11, 9, 30, 0));
  const f = clockFunctions(now);

  it('toDate rejects garbage: invalid / null / boolean inputs degrade gracefully', () => {
    expect(f['adddays']?.([5, 'not-a-date'])).toBeNull(); // unparseable string
    expect(f['adddays']?.([5, null])).toBeNull(); // null
    expect(f['adddays']?.([5, true])).toBeNull(); // wrong type
    expect(f['datepart']?.(['day', 'nope'])).toBeNull();
    expect(f['formatdate']?.([null])).toBe(''); // empty string, not throw
    expect(f['formatdatetime']?.(['bad'])).toBe('');
    expect(f['beginningofday']?.(['bad'])).toBeNull();
  });

  it('toDate accepts a numeric epoch and a Date instance', () => {
    const epoch = Date.UTC(2026, 0, 2);
    expect((f['adddays']?.([0, epoch]) as Date).getUTCDate()).toBe(2);
    const d = new Date(Date.UTC(2026, 5, 15));
    expect((f['adddays']?.([1, d]) as Date).getUTCDate()).toBe(16);
  });

  it('every add<Unit> shifts by the right field', () => {
    const base = '2026-04-11T09:30:00Z';
    expect((f['addyears']?.([1, base]) as Date).getUTCFullYear()).toBe(2027);
    expect((f['addquarters']?.([1, base]) as Date).getUTCMonth()).toBe(6); // +3 months → July
    expect((f['addmonths']?.([2, base]) as Date).getUTCMonth()).toBe(5); // June
    expect((f['addweeks']?.([1, base]) as Date).getUTCDate()).toBe(18);
    expect((f['addhours']?.([5, base]) as Date).getUTCHours()).toBe(14);
    expect((f['addminutes']?.([45, base]) as Date).getUTCMinutes()).toBe(15); // 30+45 → :15 next hr
    expect((f['addseconds']?.([30, base]) as Date).getUTCSeconds()).toBe(30);
  });

  it('add<Unit> with a non-numeric offset defaults to 0', () => {
    const base = '2026-04-11T00:00:00Z';
    expect((f['adddays']?.(['x', base]) as Date).getUTCDate()).toBe(11); // unchanged
  });

  it('dateAdd handles the millisecond special-case and a bad date', () => {
    const base = '2026-04-11T00:00:00.000Z';
    expect((f['dateadd']?.(['millisecond', 250, base]) as Date).getUTCMilliseconds()).toBe(250);
    expect((f['dateadd']?.(['hour', 3, base]) as Date).getUTCHours()).toBe(3);
    expect(f['dateadd']?.(['day', 1, 'bad'])).toBeNull();
    expect((f['dateadd']?.(['day', 'x', base]) as Date).getUTCDate()).toBe(11); // offset → 0
  });

  it('dateDiff ceils, returns null on a bad date or unknown interval', () => {
    // 25 hours apart → ceil(25/24) = 2 days.
    expect(f['datediff']?.(['day', '2026-04-13T01:00:00Z', '2026-04-12T00:00:00Z'])).toBe(2);
    expect(f['datediff']?.(['day', 'bad', '2026-04-12T00:00:00Z'])).toBeNull();
    expect(f['datediff']?.(['fortnight', '2026-04-13T00:00:00Z', '2026-04-12T00:00:00Z'])).toBeNull();
  });

  it('datePart covers every component and an unknown part', () => {
    const base = '2026-04-11T09:30:45.123Z'; // Sat, 2026-04-11
    expect(f['datepart']?.(['millisecond', base])).toBe(123);
    expect(f['datepart']?.(['second', base])).toBe(45);
    expect(f['datepart']?.(['minute', base])).toBe(30);
    expect(f['datepart']?.(['hour', base])).toBe(9);
    expect(f['datepart']?.(['dayofyear', base])).toBe(101); // Jan(31)+Feb(28)+Mar(31)+11
    expect(f['datepart']?.(['weekday', base])).toBe(7); // Saturday → getUTCDay 6 + 1
    expect(f['datepart']?.(['quarter', base])).toBe(2);
    expect(f['datepart']?.(['bogus', base])).toBeNull();
  });

  it('diff<Unit> truncates and is null on a bad date', () => {
    expect(f['diffseconds']?.(['2026-04-11T00:00:00Z', '2026-04-11T00:00:09Z'])).toBe(9);
    expect(f['diffminutes']?.(['2026-04-11T00:00:00Z', '2026-04-11T00:01:30Z'])).toBe(1); // trunc
    expect(f['diffhours']?.(['2026-04-11T00:00:00Z', '2026-04-11T05:00:00Z'])).toBe(5);
    expect(f['diffweeks']?.(['2026-04-01T00:00:00Z', '2026-04-15T00:00:00Z'])).toBe(2);
    expect(f['diffdays']?.(['bad', '2026-04-15T00:00:00Z'])).toBeNull();
  });

  it('month-based diffs truncate and are null on a bad date', () => {
    expect(f['diffquarters']?.(['2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z'])).toBe(2);
    expect(f['diffyears']?.(['2024-06-01T00:00:00Z', '2026-04-01T00:00:00Z'])).toBe(1); // 22mo → 1yr
    expect(f['diffmonths']?.(['2026-04-01T00:00:00Z', 'bad'])).toBeNull();
  });

  it('endOf day/month and beginningOf year hit each unit branch', () => {
    const base = '2026-02-15T09:00:00Z'; // Feb (non-leap-relevant)
    expect((f['endofday']?.([base]) as Date).getUTCHours()).toBe(23);
    expect((f['endofmonth']?.([base]) as Date).getUTCDate()).toBe(28); // last day of Feb 2026
    expect((f['beginningofyear']?.([base]) as Date).getUTCMonth()).toBe(0); // January
  });

  it('the start-of-day clock helpers derive from the injected now', () => {
    expect((f['currentdate']?.([]) as Date).getUTCHours()).toBe(0);
    expect((f['currentdatetime']?.([]) as Date).getTime()).toBe(now().getTime());
    expect((f['currentutcdatetime']?.([]) as Date).getTime()).toBe(now().getTime());
    expect(typeof f['currentdatestr']?.([])).toBe('string');
  });
});

describe('string functions — edge cases', () => {
  it('null / empty handling returns null (not the string "null")', () => {
    expect(fn('trim', null)).toBeNull();
    expect(fn('tolowercase', '')).toBeNull(); // not present
    expect(fn('touppercase', null)).toBeNull();
    expect(fn('touppercasefirst', null)).toBeNull();
    expect(fn('tostring', null)).toBeNull();
    expect(fn('substring', null, 1, 2)).toBeNull();
    expect(fn('substring0', null, 0, 2)).toBeNull();
  });

  it('touppercasefirst trims to empty for whitespace-only input', () => {
    expect(fn('touppercasefirst', '   ')).toBe('');
  });

  it('tostring formats a numeric value with decimals, else stringifies', () => {
    expect(fn('tostring', 3.5, 2)).toBe('3.50'); // both numeric → formatNumber
    expect(fn('tostring', 'plain')).toBe('plain'); // non-numeric → str
  });

  it('find against an absent haystack searches the empty string', () => {
    expect(fn('find', 'x')).toBe(-1); // haystack null → ''.indexOf('x')
    expect(fn('find', '', 'abc')).toBe(0);
  });

  it('padLeft / padRight: already-wide text and a multi-char fill', () => {
    expect(fn('padleft', 'abcd', '0', 2)).toBe('abcd'); // already >= width
    expect(fn('padright', 'abcd', '0', 2)).toBe('abcd');
    expect(fn('padleft', 'x', 'ab', 5)).toBe('ababx'); // multi-char fill clipped to width
    expect(fn('padright', 'x', 'ab', 5)).toBe('xabab');
    expect(fn('padleft', null, '0', 3)).toBe(''); // missing value → ''
    expect(fn('padleft', 'x', null, 3)).toBe('x'); // missing pad char → text unchanged
  });

  it('stringBefore covers every mode and the not-found / leading-separator cases', () => {
    expect(fn('stringbefore', 'line1\nword.rest', 'FROMSTARTOFLINE', '.')).toBe('word');
    expect(fn('stringbefore', 'foo bar.baz', 'PREVIOUSWORD', '.')).toBe('bar');
    expect(fn('stringbefore', 'id 42.tail', 'PREVIOUSNUMBER', '.')).toBe('42');
    expect(fn('stringbefore', 'abc.def', 'UNKNOWN', '.')).toBeNull();
    expect(fn('stringbefore', '.leading', 'FROMSTART', '.')).toBeNull(); // sep at index 0
    expect(fn('stringbefore', 'no-sep', 'FROMSTART', '.')).toBeNull(); // not found
    expect(fn('stringbefore', null, 'FROMSTART', '.')).toBeNull(); // missing arg
  });

  it('stringAfter covers every mode and the not-found case', () => {
    expect(fn('stringafter', 'a. next more', 'NEXTWORD', '.')).toBe('next');
    expect(fn('stringafter', 'a.  abc42', 'NEXTNUMBER', '.')).toBe('42');
    expect(fn('stringafter', 'a.tail\nmore', 'TOENDOFLINE', '.')).toBe('tail');
    expect(fn('stringafter', 'a.b.c', 'UNKNOWN', '.')).toBeNull();
    expect(fn('stringafter', 'no-sep', 'TOEND', '.')).toBeNull(); // not found
    expect(fn('stringafter', 'a.b', 'NEXTNUMBER', '.')).toBeNull(); // no digit after sep
    expect(fn('stringafter', 'a.', 'TOEND', null)).toBeNull(); // missing sep
  });

  it('formatNumber returns "" for a missing value', () => {
    expect(fn('formatnumber', null, 2)).toBe('');
    expect(fn('formatnumber', '', 2)).toBe('');
  });
});

describe('math functions — edge cases', () => {
  it('round / roundUp / roundDown / truncate / absoluteValue on a missing value → ""', () => {
    expect(fn('round', null, 2)).toBe('');
    expect(fn('roundup', '')).toBe('');
    expect(fn('rounddown', null)).toBe('');
    expect(fn('truncate', null)).toBe('');
    expect(fn('absolutevalue', '')).toBe('');
  });

  it('round defaults to 0 decimals when none given', () => {
    expect(fn('round', 3.6)).toBe('4');
  });

  it('truncate / absoluteValue reject non-numeric present values with ""', () => {
    expect(fn('truncate', 'abc')).toBe('');
    expect(fn('absolutevalue', 'abc')).toBe('');
    expect(fn('truncate', '3.9')).toBe(3); // numeric string is fine
  });

  it('numericEmpty distinguishes blank from zero', () => {
    expect(fn('numericempty', null)).toBe(true);
    expect(fn('numericempty', '')).toBe(true);
    expect(fn('numericempty', '0')).toBe(false);
  });

  it('numericFormat covers every type and the unknown-type / missing-value paths', () => {
    expect(fn('numericformat', 1234.5, 'NUMBER', 2)).toBe('1,234.50');
    expect(fn('numericformat', 1234.5, 'FIXEDPOINT', 1)).toBe('1234.5');
    expect(fn('numericformat', 1234.5, 'CURRENCY', 2)).toBe('$1,234.50');
    expect(fn('numericformat', 0.5, 'PERCENT', 0)).toBe('1%'); // 0.5 rounded, then "%"
    expect(fn('numericformat', 255, 'HEXADECIMAL')).toBe('FF');
    expect(fn('numericformat', 1500, 'SCIENTIFIC')).toBe('1.5e+3');
    expect(fn('numericformat', 42, 'GENERAL')).toBe('42');
    expect(fn('numericformat', 1, 'NOPE')).toBeUndefined(); // unknown type
    expect(fn('numericformat', null, 'NUMBER')).toBeUndefined(); // missing value
  });

  it('numericFormat defaults to 2 decimals when the decimals arg is not a number', () => {
    expect(fn('numericformat', 5, 'FIXEDPOINT', 'x')).toBe('5.00');
  });

  it('currencyValue strips symbols and returns null only for an actual null', () => {
    expect(fn('currencyvalue', '€1.234,5')).toBe(1.2345); // strips €, commas
    expect(fn('currencyvalue', null)).toBeNull();
    // All-letters strips to '' and Number('') is 0 (not NaN), so it yields 0, not null.
    expect(fn('currencyvalue', 'free')).toBe(0);
    expect(fn('currencyvalue', '-$3.50')).toBe(-3.5); // keeps the sign
  });
});
