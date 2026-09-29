// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * Guard for Ivanti's OData `$filter` dialect.
 *
 * **Ivanti's `$filter` has no functions, and says nothing when you use one.** `contains()`,
 * `startswith()`, `endswith()`, `year()` and friends are silently dropped and the server returns
 * the **full unfiltered set** — a 200 with every row, which a caller reads as a filtered result.
 * `substringof()` and OData v2 typed literals (`datetime'…'`) are refused outright.
 *
 * A silently-dropped filter is worse than an error because the answer looks right, so this
 * refuses locally instead of letting the request reach the wire. Use `search` or
 * `fulltext_search_object` for substring matching.
 *
 * Returns a *fact* about what was unsupported; the sentence the model reads is the tools layer's
 * job.
 */
export type UnsupportedFilter =
  | { kind: 'function'; name: string }
  | { kind: 'typed-literal'; literal: string }
  | { kind: 'unbalanced-parentheses'; detail: 'closes-unopened' | 'left-open' }
  | { kind: 'unterminated-string' };

/** Tokens that may legitimately precede `(` — logical operators, not functions. */
const OPERATORS = new Set(['not', 'and', 'or']);

/** OData v2 typed literals Ivanti rejects. */
const TYPED_LITERAL = /\b(datetime|datetimeoffset|guid|time|binary|X)'/i;

/** One pass over the filter's quoting: the masked text, and whether a literal was left open. */
function scanStringLiterals(filter: string): { masked: string; unterminated: boolean } {
  let masked = '';
  let inString = false;

  for (let i = 0; i < filter.length; i += 1) {
    const char = filter[i] ?? '';
    if (char === "'") {
      // A doubled quote inside a string is an escaped quote, not a terminator.
      if (inString && filter[i + 1] === "'") {
        masked += "~~";
        i += 1;
        continue;
      }
      inString = !inString;
      masked += "'";
      continue;
    }
    masked += inString ? '~' : char;
  }

  return { masked, unterminated: inString };
}

/**
 * Replaces the contents of single-quoted literals with `~`, preserving length and the `''`
 * escape, so that a value containing `(` or the word `datetime` cannot trip the scan.
 *
 * The mask character must not be a word character: masking with `x` made every `'a'` look like
 * the OData v2 binary literal `X'…'`, which the tests caught.
 */
export function maskStringLiterals(filter: string): string {
  return scanStringLiterals(filter).masked;
}

/**
 * Whether the grouping the caller wrote is the grouping Ivanti will read.
 *
 * This is a boundary, not tidiness. The own-records scope is added as `(<caller's filter>) and
 * <mine>`, which constrains the whole filter only while the caller's parentheses close exactly
 * what they open. `Status eq 'Active') or (Status ne 'x'` closed the wrapper early, and what went
 * out read `(A) or (B) and mine` — everyone's active tickets, in `enduser` mode. Every filter is
 * held to it, not only a scoped one: a `)` closing a group that was never opened means something
 * other than what was written, whoever sends it.
 */
function findUnbalancedParentheses(
  masked: string,
): Extract<UnsupportedFilter, { kind: 'unbalanced-parentheses' }> | undefined {
  let depth = 0;
  for (const char of masked) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) return { kind: 'unbalanced-parentheses', detail: 'closes-unopened' };
  }
  return depth === 0 ? undefined : { kind: 'unbalanced-parentheses', detail: 'left-open' };
}

export function findUnsupportedFilter(filter: string): UnsupportedFilter | undefined {
  const { masked, unterminated } = scanStringLiterals(filter);

  // Structure first. With a quote left open, everything after it was masked as a value, so the
  // scans below would be checking a filter Ivanti will not read the same way.
  if (unterminated) return { kind: 'unterminated-string' };

  const unbalanced = findUnbalancedParentheses(masked);
  if (unbalanced) return unbalanced;

  const typed = TYPED_LITERAL.exec(masked);
  if (typed) return { kind: 'typed-literal', literal: `${typed[1] ?? ''}'…'` };

  // An identifier immediately followed by `(` is a call. Grouping parens are preceded by an
  // operator or nothing, so `not (x eq 1)` and `(a eq 1) and (b eq 2)` both pass.
  const call = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(masked)) !== null) {
    const name = match[1] ?? '';
    if (!OPERATORS.has(name.toLowerCase())) return { kind: 'function', name };
  }

  return undefined;
}

