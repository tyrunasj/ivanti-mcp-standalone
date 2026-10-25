// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

// Type-conversion functions: number, boolean, dateTime.

import type { FunctionTable } from './coercion.js';

export const CONVERSION_FUNCTIONS: FunctionTable = {
  number: (a) => (a[0] == null ? null : Number(a[0]).toString()),
  boolean: (a) =>
    a[0] == null ? null : typeof a[0] === 'string' ? a[0].toUpperCase() === 'TRUE' : !!a[0],
  datetime: (a) => (a[0] == null ? null : new Date(a[0] as string)),
};
