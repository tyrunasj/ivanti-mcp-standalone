import type { Logger } from '../../logger.js';
import type { EntityMetadata } from '../metadata/csdl.js';
import { toCsdlEntity } from '../metadata/entity-names.js';
import { buildQuery, withQuery } from '../odata/query.js';
import type { OdataRecord } from '../odata/response.js';
import { constrainedBy, type ResolvedForm } from '../session/form-context.js';
import { readPickLists } from '../session/pick-lists.js';
import type { IvantiConnection } from '../connect.js';

/**
 * Writing a validated field is the accepted-but-wrong failure this module exists to prevent.
 *
 * Ivanti stores such a field as a **pair** — the display value and the RecId of the option it came
 * from — and the value↔RecId map exists only in the form chain. Send the value alone and Ivanti
 * may accept the write and store nothing, or store the value against no option at all. So the
 * value is resolved against the live list, its companion identifier is written beside it, and the
 * record is read back to confirm what actually landed.
 */

/** How many allowed values a rejection lists. The full list can run to hundreds. */
const VALUES_SHOWN = 25;

export class ValidatedValueError extends Error {
  readonly field: string;
  readonly validValues: string[];
  readonly validValuesTotal: number;
  readonly constrainedBy: string[];
  readonly parentValues: Record<string, string>;

  constructor(init: {
    entity: string;
    field: string;
    sent: string;
    validValues: string[];
    validValuesTotal: number;
    constrainedBy: string[];
    parentValues: Record<string, string>;
  }) {
    const list =
      init.validValues.length > 0
        ? `Allowed${init.validValuesTotal > init.validValues.length ? ` (${String(init.validValues.length)} of ${String(init.validValuesTotal)})` : ''}: ${init.validValues.join(', ')}.`
        : 'That list came back empty.';

    const cascade =
      init.constrainedBy.length > 0
        ? ` ${init.field} is filtered by ${init.constrainedBy.join(', ')}` +
          (Object.keys(init.parentValues).length > 0
            ? `, and this write set ${Object.entries(init.parentValues)
                .map(([name, value]) => `${name}='${value}'`)
                .join(', ')}.`
            : ', which this write did not set — an empty parent gives an empty or wrong list.')
        : '';

    super(
      `'${init.sent}' is not a valid value for ${init.field} on ${init.entity}. ${list}${cascade} ` +
        'Nothing was written.',
    );
    this.name = 'ValidatedValueError';
    this.field = init.field;
    this.validValues = init.validValues;
    this.validValuesTotal = init.validValuesTotal;
    this.constrainedBy = init.constrainedBy;
    this.parentValues = init.parentValues;
  }
}

export class WriteNotStoredError extends Error {
  constructor(entitySet: string, recId: string, wrong: string[]) {
    super(
      `The write to ${entitySet}('${recId}') did NOT store what was intended — ${wrong.join('; ')}. ` +
        'The record exists but a value did not take. That is usually a stale option list — re-read ' +
        'it with get_pick_list_values under the current parent values — or a value that needs a ' +
        'different cascade parent.',
    );
    this.name = 'WriteNotStoredError';
  }
}

export interface ResolvedValidatedWrite {
  /** `<field>_Valid` style identifiers to write beside the values. */
  companions: OdataRecord;
  /** The values as Ivanti spells them, which may differ from what the caller sent. */
  values: OdataRecord;
  /** What to read back afterwards. */
  confirm: OdataRecord;
}

const EMPTY: ResolvedValidatedWrite = { companions: {}, values: {}, confirm: {} };

/** Scalars compare as themselves; anything structured is serialised rather than becoming '[object Object]'. */
function comparable(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  return JSON.stringify(value) ?? '';
}

/**
 * The CSDL name back to the AdminUI id the session services take.
 *
 * `incident` → `incident#`, `ci__computer` → `ci#computer`. A **subtype keeps no trailing `#`**:
 * `CI#Computer` is the whole id, while a base object is `Incident#`. The services are
 * case-insensitive here, which is why the lowercase CSDL spelling is fine.
 */
export function toObjectId(name: string): string {
  const bare = toCsdlEntity(name);
  return bare.includes('__') ? bare.replace(/__/g, '#') : `${bare}#`;
}

async function storedParents(
  connection: IvantiConnection,
  entitySet: string,
  recId: string,
  form: ResolvedForm,
  writing: readonly string[],
): Promise<OdataRecord> {
  const parents = new Set(writing.flatMap((field) => constrainedBy(form, field)));
  if (parents.size === 0) return {};

  try {
    const url = connection.transport.routes.record(entitySet, recId);
    const record = await connection.transport.request<OdataRecord>(url);
    const stored: OdataRecord = {};
    for (const parent of parents) {
      const value = record?.[parent];
      if (value !== null && value !== undefined && value !== '') stored[parent] = value;
    }
    return stored;
  } catch {
    // Best effort: a parent we could not read is one the form will evaluate as empty, which is
    // what would have happened anyway.
    return {};
  }
}

export interface ValidatedWriteOptions {
  connection: IvantiConnection;
  logger: Logger;
  entity: EntityMetadata;
  entitySet: string;
  fields: OdataRecord;
  /** Set on an update: the record whose stored values complete the cascade. */
  recId?: string;
}