export function describeUnsupportedFilter(unsupported: UnsupportedFilter): string {
  switch (unsupported.kind) {
    case 'function':
      return (
        `Ivanti's $filter has no functions — '${unsupported.name}()' would be silently ignored ` +
        'and the full unfiltered set returned. Use equality/comparison operators, or a full-text ' +
        'search.'
      );
    case 'typed-literal':
      return `Ivanti rejects the OData v2 typed literal ${unsupported.literal}. Write the value plainly.`;
    case 'unbalanced-parentheses':
      return (
        (unsupported.detail === 'closes-unopened'
          ? "This filter's parentheses do not balance: a `)` closes a group that was never opened. "
          : "This filter's parentheses do not balance: a `(` is never closed. ") +
        'Nothing was sent, because Ivanti would group it differently from how it reads. Pair ' +
        'every `(` with its `)`; a parenthesis that belongs to a VALUE goes inside the quotes.'
      );
    case 'unterminated-string':
      return (
        'This filter opens a quoted value and never closes it, so nothing was sent. Close the ' +
        "quote, and write a quote INSIDE a value as two: `Name eq 'O''Brien'`."
      );
  }
}

/**
 * A filter this server refused to send. Distinct from an Ivanti failure: nothing was asked of
 * Ivanti, the caller's query was the problem, and the fix is in the next tool call.
 */
export class UnsupportedFilterError extends Error {
  readonly unsupported: UnsupportedFilter;

  constructor(unsupported: UnsupportedFilter) {
    super(describeUnsupportedFilter(unsupported));
    this.name = 'UnsupportedFilterError';
    this.unsupported = unsupported;
  }
}

/** Throws when the filter uses a construct Ivanti would silently drop, refuse or misread. */
export function assertSupportedFilter(filter: string | undefined): void {
  if (filter === undefined || filter.trim() === '') return;
  const unsupported = findUnsupportedFilter(filter);
  if (unsupported) throw new UnsupportedFilterError(unsupported);
}

/**
 * An unquoted literal: anything that starts with a digit. Ivanti takes dates, times and numbers
 * bare — `2026-01-01T00:00:00Z`, `08:30`, `2.5`, `1e5`, `12.5M` — and each of them carries
 * letters. Anchored on a word boundary, so the digits inside a name (`Field2`) are left alone.
 */
const UNQUOTED_LITERAL = /\b\d[\w:.+-]*/g;

/**
 * Field names a caller referenced in a query, so a rejection can name the one that is wrong.
 *
 * Quoted literals are stripped first: `Status eq 'Owner'` must never report `Owner` as a field.
 * The optional identifier prefix takes an OData v2 typed literal with it, so `datetime'…'` does
 * not leave `datetime` behind looking like a column.
 *
 * Unquoted literals go next, because the tokeniser reads any run of letters as a name: a bare
 * date left `T00` and `Z` behind, and a decimal's `M` suffix a column called `M` — each of which a
 * refusal then offered as a field that does not exist, beside the one that really was wrong.
 */
export function referencedFieldNames(parts: {
  filter?: string | undefined;
  fields?: readonly string[] | undefined;
}): string[] {
  const names = new Set(parts.fields ?? []);

  if (parts.filter !== undefined) {
    const withoutLiterals = parts.filter
      .replace(/(?:[A-Za-z_][A-Za-z0-9_]*)?'(?:[^']|'')*'/g, "''")
      .replace(UNQUOTED_LITERAL, ' ');
    for (const match of withoutLiterals.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const token = match[0];
      if (/^(eq|ne|gt|ge|lt|le|and|or|not|true|false|null)$/i.test(token)) continue;
      names.add(token);
    }
  }

  return [...names];
}
