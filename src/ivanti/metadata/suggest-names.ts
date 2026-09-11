/**
 * Turns "that name does not exist" into "did you mean …?".
 *
 * Ivanti names things in ways a caller will guess wrong — `Type` is `CIType`, `Description` is
 * `Symptom`, and the plural of `Category#` is `Categorys`. An entity can carry 250 fields, so
 * listing them all answers the question but costs more context than the query it explains.
 *
 * Ranking beats listing here because the wrong guess is nearly always a substring of the real
 * name, or contains it.
 */
export function suggestNames(attempted: string, available: readonly string[], limit = 5): string[] {
  const needle = attempted.toLowerCase();
  if (needle === '') return [];

  const scored: { name: string; score: number }[] = [];

  for (const name of available) {
    const candidate = name.toLowerCase();
    if (candidate === needle) continue; // an exact match was never the problem

    let rank: number;
    if (candidate.startsWith(needle) || candidate.endsWith(needle)) rank = 0;
    else if (candidate.includes(needle)) rank = 1;
    else if (needle.includes(candidate)) rank = 2;
    else continue;

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
 * The stem of an entity name a caller got wrong, for matching against real ones.
 *
 * English plurals are exactly what goes wrong — `Categories` for `Categorys`, `Incidents` for
 * `Incident#` — so the trailing plural is stripped before ranking.
 */
export function toStem(attempted: string): string {
  return attempted.replace(/(ies|es|s)$/i, '');
}
