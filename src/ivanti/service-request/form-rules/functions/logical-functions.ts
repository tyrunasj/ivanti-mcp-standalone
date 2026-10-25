// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

// Logical / null functions (used heavily by read-only/required rules): isNull,
// isNotNull, the `Local(x)` timezone passthrough, and the no-context `GetGlobal`
// placeholder (the real one is supplied by `formFunctions` with the globals map).

import { present } from './coercion.js'
import type { FunctionTable } from './coercion.js';

export const LOGICAL_FUNCTIONS: FunctionTable = {
  isnull: (a) => !present(a[0]),
  isnotnull: (a) => present(a[0]),
  // `Local(x)` is a timezone-localizing passthrough; we keep the value as-is.
  local: (a) => a[0],
  // GetGlobal needs the global-constants map → see `formFunctions`. Without it
  // (no context) it yields null rather than a misleading `true`.
  getglobal: () => null,
};
