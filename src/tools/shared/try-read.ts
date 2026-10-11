// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { IvantiApiError } from '../../ivanti/http/errors.js';
import { notePersonRefused } from '../../usage/call-usage.js';

/**
 * Records that the PERSON's own credential was refused, so the impersonated session is renewed.
 *
 * Only a 401 on the person's credential: one on the service account's key says nothing about the
 * person's session, and re-opening that over it throws away a session that was fine. Kept in one
 * place because both `runTool` (a failure that ends the call) and `tryRead` (one the call carries
 * on past) must make the same decision — a swallowed 401 that skipped it left the lapsed session
 * in place for every call after.
 */
export function isPersonRefused(error: unknown): boolean {
  return error instanceof IvantiApiError && error.status === 401 && error.credential === 'person';
}

export function noteIfPersonRefused(error: unknown): void {
  if (isPersonRefused(error)) notePersonRefused();
}

export type ReadAttempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * A secondary read whose failure the answer carries rather than hides.
 *
 * `.catch(() => [])` turns "could not be read" into "there is nothing" and the payload then
 * narrates it as a fact. This returns the failure instead, so each caller says what it knows —
 * and a person-credential 401 is noted on the way, because the handler will not rethrow it.
 */
export async function tryRead<T>(read: Promise<T>): Promise<ReadAttempt<T>> {
  try {
    return { ok: true, value: await read };
  } catch (error: unknown) {
    noteIfPersonRefused(error);
    return { ok: false, error };
  }
}
