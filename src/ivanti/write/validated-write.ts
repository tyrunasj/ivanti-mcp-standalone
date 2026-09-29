// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import type { EntityMetadata } from '../metadata/csdl.js';
import { toCsdlEntity } from '../metadata/entity-names.js';
import { buildQuery, withQuery } from '../odata/query.js';
import type { OdataRecord } from '../odata/response.js';
import { constrainedBy, type ResolvedForm } from '../session/form-context.js';
import { readPickLists } from '../session/pick-lists.js';
import type { IvantiConnection } from '../connect.js';
import type { IvantiTransport } from '../http/transport.js';
import { comparable, compareStored } from './compare-stored.js';

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

/** One written field that did not hold what was sent. */
export interface NotStored {
  field: string;
  wrote: string;
  stored: string;
  /** The option's identifier was wrong, rather than its value. */
  identifier?: boolean;
  /** The field takes its value from a list. */
  validated: boolean;
  /**
   * The value was matched against a list read for THIS write, moments before it went out — so
   * whatever else went wrong, the list was not stale.
   */
  resolved: boolean;
  /** Governed by one of the form's read-only rules: the signature of a field the tenant computes. */
  computed: boolean;
}

const names = (entries: readonly NotStored[]): string => entries.map((entry) => entry.field).join(', ');
const isAre = (entries: readonly unknown[]): string => (entries.length === 1 ? 'is' : 'are');

/**
 * What to do about each kind of value that did not take — which differs by kind, and used not to.
 *
 * The one piece of advice there was — "a stale option list" — is wrong for most of what reaches
 * here. A validated value this write resolved was on a list read moments earlier, so the list was
 * not stale; and a COMPUTED field (measured: an incident's `Priority`, derived from Urgency and
 * Impact, on the picklist and overwritten without a word — notes.md) will never take whatever list
 * is read. Telling a model to refresh the list there sends it round the same failure again.
 */
function adviceFor(wrong: readonly NotStored[], storedAlongside: readonly string[]): string {
  const computed = wrong.filter((entry) => entry.computed);
  const rest = wrong.filter((entry) => !entry.computed);
  const fresh = rest.filter((entry) => entry.validated && entry.resolved);
  const unresolved = rest.filter((entry) => entry.validated && !entry.resolved);
  const free = rest.filter((entry) => !entry.validated);
  const advice: string[] = [];

  if (computed.length > 0) {
    advice.push(
      `${names(computed)} ${isAre(computed)} governed by a read-only rule on this form and ` +
        'Ivanti kept another value — the mark of a field the tenant COMPUTES from other fields' +
        (storedAlongside.length === 0
          ? ''
          : ` (this write also set ${storedAlongside.join(', ')}, the likeliest inputs)`) +
        '. Refreshing the option list will not help and writing it again will not stick: set ' +
        'what it is derived from and let the rule decide, or leave it out.',
    );
  }
  if (fresh.length > 0) {
    advice.push(
      `${names(fresh)} ${fresh.length === 1 ? 'was' : 'were'} on the option list read for this ` +
        'write, so the list was not stale: a tenant rule or workflow replaced the value, or it ' +
        'needs a different cascade parent.',
    );
  }
  if (unresolved.length > 0) {
    advice.push(
      `${names(unresolved)}: usually a stale option list — re-read it under the current parent ` +
        'values — or a value that needs a different cascade parent.',
    );
  }
  if (free.length > 0) {
    advice.push(
      `${names(free)} ${isAre(free)} not from a list, so the value was legal: Ivanti accepted it ` +
        'and kept something else — a business rule or workflow sets that field, or it holds less ' +
        'than was sent.',
    );
  }

  return advice.join(' ');
}

export class WriteNotStoredError extends Error {
  readonly fields: string[];

