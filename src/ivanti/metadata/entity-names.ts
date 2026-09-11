/**
 * Ivanti names one Business Object three ways, and every layer of the product prefers a
 * different one.
 *
 * | Form | Example | Used by |
 * |---|---|---|
 * | AdminUI id | `Incident#`, `CI#Computer` | schema and form services |
 * | OData entity set | `Incidents`, `CI__Computers` | the CRUD routes |
 * | CSDL entity | `incident` (lowercase) | what `$metadata` reports back |
 *
 * The conversion is **not** English pluralisation: replace `#` with `__`, drop a trailing `#`,
 * then append a literal `s`. `IncidentStatus#` becomes `IncidentStatuss`, not `IncidentStatuses`.
 * Getting that wrong does not raise an error — Ivanti answers an empty result, which reads as
 * "this tenant has no such records" rather than "you spelled it wrong".
 *
 * Ported from `overlord-service`, where three inconsistent conversions had grown up
 * independently and disagreed about the `#` form.
 */

/** `#` is canonical; the documentation's dot form (`CI.Server`) means the same thing. */
function hashForm(ref: string): string {
  return ref.includes('#') ? ref : ref.replace(/\./g, '#');
}

function stripHash(hashed: string): string {
  return hashed.replace(/#$/, '').replace(/#/g, '__');
}

/**
 * → the OData entity set used in CRUD URLs.
 *
 * ```
 * Incident#    → Incidents      CI#Computer → CI__Computers
 * CI.Server    → CI__Servers    Incidents   → Incidents      (already a set)
 * ```
 *
 * A **bare** name passes through untouched, deliberately. Singular-versus-set cannot be decided
 * for a name already ending in `s`, and a wrong guess produces an empty result rather than an
 * error. Callers that must guess should say so by calling `toGuessedEntitySet`.
 */
export function toEntitySet(ref: string): string {
  const hashed = hashForm(ref);
  if (!hashed.includes('#')) return ref;
  return `${stripHash(hashed)}s`;
}

/**
 * → the entity name `$metadata` is keyed by.
 *
 * ```
 * Incidents → Incident     Incident#     → Incident
 * CI#Computer → CI__Computer   CI__Computers → CI__Computer
 * ```
 */
export function toCsdlEntity(ref: string): string {
  const hashed = hashForm(ref);
  if (hashed.includes('#')) return stripHash(hashed);
  return ref.endsWith('s') ? ref.slice(0, -1) : ref;
}

/**
 * → the lowercase entity set that `$metadata` and full-text search demand, guessing the plural
 * when given a bare singular.
 *
 * Separate from `toEntitySet` because the guess is precisely what that function refuses to make.
 * Use it only where a wrong guess surfaces as an ordinary empty result, never where it would be
 * reported as fact.
 */
export function toGuessedEntitySet(ref: string): string {
  const stripped = stripHash(hashForm(ref));
  return (stripped.endsWith('s') ? stripped : `${stripped}s`).toLowerCase();
}

/**
 * Whether a form or record that declares itself `served` answers for the entity `requested`.
 *
 * Ivanti resolves forms from a *layout*, so asking the wrong layout still answers 200 — with a
 * form for a different Business Object. Matching is not string equality: a base type is legitimately
 * served by one of its subtypes, but a named subtype must be served exactly.
 *
 * ```
 * Task#       ← Task#Assignment  ✓     CI#         ← CI#Computer     ✓
 * CI#Computer ← CI#MobileDevice  ✗     Task#       ← Incident#       ✗
 * ```
 */
export function servesEntity(requested: string, served: string | undefined): boolean {
  if (served === undefined || served === '') return false;

  const want = requested.toLowerCase();
  const got = served.toLowerCase();
  if (want === got) return true;

  const [wantBase = '', wantSub = ''] = want.split('#');
  return wantSub === '' && wantBase === got.split('#')[0];
}

/**
 * The English singular of a name a caller pluralised the English way, or undefined when the name
 * does not look pluralised at all.
 *
 * English morphology is deliberately kept **out** of the forward conversions — Ivanti appends a
 * literal `s`, so `Category#` is `Categorys` and guessing otherwise silently returns nothing. It
 * earns its place only on the recovery path: a caller who asked for `Categories` needs to be told
 * the object is `Categorys`, and that requires undoing the English plural they applied.
 */
export function toEnglishSingular(ref: string): string | undefined {
  const bare = ref.replace(/#$/, '');

  if (/[^aeiou]ies$/i.test(bare)) return `${bare.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/i.test(bare)) return bare.slice(0, -2);
  if (/[^s]s$/i.test(bare)) return bare.slice(0, -1);

  return undefined;
}
