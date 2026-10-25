// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

// Math functions: round, roundUp/Down, truncate, absoluteValue, numericEmpty,
// numericFormat, currencyValue.

import { isNumeric } from '../value-predicates.js';
import { num, present, str, type FunctionTable } from './coercion.js';

export const MATH_FUNCTIONS: FunctionTable = {
  round: (a) => (present(a[0]) ? num(a[0]).toFixed(Number(a[1]) || 0) : ''),
  roundup: (a) => (present(a[0]) ? Math.ceil(num(a[0])) : ''),
  rounddown: (a) => (present(a[0]) ? Math.floor(num(a[0])) : ''),
  truncate: (a) => (present(a[0]) ? (isNumeric(a[0]) ? Math.trunc(num(a[0])) : '') : ''),
  absolutevalue: (a) => (present(a[0]) ? (isNumeric(a[0]) ? Math.abs(num(a[0])) : '') : ''),
  numericempty: (a) => a[0] == null || a[0] === '',
  numericformat: (a) => numericFormat(a),
  // Currency is surfaced as its plain numeric value here.
  currencyvalue: (a) => {
    if (a[0] == null) {
      return null;
    }
    const value = Number(str(a[0]).replace(/[^0-9.-]+/g, ''));
    return Number.isNaN(value) ? null : value;
  },
};

// Ivanti's `numericFormat(value, type, decimals)` — Intl-based.
function numericFormat(a: unknown[]): string | undefined {
  const value = a[0];
  if (!present(value)) {
    return undefined;
  }
  const n = Number(value);
  const decimals = Number.isNaN(Number(a[2])) ? 2 : parseInt(String(a[2]), 10);
  const fixed = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  switch (String(a[1]).toUpperCase()) {
    case 'NUMBER':
      return new Intl.NumberFormat('en-US', fixed).format(n);
    case 'FIXEDPOINT':
      return n.toFixed(decimals);
    case 'CURRENCY':
      return new Intl.NumberFormat('en-US', {
        ...fixed,
        style: 'currency',
        currency: 'USD',
      }).format(n);
    case 'PERCENT':
      return new Intl.NumberFormat('en-US', fixed).format(n) + '%';
    case 'HEXADECIMAL':
      return n.toString(16).toUpperCase();
    case 'SCIENTIFIC':
      return n.toExponential();
    case 'GENERAL':
      return n.toString();
    default:
      return undefined;
  }
}