  /**
   * @param storedAlongside validated fields in the same write that DID store — named as the
   *   likely inputs when a computed field is what failed.
   */
  constructor(
    entitySet: string,
    recId: string,
    wrong: readonly NotStored[],
    storedAlongside: readonly string[] = [],
  ) {
    const listed = wrong.map((entry) =>
      entry.identifier === true
        ? `${entry.field}: identifier '${entry.wrote}' expected, stored '${entry.stored}'`
        : `${entry.field}: wrote '${entry.wrote}', stored '${entry.stored}'`,
    );
    super(
      `The write to ${entitySet}('${recId}') did NOT store what was intended — ${listed.join('; ')}. ` +
        'The record exists and was written; only what is named here did not take, so do not ' +
        `repeat the whole write. ${adviceFor(wrong, storedAlongside)} Tell the person what the ` +
        'record now holds rather than that it was set.',
    );
    this.name = 'WriteNotStoredError';
    this.fields = wrong.map((entry) => entry.field);
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

  // Both looked up case-insensitively. The tools settle the spelling before this runs
  // (`knownFields`), but an exact lookup here is what let `status` skip resolution entirely while
  // `Status` was resolved — a check that depends on the caller's capitalisation is not a check.
  const csdlValidated = new Set(
    entity.fields.filter((field) => field.validated).map((field) => field.name.toLowerCase()),
  );
  const formSpelling = new Map(
    Object.keys(form?.validatedFields ?? {}).map((name) => [name.toLowerCase(), name]),
  );
  /** The form's own name for a written field — what its services must be asked about. */
  const onFormAs = (name: string): string => formSpelling.get(name.toLowerCase()) ?? name;
  const onForm = written.filter((name) => formSpelling.has(name.toLowerCase()));

  // The two sources disagree in both directions, so take the union: CSDL misses Task's twenty,
  // and a role's form can be narrower than the object.
  const candidates = [
    ...new Set([...written.filter((name) => csdlValidated.has(name.toLowerCase())), ...onForm]),
  ];
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
  const asForm = onForm.map(onFormAs);
  const parents = recId === undefined ? {} : await storedParents(connection, entitySet, recId, form, asForm);

  const { lists } = await readPickLists({
    session: connection.session,
    form,
    objectId,
    fields: asForm,
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
    const formName = onFormAs(name);
    const list = lists[formName];
    if (list === undefined || !list.validated) continue;

    const sent = String(fields[name]);
    const option =
      list.values.find((candidate) => candidate.value === sent) ??
      list.values.find((candidate) => candidate.value.toLowerCase() === sent.toLowerCase()) ??
      list.values.find((candidate) => candidate.label === sent);

    if (option === undefined) {
      const parentNames = constrainedBy(form, formName);
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

    const meta = form.validatedFields[formName];
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

/**
 * Fields Ivanti fills itself, which a write may name and will not change.
 *
 * Measured (notes.md): `LastModBy` is re-stamped by the engine on every write even when sent, and
 * the write's own response reports it changed; a workflow may overwrite it again moments later.
 * The date twins are the same engine's. `CreatedBy` does keep an override on a create — but where
 * it does not, that is still Ivanti's stamp winning rather than this write failing. So a
 * difference on any of these is REPORTED, never raised: repeating the write would not change it.
 */
const STAMPED_BY_IVANTI = new Set(['lastmodby', 'lastmoddatetime', 'createdby', 'createddatetime']);

/** What the read-back found, beyond "it stored". */
export interface ReadBack {
  /** The record as Ivanti holds it after the write, when it could be read. */
  stored?: OdataRecord;
  /** Written fields Ivanti fills itself and kept its own value for: name → what it holds. */
  ignoredByIvanti: OdataRecord;
  /** Written fields that could not be compared, each with the reason. */
  notConfirmed: string[];
}

export interface ConfirmWriteOptions {
  connection: IvantiConnection;
  entitySet: string;
  recId: string;
  /** What `resolveValidatedWrite` decided: the validated values to confirm, and their identifiers. */
  resolved: ResolvedValidatedWrite;
  /** Everything the caller wrote, in the schema's spelling. What `resolved` does not cover is compared too. */
  written?: OdataRecord;
  /** For field types, so a date is compared as an instant and a number as a number. */
  entity?: EntityMetadata;
  /** Its read-only rules mark what a tenant may compute, which changes the advice on a failure. */
  form?: ResolvedForm;
  /**
   * Must be **the one the write used**. Verifying an impersonated write with the service account
   * would read a row the writer may not be able to see — reporting success from a credential that
   * did not do the writing, which is the one thing this function exists to prevent.
   */
  transport?: IvantiTransport;
}

/**
 * Reads the record back and refuses to call the write done if it did not store.
 *
 * EVERY written scalar is compared, not only the validated ones. It used to be only those, while
 * both write tools' descriptions promised that a write Ivanti accepted but did not store is
 * reported — and Ivanti drops or replaces a free field as readily as a listed one: a rule that
 * computes it, a workflow that resets it, a length it truncates to.
 *
 * **A free field that did not take is a FAILURE, like a validated one — not a flagged success.**
 * The descriptions promise exactly that, and a result without `isError` gets summarised as "done":
 * the person would be told a value is set that is not. The blind retry a failure could invite is
 * what the error text heads off — it says the record exists and names only what did not take.
 *
 * Not failures: a field Ivanti stamps itself (`ignoredByIvanti`), and one that cannot be compared
 * honestly — rich text, a structured value, a field the read does not return — which is listed in
 * `notConfirmed` rather than passed or failed on a guess.
 */
export async function confirmWrite(options: ConfirmWriteOptions): Promise<ReadBack> {
  const { connection, entitySet, recId, resolved, written = {}, entity, form } = options;
  const transport = options.transport ?? connection.transport;
  const { confirm, companions, values } = resolved;
  const lower = (name: string): string => name.toLowerCase();

  const confirming = new Set(Object.keys(confirm).map(lower));
  const identifiers = new Set(Object.keys(companions).map(lower));
  const free = Object.keys(written).filter(
    (name) => !confirming.has(lower(name)) && !identifiers.has(lower(name)),
  );

  const report: ReadBack = { ignoredByIvanti: {}, notConfirmed: [] };
  if (confirming.size === 0 && free.length === 0) return report;

  const url = withQuery(transport.routes.record(entitySet, recId), buildQuery({}));
  const read = await transport.request<OdataRecord>(url);
  if (read !== undefined) report.stored = read;

  // By name, whatever the case: the record answers in Ivanti's spelling, and a check that
  // depended on the caller matching it would be the case bug again, one step later.
  const storedKeys = new Map(Object.keys(read ?? {}).map((name) => [lower(name), name]));
  const returned = (name: string): boolean => storedKeys.has(lower(name));
  const storedAs = (name: string): unknown => {
    const key = storedKeys.get(lower(name));
    return key === undefined ? undefined : read?.[key];
  };

  const schema = new Map((entity?.fields ?? []).map((field) => [lower(field.name), field]));
  const readOnly = new Set((form?.readOnlyFields ?? []).map(lower));
  const onList = new Set([
    ...Object.keys(form?.validatedFields ?? {}).map(lower),
    ...[...schema.values()].filter((field) => field.validated).map((field) => lower(field.name)),
  ]);
  const resolvedNow = new Set(Object.keys(values).map(lower));

  const wrong: NotStored[] = [];
  const miss = (field: string, wrote: unknown, got: unknown, identifier = false): void => {
    wrong.push({
      field,
      wrote: comparable(wrote),
      stored: comparable(got),
      ...(identifier ? { identifier } : {}),
      validated: identifier || confirming.has(lower(field)) || onList.has(lower(field)),
      resolved: identifier || resolvedNow.has(lower(field)),
      computed: readOnly.has(lower(field)),
    });
  };

  for (const [name, intended] of Object.entries(confirm)) {
    if (comparable(storedAs(name)) !== comparable(intended)) miss(name, intended, storedAs(name));
  }

  // The identifier is what makes the value real — a right-looking label over a wrong RecId points
  // at another object's option. Checked only when the record echoes it: a missing field is not
  // evidence of a wrong one.
  for (const [name, intended] of Object.entries(companions)) {
    if (!returned(name)) continue;
    if (comparable(storedAs(name)) !== comparable(intended)) miss(name, intended, storedAs(name), true);
  }

  for (const name of free) {
    const intended = written[name];
    // Nothing to compare against is not evidence either way — said, rather than passed silently.
    if (read === undefined) {
      report.notConfirmed.push(`${name} — the record could not be read back`);
      continue;
    }
    if (!returned(name)) {
      report.notConfirmed.push(`${name} — the read-back does not return this field`);
      continue;
    }

    const verdict = compareStored(intended, storedAs(name), schema.get(lower(name))?.type);
    if (verdict === 'same') continue;
    if (verdict === 'incomparable') {
      report.notConfirmed.push(
        typeof intended === 'object' && intended !== null
          ? `${name} — a structured value, which is not compared`
          : `${name} — rich text, which Ivanti re-renders, so it is not compared`,
      );
      continue;
    }
    if (STAMPED_BY_IVANTI.has(lower(name))) {
      report.ignoredByIvanti[name] = storedAs(name) ?? null;
      continue;
    }
    miss(name, intended, storedAs(name));
  }

  if (wrong.length > 0) {
    const failed = new Set(wrong.map((entry) => lower(entry.field)));
    const storedAlongside = Object.keys(confirm).filter((name) => !failed.has(lower(name)));
    throw new WriteNotStoredError(entitySet, recId, wrong, storedAlongside);
  }

  return report;
}

/** What a write tool adds to its result from the read-back — nothing, when there is nothing to say. */
export function readBackReport(readBack: ReadBack): Record<string, unknown> {
  return {
    ...(Object.keys(readBack.ignoredByIvanti).length === 0
      ? {}
      : {
          ignoredByIvanti: readBack.ignoredByIvanti,
          ignoredNote:
            'Ivanti fills these itself on every write and kept its own value — not a failure of ' +
            'this write, and writing them again will not change them.',
        }),
    ...(readBack.notConfirmed.length === 0 ? {} : { notConfirmed: readBack.notConfirmed }),
  };
}
