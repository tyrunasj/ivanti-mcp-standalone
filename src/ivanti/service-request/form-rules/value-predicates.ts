// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

// Whether a value cleanly parses as a number — the shared predicate Ivanti uses
// both to coerce string operands before arithmetic/ordering (the evaluator) and
// in the numeric expression functions. Centralised so the two expression modules
// stay in lock-step.
export function isNumericString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value));
}

// Whether a value participates in numeric operations — a number, or a string that
// cleanly parses as one. Used by the evaluator (numeric `+` vs concat, ordering)
// and the numeric expression functions, kept here so both stay in lock-step.
export function isNumeric(value: unknown): boolean {
  return typeof value === 'number' || isNumericString(value);
}
