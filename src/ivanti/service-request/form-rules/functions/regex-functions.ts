// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

// Regex functions: regex (compile), isRegexMatch, firstRegexMatch, replaceRegex.

import { str, type FunctionTable } from './coercion.js';

export const REGEX_FUNCTIONS: FunctionTable = {
  regex: (a) => new RegExp(str(a[0]), a[1] == null ? undefined : str(a[1])),
  isregexmatch: (a) => (a[1] as RegExp).test(String(a[0])),
  firstregexmatch: (a) => (a[1] as RegExp).exec(String(a[0])),
  replaceregex: (a) => String(a[0]).replace(a[1] as RegExp, String(a[2])),
};
