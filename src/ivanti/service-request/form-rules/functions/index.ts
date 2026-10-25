// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

// The function library for Ivanti rule expressions (Kind 5 nodes). Mirrors the
// `functionObjects` injected into Ivanti's own `ExpressionEvaluator`: the
// evaluator lowercases `FunctionName` and dispatches to one of these. Every
// function takes the evaluated argument list (an array).
//
// Extracted from the Ivanti web bundle as one family per module:
//   string · math · conversion · regex · logical/null   → pure (no context)
//   current-user · date/time                             → context-dependent
//
// `DEFAULT_FUNCTIONS` holds the pure families. The context-dependent ones are
// produced by `currentUserFunctions()` (session) and `clockFunctions()` (current
// date/time) so callers inject live values instead of the evaluator reaching for
// globals — keeping evaluation pure and testable. `formFunctions()` composes the
// per-form context (user + clock + GetGlobal) the rule engine merges on top.

import type { FunctionTable } from './coercion.js';
import { STRING_FUNCTIONS } from './string-functions.js';
import { MATH_FUNCTIONS } from './math-functions.js';
import { CONVERSION_FUNCTIONS } from './conversion-functions.js';
import { REGEX_FUNCTIONS } from './regex-functions.js';
import { LOGICAL_FUNCTIONS } from './logical-functions.js';
import { currentUserFunctions, type CurrentUserContext } from './current-user-functions.js';
import { clockFunctions } from './date-functions.js';

export type { FunctionTable } from './coercion.js';
export { str } from './coercion.js';
export type { CurrentUserContext } from './current-user-functions.js';
export { currentUserFunctions } from './current-user-functions.js';
export { clockFunctions } from './date-functions.js';

// The pure built-ins (no runtime context), assembled from each family's table.
export const DEFAULT_FUNCTIONS: FunctionTable = {
  ...STRING_FUNCTIONS,
  ...MATH_FUNCTIONS,
  ...CONVERSION_FUNCTIONS,
  ...REGEX_FUNCTIONS,
  ...LOGICAL_FUNCTIONS,
};

export interface FormFunctionContext {
  // Signed-in user, for the current-user functions.
  user?: CurrentUserContext;
  // Clock for current date/time functions.
  now?: () => Date;
  // Global constants (name → value) for `GetGlobal`.
  globals?: Record<string, unknown>;
}

// The context-dependent functions a form rule needs on top of the pure built-ins:
// current-user, current date/time, and `GetGlobal`. Merge over `DEFAULT_FUNCTIONS`
// (the evaluator does this when given `{ functions }`).
export function formFunctions(ctx: FormFunctionContext): FunctionTable {
  return {
    ...(ctx.user ? currentUserFunctions(ctx.user) : {}),
    ...(ctx.now ? clockFunctions(ctx.now) : {}),
    // GetGlobal(name) → the admin-defined global constant's value.
    getglobal: (a) => ctx.globals?.[String(a[0])] ?? null,
  };
}
