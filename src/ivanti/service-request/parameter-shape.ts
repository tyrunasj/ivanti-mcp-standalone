/**
 * Two shapes in Ivanti's Service Request parameter rows that read as one thing and mean another.
 *
 * `RequiredExpression` is an **expression**, and it is a string either way — so a plain
 * truthiness test makes an optional field look mandatory. Three literal forms appear in stock
 * templates: `true`, `$(true)` and `$(false)`.
 *
 * `ValidationConstraints` arrives as a JSON **string**, so a caller would otherwise have to parse
 * it before it could ask for the parameter's options.
 */

export interface ParameterConstraint {
  /** Pass as `queryFieldName` when asking for options. */
  ConstraintFieldName?: string;
  /** The parameter whose chosen value fills that constraint. */
  FormFieldName?: string;
  [key: string]: unknown;
}

/**
 * Resolves a required-expression to a boolean when it says so outright.
 *
 * Undefined means **"cannot say"**, never "no": a conditional rule depends on other fields and
 * only Ivanti can evaluate it.
 */
export function literalRequired(expression: unknown): boolean | undefined {
  if (typeof expression !== 'string') return undefined;

  const normalized = expression.trim().toLowerCase();
  if (normalized === 'true' || normalized === '$(true)') return true;
  if (normalized === 'false' || normalized === '$(false)') return false;
  return undefined;
}

/** Parses the JSON-string constraints; anything unparseable yields none. */
export function parseConstraints(raw: unknown): ParameterConstraint[] {
  if (Array.isArray(raw)) return raw as ParameterConstraint[];
  if (typeof raw !== 'string' || raw.trim() === '') return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ParameterConstraint[]) : [];
  } catch {
    return [];
  }
}

/**
 * Adds the decoded fields beside the raw ones.
 *
 * The originals are kept: a conditional rule still needs its expression, and dropping it would
 * hide *why* `required` is absent.
 */
export function decodeParameter(row: Record<string, unknown>): Record<string, unknown> {
  const decoded = { ...row };

  const required = literalRequired(row['RequiredExpression']);
  if (required !== undefined) decoded['required'] = required;

  const constraints = parseConstraints(row['ValidationConstraints']);
  if (constraints.length > 0) decoded['constraints'] = constraints;

  return decoded;
}
