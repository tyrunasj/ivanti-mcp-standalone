import { visibleFields, type EntityMetadata } from '../../ivanti/metadata/csdl.js';
import { FieldNameError } from './explain-field-error.js';

/**
 * `$NULL` is a STRING sentinel, and Ivanti does not say so.
 *
 * `Owner eq '$NULL'` is the documented and only way to match an empty field — but it is a quoted
 * string literal, so on a date or numeric column Ivanti answers
 * `400 ISM_4000 / "No such entry exists"`. That message names the *field* vocabulary, so it reads
 * as a bad field name: a tester got it on `ScheduledStartDate`, a field `get_object_metadata` had
 * confirmed one call earlier, and briefly doubted the field rather than the operator.
 *
 * Refused locally for the same reason `contains()` and an unknown `orderBy` are: the request is
 * knowably wrong before it is sent, and Ivanti's own answer misdirects.
 */
const NULL_COMPARISON = /([A-Za-z_][A-Za-z0-9_]*)\s+(?:eq|ne)\s+'\$NULL'/gi;

/** Edm types `$NULL` actually works against. Everything else 400s. */
const STRINGY = /^(Edm\.)?(String|Guid)$/i;

export function assertNullFilterTypes(filter: string | undefined, entity: EntityMetadata): void {
  if (filter === undefined || !filter.includes('$NULL')) return;

  const types = new Map(
    visibleFields(entity).map((field) => [field.name.toLowerCase(), field.type]),
  );

  for (const [, field] of filter.matchAll(NULL_COMPARISON)) {
    if (field === undefined) continue;
    const type = types.get(field.toLowerCase());
    // An unknown field is not this check's business — `explainFieldError` names it better.
    if (type === undefined || STRINGY.test(type)) continue;

    throw new FieldNameError(
      `'${field}' is a ${type.replace(/^Edm\./, '')} field, and \`$NULL\` only works on text ` +
        'fields. Ivanti answers this with 400 "No such entry exists", which reads as a bad field ' +
        'name — the field is fine, the operator is not. There is no null test for a date or ' +
        'numeric field: filter on a range instead, or read the rows and check the value yourself.',
      [field],
    );
  }
}

/**
 * The other half of the trap, which no refusal can catch: Ivanti stores many "empty" values as the
 * empty STRING, and `ne '$NULL'` counts those as present.
 *
 * Measured: `ChassisType ne '$NULL'` returns 42 CIs, of which 13 hold `""`. A tester used the same
 * idiom to establish that 157 of 628 employees have a manager — a ceiling, not a count, and
 * Harold Sanders' own value is `""` rather than null.
 */
export const NULL_FILTER_CAVEAT =
  "`$NULL` matches SQL NULL only. Ivanti stores many empty values as the empty string, which " +
  "`ne '$NULL'` counts as PRESENT — measured, 13 of 42 rows that passed that test held `''`. To " +
  "exclude both, add `and <field> ne ''`.";
