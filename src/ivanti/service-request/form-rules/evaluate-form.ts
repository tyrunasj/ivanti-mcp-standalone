// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { evaluateExpression, type EvaluateOptions } from './evaluate-expression.js';
import { formFunctions, str, type CurrentUserContext } from './functions/index.js';
import type { FormParameter, RuleExpression } from './form-package.js';

/**
 * What an offering's form looks like given the answers so far — the job the portal's JavaScript
 * does in the browser, and which no Ivanti call performs for anyone else.
 *
 * Mirrors the portal and ivanti-mobile: a hidden parameter is never required; a rule that reads
 * an unanswered parameter sees an empty value. **It informs, never refuses** — a submit is
 * Ivanti's to judge, and a rule this evaluator cannot read is reported as such rather than
 * guessed (`cannotTell`).
 */

/** An answer as a caller holds it: plain, or the `{value, recId}` a combo is submitted with. */
export type AnswerValue = string | number | boolean | { value: string; recId?: string } | null;

export interface OptionsRequest {
  /** What to pass as `constraints` to `get_service_request_parameter_options`. */
  constraints: { queryFieldName: string; value: string }[];
  /** Parents with no answer yet: ask for the options only after these are answered. */
  waitingOn: string[];
}

export interface FormEvaluation {
  visible: string[];
  /** Not on the form given these answers — leave them out. */
  hidden: string[];
  required: string[];
  readOnly: string[];
  /** Visible, required, unanswered and with no default: what still has to be asked. */
  missing: string[];
  /** Answered, but now hidden: drop these before submitting. */
  answeredButHidden: string[];
  /** What the portal pre-fills where unanswered. Send it as the answer unless the person says otherwise. */
  defaults: Record<string, unknown>;
  /** Visible lists filtered by other answers: how to ask for their options. */
  options: Record<string, OptionsRequest>;
  /** Parameters whose rules use something this evaluator does not know, and what. */
  cannotTell: Record<string, string[]>;
  /** Answer keys that match no parameter of this form. */
  unknownAnswers: string[];
}

export interface EvaluateFormInput {
  parameters: FormParameter[];
  /** Keyed by parameter name (the expressions' own spelling) or by template parameter RecId. */
  answers: Record<string, AnswerValue>;
  user?: CurrentUserContext;
  now?: () => Date;
}

/** The plain value an expression sees. A checkbox is `true`/`false`, a combo its value. */
function plain(answer: AnswerValue | undefined): unknown {
  if (answer === undefined || answer === null) return null;
  return typeof answer === 'object' ? answer.value : answer;
}

function isAnswered(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '' && value !== false;
}

export function evaluateForm(input: EvaluateFormInput): FormEvaluation {
  const { parameters, answers } = input;

  const byRecId = new Map(
    parameters.flatMap((parameter) =>
      parameter.recId === undefined ? [] : [[parameter.recId.toLowerCase(), parameter.name] as const],
    ),
  );
  const names = new Set(parameters.map((parameter) => parameter.name));

  // Everything below reads by parameter name, so answers given by RecId are settled to it first.
  const values: Record<string, unknown> = {};
  const unknownAnswers: string[] = [];
  for (const [key, answer] of Object.entries(answers)) {
    const name = names.has(key) ? key : byRecId.get(key.toLowerCase());
    if (name === undefined) unknownAnswers.push(key);
    else values[name] = plain(answer);
  }
  const resolve = (field: string): unknown => values[field];

  const cannotTell: Record<string, string[]> = {};
  const evaluate = (parameter: FormParameter, rule: RuleExpression): unknown => {
    const options: EvaluateOptions = {
      functions: formFunctions({
        ...(input.user === undefined ? {} : { user: input.user }),
        now: input.now ?? ((): Date => new Date()),
      }),
      onUnsupported: (what) => {
        const seen = (cannotTell[parameter.name] ??= []);
        if (!seen.includes(what)) seen.push(what);
      },
    };
    return evaluateExpression(rule.Tree, rule.FieldRefs, resolve, options);
  };

  // Some offerings write the boolean as the string "true" and others as a real one.
  const flag = (parameter: FormParameter, rule: RuleExpression | undefined, fallback: boolean): boolean => {
    if (rule === undefined) return fallback;
    const result = evaluate(parameter, rule);
    return result === true || (typeof result === 'string' && result.trim().toLowerCase() === 'true');
  };

  const evaluation: FormEvaluation = {
    visible: [],
    hidden: [],
    required: [],
    readOnly: [],
    missing: [],
    answeredButHidden: [],
    defaults: {},
    options: {},
    cannotTell,
    unknownAnswers,
  };

  for (const parameter of parameters) {
    // A section heading is not a question, whatever its rules say.
    if (parameter.type === 'category' || parameter.type === 'image') continue;

    const visible = !parameter.hidden && flag(parameter, parameter.visibility, true);
    const answered = isAnswered(values[parameter.name]);

    if (!visible) {
      evaluation.hidden.push(parameter.name);
      if (answered) evaluation.answeredButHidden.push(parameter.name);
      continue;
    }

    evaluation.visible.push(parameter.name);
    let defaulted = false;
    if (!answered && parameter.value !== undefined) {
      const value = evaluate(parameter, parameter.value);
      if (value !== null && value !== undefined && value !== '') {
        evaluation.defaults[parameter.name] = value;
        defaulted = true;
      }
    }

    // A hidden parameter can never block a submit, so only a visible one can be required. One the
    // portal pre-fills is not left to ask — but its default still has to be sent as an answer.
    if (flag(parameter, parameter.required, false)) {
      evaluation.required.push(parameter.name);
      if (!answered && !defaulted) evaluation.missing.push(parameter.name);
    }
    if (flag(parameter, parameter.readOnly, false)) evaluation.readOnly.push(parameter.name);

    const filters = parameter.constraints.filter(
      (constraint) => constraint.ConstraintFieldName !== undefined && constraint.FormFieldName !== undefined,
    );
    if (filters.length > 0) {
      const waitingOn: string[] = [];
      const constraints = filters.map((constraint) => {
        const parent = constraint.FormFieldName ?? '';
        const parentValue = values[parent];
        if (!isAnswered(parentValue)) waitingOn.push(parent);
        return {
          queryFieldName: constraint.ConstraintFieldName ?? '',
          value: str(parentValue),
        };
      });
      evaluation.options[parameter.name] = { constraints, waitingOn };
    }
  }

  return evaluation;
}
