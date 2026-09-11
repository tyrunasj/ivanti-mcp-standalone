import { toCsdlEntity, toEntitySet } from './entity-names.js';

/**
 * Ivanti models some Business Objects as a base type with subtypes: `Task#` has `Task#Assignment`,
 * `Task#WorkOrder`, `Task#SoftwareInstallation`; `CI#` has `CI#Computer`, `CI#Service`.
 *
 * **The base type cannot be created.** `POST /Tasks` with a valid-looking body answers
 * `500 ISM_5000` with an empty message, while `POST /Task__Assignments` with nothing but a
 * Subject succeeds — measured live. Reading the base type is fine; 215 tasks come back from
 * `/Tasks` regardless of which subtype each one is.
 *
 * The subtypes are visible in any catalog: CSDL spells them `task__assignment`, the admin console
 * `Task#Assignment`.
 */
export interface Subtype {
  /** The CSDL name, e.g. `task__assignment`. */
  object: string;
  /** What the record tools take, e.g. `Task__Assignments`. */
  entitySet: string;
}

export function findSubtypes(names: readonly string[], object: string): Subtype[] {
  const base = `${toCsdlEntity(object).toLowerCase()}__`;

  return names
    .filter((name) => name.toLowerCase().startsWith(base))
    .map((name) => ({ object: name, entitySet: toEntitySet(`${name}#`) }))
    .sort((a, b) => a.object.localeCompare(b.object));
}

/** The sentence a caller needs when they aimed at a base type. */
export function describeSubtypes(object: string, subtypes: readonly Subtype[]): string {
  return (
    `${object} is a base type with ${String(subtypes.length)} subtypes, and Ivanti will not create ` +
    'the base type itself — create one of these instead: ' +
    `${subtypes.map((subtype) => subtype.entitySet).join(', ')}.`
  );
}
