// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { ActionPrompt } from '../../ivanti/quick-actions/execute.js';

export type SettledAnswers =
  | { readonly ok: true; readonly answers: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly message: string };

/**
 * The caller's `answers`, keyed by the probe's own spelling of each prompt — or a refusal.
 *
 * Until this existed the lookup was `answers[prompt.FieldName]` and nothing checked the other way:
 * a mis-cased or invented key was dropped, the action committed without the value, and the tool
 * said it ran. Same shape as `knownFields`: settle the spelling once, refuse what matches nothing,
 * refuse two keys that differ only by case (which of them lands is not ours to pick).
 */
export function settleAnswers(
  prompts: readonly ActionPrompt[],
  answers: Readonly<Record<string, string>>,
): SettledAnswers {
  const keys = Object.keys(answers);
  if (keys.length === 0) return { ok: true, answers: {} };

  if (prompts.length === 0) {
    return {
      ok: false,
      message:
        `This action asks for nothing, but answers were supplied (${keys.join(', ')}). ` +
        'Nothing was run. Drop `answers` — it would have been ignored.',
    };
  }

  const settled: Record<string, string> = {};
  const from: Record<string, string> = {};
  const unmatched: string[] = [];

  for (const key of keys) {
    const prompt =
      prompts.find((candidate) => candidate.FieldName === key) ??
      prompts.find((candidate) => candidate.FieldName.toLowerCase() === key.toLowerCase());
    if (prompt === undefined) {
      unmatched.push(key);
      continue;
    }
    const earlier = from[prompt.FieldName];
    if (earlier !== undefined) {
      return {
        ok: false,
        message:
          `\`${earlier}\` and \`${key}\` are the same prompt, ${prompt.FieldName}. Nothing was ` +
          'run. Supply it once.',
      };
    }
    from[prompt.FieldName] = key;
    settled[prompt.FieldName] = answers[key] ?? '';
  }

  if (unmatched.length > 0) {
    return {
      ok: false,
      message:
        `No prompt named ${unmatched.map((key) => `\`${key}\``).join(', ')}. The action asks for: ` +
        `${prompts.map((prompt) => prompt.FieldName).join(', ')}. Nothing was run.`,
    };
  }
  return { ok: true, answers: settled };
}
