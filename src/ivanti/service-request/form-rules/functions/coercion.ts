// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

// Shared value coercions for the Ivanti expression-function families: the
// present/missing predicate and the number/string conversions Ivanti applies
// wherever a value is coerced. Each family imports what it needs from here.

// Function name (lowercased) → implementation taking the evaluated argument list.
export type FunctionTable = Record<string, (args: unknown[]) => unknown>;

export function present(value: unknown): boolean {
  return value != null && value !== '';
}

export function num(value: unknown): number {
  return Number(value);
}

export function str(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (value instanceof Date) {
    return formatDateTime(value);
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

// Ivanti's `formatNumber(value, decimals)` — normalises a comma decimal then fixes.
export function formatNumber(value: unknown, decimals: unknown): string {
  if (!present(value)) {
    return '';
  }
  const normalised = str(value).replace(/,/g, '.');
  return Number.parseFloat(normalised).toFixed(Number(decimals) || 0);
}

// `convertToString` of a Date → `MM/dd/yyyy h:mm aa` (Ivanti's default). Ivanti
// formats a Date wherever it's coerced to a string (e.g. string concatenation).
export function formatDateTime(date: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  let h = date.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${p2(date.getUTCMonth() + 1)}/${p2(date.getUTCDate())}/${date.getUTCFullYear()} ${h}:${p2(date.getUTCMinutes())} ${ampm}`;
}
