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

/**
 * How many preference fields must carry a value before the default is considered to fit.
 *
 * One is not enough, and the audit case proves it: `audit_incident` rows carry a real `Priority`
 * on some rows and null for `Subject`, `Status`, `Owner` and `OwnerTeam` on all of them. A
 * single-field match suppressed the fallback and the rows still came back five-sixths empty,
 * while `AuditHistoryDescription` — the entire point of the object — went unasked for. Two is the
 * smallest threshold that says "this object really is shaped like the ones the list knows".
 */
const MIN_IDENTIFYING = 2;

/** A value that actually identifies something, as opposed to a key that merely exists. */
function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

/**
 * Preference fields that carry a real value in at least one of the sampled rows.
 *
 * Key presence is not enough, and that gap shipped: `audit_incident` rows DO have `Subject`,
 * `Status`, `Priority`, `Owner` and `OwnerTeam` as columns — all null on every row — so the
 * preference list matched, the fallback never fired, and eight real audit entries came back as
 * `{RecId, Subject: null, Status: null, …}`. A reader sees "8 entries, all blank" and is wrong
 * twice: the rows are not blank, and their actual content (`AuditHistoryDescription`,
 * `AuditHistoryDateTime`, `AuditHistoryUser`) was never asked for.
 */
function preferenceMatches(rows: readonly Record<string, unknown>[]): string[] {
  const compact = new Set(COMPACT_ROW_FIELDS.map((name) => name.toLowerCase()));
  const useful = new Set<string>();
  for (const row of rows) {
    for (const [field, value] of Object.entries(row)) {
      const lower = field.toLowerCase();
      if (compact.has(lower) && !AUDIT_FIELDS.has(lower) && hasValue(value)) useful.add(field);
    }
  }
  return [...useful];
}

/**
 * The fields to project from a row, for ANY object — including one this file has never heard of.
 *
 * The preference list first, because on the objects Ivanti ships it is genuinely good. When it
 * carries nothing useful — a tenant's own Business Object, a shipped one whose fields were
 * renamed, or a target like `audit_incident` whose ticket-shaped columns are all null — the rows'
 * own populated fields are used instead. That is not a guess about which fields matter; it is
 * simply better than handing back a RecId and two timestamps.
 *
 * `extras` is for candidates a caller has from somewhere better than a name list — the object's
 * required and validated fields, say. They are used only where the rows actually carry them.
 */
export function compactFieldsFor(
  rows: readonly Record<string, unknown>[],
  extras: readonly string[] = [],
): { fields: string[]; fellBack: boolean } {
  const populated = new Set<string>();
  for (const row of rows) {
    for (const [field, value] of Object.entries(row)) {
      if (hasValue(value)) populated.add(field);
    }
  }

  const identifying = [
    ...preferenceMatches(rows),
    ...extras.filter(
      (name) => populated.has(name) && !AUDIT_FIELDS.has(name.toLowerCase()),
    ),
  ];

  if (identifying.length >= MIN_IDENTIFYING) {
    return { fields: [...new Set([...COMPACT_ROW_FIELDS, ...identifying])], fellBack: false };
  }

  const own = [...populated].filter((name) => !AUDIT_FIELDS.has(name.toLowerCase()));
  return {
    fields: [...COMPACT_ROW_FIELDS, ...own.slice(0, FALLBACK_FIELDS)],
    fellBack: own.length > 0,
  };
}

export function compactMissedObject(
  rows: readonly Record<string, unknown>[],
): string[] | undefined {
  if (preferenceMatches(rows).length >= MIN_IDENTIFYING) return undefined;
  const names = new Set<string>();
  for (const row of rows) for (const field of Object.keys(row)) names.add(field);
  return [...names].filter((name) => !AUDIT_FIELDS.has(name.toLowerCase()));
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
