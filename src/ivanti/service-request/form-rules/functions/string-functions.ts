// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

// String functions: find, len, padLeft/Right, substring(0), string{Before,After},
// toLowerCase/UpperCase(First), toString, trim, formatNumber, emptyString.

import { isNumeric } from '../value-predicates.js';
import { formatNumber, present, str } from './coercion.js'
import type { FunctionTable } from './coercion.js';

export const STRING_FUNCTIONS: FunctionTable = {
  emptystring: () => '',
  trim: (a) => (a[0] == null ? null : str(a[0]).replace(/^\s+|\s+$/g, '')),
  tolowercase: (a) => (present(a[0]) ? str(a[0]).toLowerCase() : null),
  touppercase: (a) => (present(a[0]) ? str(a[0]).toUpperCase() : null),
  touppercasefirst: (a) => {
    if (!present(a[0])) {
      return null;
    }
    const s = str(a[0]).trim();
    return s === '' ? s : s.charAt(0).toUpperCase() + s.substring(1);
  },
  tostring: (a) => (present(a[0]) ? toStringFn(a) : null),
  len: (a) => (a[0] == null ? null : str(a[0]).length),
  // find(needle, haystack, start?) → index of needle in haystack.
  find: (a) => {
    const [needle, haystack] = a;
    if (haystack == null) {
      return ''.indexOf(str(needle));
    }
    return a.length >= 3
      ? str(haystack).indexOf(str(needle), Number(a[2]))
      : str(haystack).indexOf(str(needle));
  },
  // substring(value, start, length) — start is 1-based (Ivanti convention).
  substring: (a) => (a[0] == null ? null : str(a[0]).substr(Number(a[1]) - 1, Number(a[2]))),
  // substring0(value, start, length) — start is 0-based.
  substring0: (a) => (a[0] == null ? null : str(a[0]).substr(Number(a[1]), Number(a[2]))),
  padleft: (a) => pad(a, 'left'),
  padright: (a) => pad(a, 'right'),
  stringbefore: (a) => stringBefore(a[0], a[1], a[2]),
  stringafter: (a) => stringAfter(a[0], a[1], a[2]),
  formatnumber: (a) => formatNumber(a[0], a[1]),
};

function toStringFn(a: unknown[]): string {
  const [value, decimals] = a;
  return isNumeric(value) && isNumeric(decimals) ? formatNumber(value, decimals) : str(value);
}

function pad(a: unknown[], side: 'left' | 'right'): string {
  if (!present(a[0])) {
    return '';
  }
  const text = str(a[0]);
  const padChar = a[1];
  if (!present(padChar)) {
    return text;
  }
  const fill = str(padChar);
  const width = Number(a[2]) || 0;
  if (side === 'left') {
    if (text.length >= width) {
      return text;
    }
    return (
      fill
        .repeat(Math.ceil((width - text.length) / fill.length))
        .substring(0, width - text.length) + text
    );
  }
  return text.length < width ? (text + fill.repeat(width - text.length)).substring(0, width) : text;
}

function stringAfter(value: unknown, mode: unknown, sep: unknown): string | null {
  if (!present(value) || !present(mode) || !present(sep)) {
    return null;
  }
  const text = str(value);
  const at = text.indexOf(str(sep));
  if (at < 0) {
    return null;
  }
  const rest = text.substring(at + str(sep).length);
  switch (str(mode).toUpperCase()) {
    case 'NEXTWORD':
      return rest.trimStart().match(/^\S*/)?.[0] ?? '';
    case 'NEXTNUMBER':
      return rest.match(/^\D*(\d+)/)?.[1] ?? null;
    case 'TOEND':
      return rest.trim();
    case 'TOENDOFLINE':
      return (rest.split('\n')[0] ?? '').trim();
    default:
      return null;
  }
}

function stringBefore(value: unknown, mode: unknown, sep: unknown): string | null {
  if (!present(value) || !present(mode) || !present(sep)) {
    return null;
  }
  const text = str(value);
  const at = text.indexOf(str(sep));
  if (at <= 0) {
    return null;
  }
  const head = text.substring(0, at);
  switch (str(mode).toUpperCase()) {
    case 'FROMSTART':
      return head.trim();
    case 'FROMSTARTOFLINE':
      return (head.split('\n').at(-1) ?? '').trim();
    case 'PREVIOUSWORD':
      return head.trimEnd().match(/\S*$/)?.[0] ?? '';
    case 'PREVIOUSNUMBER':
      return head.match(/(\d+)\D*$/)?.[1] ?? null;
    default:
      return null;
  }
}
