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
  | { kind: 'typed-literal'; literal: string };

/** Tokens that may legitimately precede `(` — logical operators, not functions. */
const OPERATORS = new Set(['not', 'and', 'or']);

/** OData v2 typed literals Ivanti rejects. */
const TYPED_LITERAL = /\b(datetime|datetimeoffset|guid|time|binary|X)'/i;

/**
 * Replaces the contents of single-quoted literals with `~`, preserving length and the `''`
 * escape, so that a value containing `(` or the word `datetime` cannot trip the scan.
 *
 * The mask character must not be a word character: masking with `x` made every `'a'` look like
 * the OData v2 binary literal `X'…'`, which the tests caught.
 */
export function maskStringLiterals(filter: string): string {
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

  return masked;
}

export function findUnsupportedFilter(filter: string): UnsupportedFilter | undefined {
  const masked = maskStringLiterals(filter);

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
  return unsupported.kind === 'function'
    ? `Ivanti's $filter has no functions — '${unsupported.name}()' would be silently ignored and ` +
        'the full unfiltered set returned. Use equality/comparison operators, or a full-text search.'
    : `Ivanti rejects the OData v2 typed literal ${unsupported.literal}. Write the value plainly.`;
}

/** Throws when the filter uses a construct Ivanti would silently drop or refuse. */
export function assertSupportedFilter(filter: string | undefined): void {
  if (filter === undefined || filter.trim() === '') return;
  const unsupported = findUnsupportedFilter(filter);
  if (unsupported) throw new Error(describeUnsupportedFilter(unsupported));
}
