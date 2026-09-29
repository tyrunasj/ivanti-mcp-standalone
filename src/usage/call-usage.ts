// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What one tool call cost, gathered from wherever the cost was incurred.
 *
 * The size of a result is visible where the call ends, but how many Ivanti requests it took is
 * known only inside `exchange()`, and why it failed only inside `runTool`. The async context
 * carries one tally down to both — the way `withLogContext` carries log fields — without anything
 * threading it through `deps`.
 *
 * A request started by one call and awaited by another (a memoised `$metadata` read, shared by two
 * cold calls) counts to the call that started it. That is the call that paid for it.
 */
export interface CallUsage {
  ivantiRequests: number;
  /**
   * Rows read from Ivanti collections, summed. Zero means the answer was empty — the case a model
   * most often answers by rephrasing and asking again. Absent when the call read no collection.
   */
  rowsRead?: number;
  /**
   * Why the call did not simply answer: the class of the refusal (`UnsupportedFilterError`),
   * `ivanti <status>`, or `fault`. Unset when it answered.
   */
  outcome?: string;
}

const store = new AsyncLocalStorage<CallUsage>();

/** Runs `run` with `usage` as the tally every nested request and refusal reports into. */
export function withCallUsage<T>(usage: CallUsage, run: () => T): T {
  return store.run(usage, run);
}

export function countIvantiRequest(): void {
  const usage = store.getStore();
  if (usage !== undefined) usage.ivantiRequests += 1;
}

export function countRowsRead(rows: number): void {
  const usage = store.getStore();
  if (usage !== undefined) usage.rowsRead = (usage.rowsRead ?? 0) + rows;
}

export function noteOutcome(outcome: string): void {
  const usage = store.getStore();
  if (usage !== undefined) usage.outcome = outcome;
}
