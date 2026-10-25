// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

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
 * The value rule hidden in `ConfigOptions`, such as `$(StartDate>=CurrentDate()+14)`.
 *
 * It is the only place a date's lower bound is written: `Description` says "Minimum two weeks lead
 * time" in words, and a submit that breaks the rule is a refusal the caller was never shown the
 * cause of. The rest of `ConfigOptions` is layout (widths, margins) and is dropped.
 */
export function valueRule(configOptions: unknown): string | undefined {
  if (typeof configOptions !== 'string' || configOptions.trim() === '') return undefined;

  try {
    const parsed = JSON.parse(configOptions) as {
      configData?: { dateValidation?: { expr?: unknown } };
    };
    const expr = parsed.configData?.dateValidation?.expr;
    return typeof expr === 'string' && expr !== '' ? expr : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The parameters of this form an expression reads.
 *
 * Quoted strings are dropped first, so `ComputerType != "Desktop"` reads `ComputerType` and not a
 * parameter that happens to be called `Desktop`. Only names the form actually has are returned:
 * the expression language has its own words (`true`, `and`) that are not answers.
 */
export function referencedParameters(expression: unknown, names: ReadonlySet<string>): string[] {
  if (typeof expression !== 'string') return [];

  const bare = expression.replace(/"[^"]*"|'[^']*'/g, ' ');
  const found = new Set<string>();
  for (const token of bare.match(/[A-Za-z0-9_]+/g) ?? []) {
    if (names.has(token)) found.add(token);
  }
  return [...found];
}

/**
 * Adds the decoded fields beside the raw ones.
 *
 * The originals are kept: a conditional rule still needs its expression, and dropping it would
 * hide *why* `required` is absent.
 *
 * `names` is every parameter name on the form. With it the two ways one answer can depend on
 * another are named, and they are different jobs:
 *   - `filteredBy`: the OPTIONS of this list depend on those answers (a constraint).
 *   - `conditionedOn`: whether this parameter is SHOWN or REQUIRED depends on those answers.
 * Neither is evaluated here — a conditional rule is Ivanti's to judge — only pointed at.
 */
export function decodeParameter(
  row: Record<string, unknown>,
  names: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const decoded = { ...row };

  const required = literalRequired(row['RequiredExpression']);
  if (required !== undefined) decoded['required'] = required;

  const constraints = parseConstraints(row['ValidationConstraints']);
  if (constraints.length > 0) {
    decoded['constraints'] = constraints;
    const parents = constraints
      .map((constraint) => constraint.FormFieldName)
      .filter((name): name is string => typeof name === 'string' && name !== '');
    if (parents.length > 0) decoded['filteredBy'] = parents;
  }

  const rule = valueRule(row['ConfigOptions']);
  if (rule !== undefined) decoded['valueRule'] = rule;
  // Layout, not an answer — and ~600 characters on every parameter.
  delete decoded['ConfigOptions'];

  const own = row['Name'];
  const conditions = [
    ...new Set([
      ...referencedParameters(row['VisibilityExpression'], names),
      ...referencedParameters(row['RequiredExpression'], names),
    ]),
  ].filter((name) => name !== own);
  if (conditions.length > 0) decoded['conditionedOn'] = conditions;

  return decoded;
}
