// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * Turns "that name does not exist" into "did you mean …?".
 *
 * Ivanti names things in ways a caller will guess wrong — `Type` is `CIType`, `Description` is
 * `Symptom`, and the plural of `Category#` is `Categorys`. An entity can carry 250 fields, so
 * listing them all answers the question but costs more context than the query it explains.
 *
 * Ranking beats listing here. A wrong guess is usually a piece of the real name (`Type` for
 * `CIType`), the real name with something added (`SubjectLine` for `Subject`), or a slip of the
 * fingers (`Incidnet` for `incident`) — the three tiers below, strongest first.
 *
 * The second tier asks that the name found be at least half the guess. Without that, any short
 * name that happened to occur inside a longer guess won: `Incidnet` was offered `ci`, and never
 * `incident`, which contains neither and is contained by neither. The suggestion is the one lesson
 * a model gets at the moment it is wrong, so a noisy one costs a second wrong call.
 */
export function suggestNames(attempted: string, available: readonly string[], limit = 5): string[] {
  const needle = attempted.toLowerCase();
  if (needle === '') return [];

  // One slip in a short name, two in a longer one. Beyond that it is a different word, and
  // suggesting it would be noise; under three letters, every name is a slip away.
  const slips = needle.length < 3 ? 0 : needle.length <= 4 ? 1 : 2;

  const scored: { name: string; score: number }[] = [];

  for (const name of available) {
    const candidate = name.toLowerCase();
    if (candidate === needle) continue; // an exact match was never the problem

    let rank: number;
    if (candidate.startsWith(needle) || candidate.endsWith(needle)) rank = 0;
    else if (candidate.includes(needle)) rank = 1;
    else if (needle.includes(candidate) && candidate.length * 2 >= needle.length) rank = 2;
    else {
      const distance = editDistance(needle, candidate, slips);
      if (distance > slips) continue;
      rank = 2 + distance;
    }

    // Among equally placed matches prefer the closest in length, so `Type` reaches `CIType`
    // before `LastAuditType`.
    scored.push({ name, score: rank * 1000 + Math.abs(name.length - attempted.length) });
  }

  return scored
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name);
}

/**
 * Damerau-Levenshtein: an adjacent transposition counts as one edit, because `Sympton` and
 * `Incidnet` are one slip each. Gives up early — returns `limit + 1` — when the lengths alone
 * already differ by more than `limit`.
 */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  const rows: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i += 1) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) rows[0]![j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      }
      rows[i]![j] = best;
    }
  }

  return rows[a.length]![b.length]!;
}

/**
 * The stem of an entity name a caller got wrong, for matching against real ones.
 *
 * English plurals are exactly what goes wrong — `Categories` for `Categorys`, `Incidents` for
 * `Incident#` — so the trailing plural is stripped before ranking.
 */
export function toStem(attempted: string): string {
  return attempted.replace(/(ies|es|s)$/i, '');
}
