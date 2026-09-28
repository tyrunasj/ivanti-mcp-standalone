// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z, type ZodRawShape } from 'zod';
import { suggestNames } from '../ivanti/metadata/suggest-names.js';

/**
 * The refusal an unknown argument earns.
 *
 * `suggestNames` is asked second, because it deliberately skips a candidate that matches the
 * attempt case-insensitively — "an exact match was never the problem" is true of an entity name
 * and false of an argument, where the case IS the problem. `orderby` against `orderBy` is the
 * whole reason this exists, so it is checked first and answered by name.
 */
export function unknownArgumentMessage(keys: readonly string[], allowed: readonly string[]): string {
  const named = keys.map((key) => `'${key}'`).join(', ');
  const noun = keys.length === 1 ? 'argument' : 'arguments';

  const sameLetters = keys.length === 1
    ? allowed.find((name) => name.toLowerCase() === keys[0]?.toLowerCase())
    : undefined;
  const nearest = sameLetters ?? (keys.length === 1 ? suggestNames(keys[0] ?? '', allowed)[0] : undefined);

  return (
    `Unknown ${noun} ${named}${nearest === undefined ? '' : `. Did you mean '${nearest}'?`}` +
    `${nearest === undefined ? '. ' : ' '}This tool takes: ${allowed.join(', ')}.` +
    ' An argument this tool does not declare is DROPPED, not applied, so it was refused here' +
    ' rather than answered without it.'
  );
}

/**
 * Makes a tool's arguments closed, so a name it does not declare is refused rather than ignored.
 *
 * Zod parses a plain object non-strictly, and the SDK hands the handler the PARSED value — so an
 * argument spelled wrongly never reaches the tool and nothing reports that it went missing. For
 * most parameters that widens the answer. For `orderBy` it produced a confidently wrong one:
 * `orderby` is the OData spelling (`$orderby` is all lowercase), and passing it returned rows in
 * Ivanti's own order while the caller believed they were sorted — with `assertOrderBy` guarding a
 * parameter that never arrived.
 *
 * A zero-argument tool is left open on purpose. Its shape is `{}`, which the SDK does not treat as
 * a schema at all, and clients are known to send a dummy property rather than an empty object for
 * a tool that takes nothing — refusing that would break a call that is asking for exactly what the
 * tool offers.
 */
export function strictInput<Shape extends ZodRawShape>(shape: Shape): Shape | z.ZodObject<Shape> {
  const allowed = Object.keys(shape);
  if (allowed.length === 0) return shape;

  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? unknownArgumentMessage(issue.keys, allowed)
        : undefined,
  });
}

/**
 * The declared arguments, whichever form the schema took.
 *
 * `strictInput` returns a raw shape for a zero-argument tool and a `ZodObject` for every other, so
 * a reader that assumed one form saw nothing for the other. `description-budget.test.ts` did
 * exactly that and went blind the moment the schemas closed — measuring zero parameters and
 * passing, which is the failure mode that guard exists to prevent.
 */
export function declaredArguments(
  inputSchema: ZodRawShape | z.ZodObject<ZodRawShape> | undefined,
): ZodRawShape {
  if (inputSchema === undefined) return {};
  const shape: unknown = (inputSchema as z.ZodObject<ZodRawShape>).shape;
  return typeof shape === 'object' && shape !== null
    ? (shape as ZodRawShape)
    : (inputSchema as ZodRawShape);
}
