/**
 * The fields a caller almost always wants from a row, and nothing else.
 *
 * A full Ivanti record is ~180 fields. Twenty-five of them is **187,000 characters** — measured
 * live — which is a context window spent on one list. Asking the model to pass a field list in
 * the tool description is not enough: the default has to be safe, and the escape hatch explicit.
 *
 * Applied client-side, so a name the object does not have is simply absent and one list serves
 * incidents, changes, tasks and service requests alike.
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