/**
 * Resolves the validated fields in a write, or refuses it.
 *
 * **The form is the authority, not `$metadata`.** Measured live: Task's CSDL reports *no*
 * validated fields while its form declares twenty, so gating on the CSDL flag skipped resolution
 * entirely and the write went out unresolved — Ivanti answered 500. The form chain is cached per
 * object for the life of the process, so consulting it costs three calls once rather than a
 * wrong write for ever.
 */
export async function resolveValidatedWrite(
  options: ValidatedWriteOptions,
): Promise<ResolvedValidatedWrite> {
  const { connection, logger, entity, entitySet, fields, recId } = options;

  const written = Object.keys(fields).filter(
    (name) => fields[name] !== null && fields[name] !== '' && fields[name] !== undefined,
  );
  if (written.length === 0) return EMPTY;

  const objectId = toObjectId(entity.name);
  const form = await connection.forms.get(objectId).catch(() => undefined);

  const csdlValidated = new Set(
    entity.fields.filter((field) => field.validated).map((field) => field.name),
  );
  const onForm = form === undefined ? [] : written.filter((name) => name in form.validatedFields);

  // The two sources disagree in both directions, so take the union: CSDL misses Task's twenty,
  // and a role's form can be narrower than the object.
  const candidates = [...new Set([...written.filter((name) => csdlValidated.has(name)), ...onForm])];
  if (candidates.length === 0) return EMPTY;

  // Whatever happens below, every validated field written gets re-read: a picklist that accepts
  // the write and stores nothing must not be reported as done.
  const confirm: OdataRecord = Object.fromEntries(candidates.map((name) => [name, fields[name]]));

  if (form === undefined) {
    logger.debug('no form to resolve validated fields; writing as sent', { objectId });
    return { companions: {}, values: {}, confirm };
  }

  if (onForm.length === 0) return { companions: {}, values: {}, confirm };

  // Cascade parents: what this write sets, over what the record already holds. A PATCH of
  // Category names no Service, so without the stored parent the list comes back filtered by an
  // empty one and a perfectly legal value is refused.
  const parents = recId === undefined ? {} : await storedParents(connection, entitySet, recId, form, onForm);

  const { lists } = await readPickLists({
    session: connection.session,
    form,
    objectId,
    fields: onForm,
    // Only scalars can be a parent value; a structured field could not have come from a list.
    values: Object.fromEntries(
      Object.entries({ ...parents, ...fields })
        .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
        .map(([name, value]) => [name, String(value)]),
    ),
  });

  const companions: OdataRecord = {};
  const values: OdataRecord = {};

  for (const name of onForm) {
    const list = lists[name];
    if (list === undefined || !list.validated) continue;

    const sent = String(fields[name]);
    const option =
      list.values.find((candidate) => candidate.value === sent) ??
      list.values.find((candidate) => candidate.value.toLowerCase() === sent.toLowerCase()) ??
      list.values.find((candidate) => candidate.label === sent);

    if (option === undefined) {
      const parentNames = constrainedBy(form, name);
      const parentValues: Record<string, string> = {};
      for (const parent of parentNames) {
        const value = fields[parent] ?? parents[parent];
        if (typeof value === 'string' && value !== '') parentValues[parent] = value;
        else if (typeof value === 'number') parentValues[parent] = String(value);
      }

      throw new ValidatedValueError({
        entity: objectId,
        field: name,
        sent,
        validValues: list.values.slice(0, VALUES_SHOWN).map((candidate) => candidate.value),
        validValuesTotal: list.values.length,
        constrainedBy: parentNames,
        parentValues,
      });
    }

    const meta = form.validatedFields[name];
    const idRef =
      typeof meta === 'object' && meta !== null
        ? (meta as Record<string, unknown>)['ValidatedIdFieldRef']
        : undefined;

    companions[typeof idRef === 'string' && idRef !== '' ? idRef : `${name}_Valid`] = option.recId;
    values[name] = option.value;
    // The stored value is the option's, which may differ from the label the caller sent.
    confirm[name] = option.value;
  }

  return { companions, values, confirm };
}

/** Reads the record back and refuses to call the write done if it did not store. */
export async function confirmWrite(
  connection: IvantiConnection,
  entitySet: string,
  recId: string,
  confirm: OdataRecord,
  companions: OdataRecord = {},
): Promise<void> {
  if (Object.keys(confirm).length === 0) return;

  const url = withQuery(connection.transport.routes.record(entitySet, recId), buildQuery({}));
  const stored = (await connection.transport.request<OdataRecord>(url)) ?? {};

  const wrong: string[] = [];
  for (const [name, intended] of Object.entries(confirm)) {
    const got = comparable(stored[name]);
    if (got !== comparable(intended)) {
      wrong.push(`${name}: wrote '${comparable(intended)}', stored '${got}'`);
    }
  }

  // The identifier is what makes the value real — a right-looking label over a wrong RecId points
  // at another object's option. Checked only when the record echoes it: a missing field is not
  // evidence of a wrong one.
  for (const [name, intended] of Object.entries(companions)) {
    if (!(name in stored)) continue;
    const got = comparable(stored[name]);
    if (got !== comparable(intended)) {
      wrong.push(`${name}: identifier '${comparable(intended)}' expected, stored '${got}'`);
    }
  }

  if (wrong.length > 0) throw new WriteNotStoredError(entitySet, recId, wrong);
}
