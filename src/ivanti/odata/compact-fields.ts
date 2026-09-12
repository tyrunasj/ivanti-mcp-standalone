/**
 * A PREFERENCE list, not a definition of what a record is.
 *
 * A full Ivanti record is ~180 fields. Twenty-five of them is **187,000 characters** — measured
 * live — which is a context window spent on one list. Asking the model to pass a field list in
 * the tool description is not enough: the default has to be safe, and the escape hatch explicit.
 *
 * These names come from the objects Ivanti ships, and that is the limit of what they are worth.
 * **A tenant can define its own Business Objects and rename, add or remove fields on the shipped
 * ones**, so any fixed list is a guess about someone else's schema. Measured on one tenant:
 * `attachment` and `standarduserteam` share not one name here, and their identifying fields are
 * `ATTACHNAME` and `Team` — no name rule finds both. Metadata does not rescue it either: CSDL
 * reports `nullable: false` on almost nothing and under-reports validated fields.
 *
 * So this list is tried FIRST and is never the last word: `compactFieldsFor` falls back to the
 * row's own fields when it matches nothing identifying, which is what makes the default work on
 * an object this file has never heard of.
 */
export const COMPACT_ROW_FIELDS = [
  'RecId',
  'IncidentNumber',
  'ServiceReqNumber',
  'ChangeNumber',
  'ProblemNumber',
  'AssignmentID',
  'Name',
  'DisplayName',
  'Subject',
  'Status',
  'Priority',
  'Owner',
  'OwnerTeam',
  'CreatedDateTime',
  'LastModDateTime',
];

/** What a caller passes as `fields` to say "everything, I mean it". */
export const ALL_FIELDS = '*';

export interface RowProjection {
  fields: string[] | undefined;
  /** True when the caller took the default rather than choosing. */
  defaulted: boolean;
}

/**
 * Audit columns every object carries, which identify nothing.
 *
 * When the compact set intersects an object in these alone, the rows come back as a RecId and two
 * timestamps and the caller cannot tell one from another.
 */
const AUDIT_FIELDS = new Set(
  ['RecId', 'CreatedDateTime', 'CreatedBy', 'LastModDateTime', 'LastModBy'].map((name) =>
    name.toLowerCase(),
  ),
);

/**
 * How many of an unknown object's own fields to show when the preference list matched nothing.
 *
 * Enough to tell one row from another, few enough that the answer stays small. The response says
 * that this happened and names the rest, so the caller can choose properly on the next call.
 */
const FALLBACK_FIELDS = 8;

/** Whether the preference list identified anything on this object, ignoring audit columns. */
function preferenceMatches(available: readonly string[]): string[] {
  const compact = new Set(COMPACT_ROW_FIELDS.map((name) => name.toLowerCase()));
  return available.filter(
    (name) => compact.has(name.toLowerCase()) && !AUDIT_FIELDS.has(name.toLowerCase()),
  );
}

/**
 * The fields to project from a row, for ANY object — including one this file has never heard of.
 *
 * The preference list first, because on the objects Ivanti ships it is genuinely good. When it
 * matches nothing but audit columns — a tenant's own Business Object, or a shipped one whose
 * fields were renamed — the row's own leading fields are used instead. That is not a guess about
 * which fields matter; it is simply better than handing back a RecId and two timestamps, which is
 * what every row of `attachment` and `standarduserteam` looked like before.
 *
 * `extras` is for candidates a caller has from somewhere better than a name list — the object's
 * required and validated fields, say. They are used only if the row actually has them.
 */
export function compactFieldsFor(
  rowKeys: readonly string[],
  extras: readonly string[] = [],
): { fields: string[]; fellBack: boolean } {
  const present = new Set(rowKeys.map((name) => name.toLowerCase()));
  const identifying = [
    ...preferenceMatches(rowKeys),
    ...extras.filter(
      (name) => present.has(name.toLowerCase()) && !AUDIT_FIELDS.has(name.toLowerCase()),
    ),
  ];

  if (identifying.length > 0) {
    return { fields: [...new Set([...COMPACT_ROW_FIELDS, ...identifying])], fellBack: false };
  }

  const own = rowKeys.filter((name) => !AUDIT_FIELDS.has(name.toLowerCase()));
  return {
    fields: [...COMPACT_ROW_FIELDS, ...own.slice(0, FALLBACK_FIELDS)],
    fellBack: own.length > 0,
  };
}

/**
 * The fields NOT shown after a fallback, so the caller can pick properly next time.
 *
 * Returns undefined when the preference list did fit, which is the signal that no explanation is
 * owed.
 */
export function compactMissedObject(available: readonly string[]): string[] | undefined {
  if (preferenceMatches(available).length > 0) return undefined;
  return available.filter((name) => !AUDIT_FIELDS.has(name.toLowerCase()));
}

/**
 * Decides what to return per row: the caller's list, everything on request, or the compact set.
 */
export function resolveRowFields(
  requested: string[] | undefined,
  raw: string | undefined,
): RowProjection {
  if (raw?.trim() === ALL_FIELDS) return { fields: undefined, defaulted: false };
  if (requested !== undefined && requested.length > 0) return { fields: requested, defaulted: false };
  return { fields: COMPACT_ROW_FIELDS, defaulted: true };
}
