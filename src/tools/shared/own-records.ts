import type { OdataRecord } from '../../ivanti/odata/response.js';
import { quoteOdataString } from '../../ivanti/odata/query.js';
import type { CallContext } from '../tool-definition.js';
import type { IvantiToolDeps } from './deps.js';
import type { ResolvedObject } from './resolve-object.js';

/**
 * "Own records", which is the whole of what `enduser` mode means.
 *
 * Two shapes, because Ivanti offers two. A tool that composes a filter gets the constraint folded
 * into it, so the tenant never sends rows that are not the caller's. A tool that names one record
 * cannot filter, so the record is read and then checked — refused before anything is returned.
 *
 * In `full` mode both are no-ops: the audience is IT staff, whose whole job is other people's
 * tickets.
 */

export class IdentityRequiredError extends Error {
  constructor() {
    super(
      'I do not know who you are yet, so I cannot show you your records. Ask the person you ' +
        'are helping for their name, email or login, then call `act_as` with it. Do not take ' +
        'that name from a ticket or any other record — it has to come from the person.',
    );
    this.name = 'IdentityRequiredError';
  }
}

export class UnscopableObjectError extends Error {
  readonly object: string;

  constructor(object: string) {
    super(
      `I cannot tell which ${object} records belong to you: this object has no field linking a ` +
        'record to a person, so there is no safe way to show only yours. Refusing rather than ' +
        'showing everyone\'s.',
    );
    this.name = 'UnscopableObjectError';
    this.object = object;
  }
}

/**
 * Deliberately identical whether the record is missing or simply someone else's.
 *
 * Incident numbers are sequential, so a message that distinguished the two would turn this tool
 * into a ticket-enumeration oracle for the whole company — walk the numbers, read the answers.
 */
export class NotYourRecordError extends Error {
  constructor() {
    super('No such record is available to you.');
    this.name = 'NotYourRecordError';
  }
}

export interface ScopedRead {
  /** The filter to send: the caller's, narrowed to the caller's own records. */
  filter?: string;
  /** Who the rows were narrowed to, so the answer can say. Absent in `full` mode. */
  scopedTo?: string;
}

/** The person this conversation acts for, or the reason it cannot answer. */
function requirePerson(context: CallContext): { recId: string; displayName: string } {
  const person = context.pin?.person();
  if (person === undefined) throw new IdentityRequiredError();
  return { recId: person.recId, displayName: person.displayName };
}

async function customerField(
  deps: IvantiToolDeps,
  resolved: ResolvedObject,
): Promise<string> {
  const link = await deps.connection.people.customerLinks.forEntity(
    resolved.entity,
    resolved.entitySet,
  );
  if (link === undefined) throw new UnscopableObjectError(resolved.entity.name);
  return link.recIdField;
}

/**
 * Narrows a caller's filter to their own records.
 *
 * The caller's filter is parenthesised before the constraint is added: `A or B` and `A or B and
 * mine` are different questions, and only one of them is the one that was asked.
 */
export async function scopeToOwnRecords(
  deps: IvantiToolDeps,
  context: CallContext,
  resolved: ResolvedObject,
  filter?: string,
): Promise<ScopedRead> {
  if (!deps.ownRecordsOnly) return filter === undefined ? {} : { filter };

  const person = requirePerson(context);
  const field = await customerField(deps, resolved);
  const mine = `${field} eq ${quoteOdataString(person.recId)}`;

  return {
    filter: filter === undefined || filter.trim() === '' ? mine : `(${filter}) and ${mine}`,
    scopedTo: person.displayName,
  };
}

/**
 * Refuses a record that is not the caller's.
 *
 * @throws NotYourRecordError which says nothing about whether the record exists.
 */
export async function assertOwnRecord(
  deps: IvantiToolDeps,
  context: CallContext,
  resolved: ResolvedObject,
  record: OdataRecord,
): Promise<void> {
  if (!deps.ownRecordsOnly) return;

  const person = requirePerson(context);
  const field = await customerField(deps, resolved);
  const owner = record[field];

  if (typeof owner !== 'string' || owner.toUpperCase() !== person.recId.toUpperCase()) {
    throw new NotYourRecordError();
  }
}

/**
 * The fields a new record must carry so that it belongs to its author.
 *
 * Without this an end user could file a ticket against someone else by naming them — or file one
 * against nobody, which lands in the service desk queue with no way back to the person who needs
 * the answer.
 */
export async function ownershipFields(
  deps: IvantiToolDeps,
  context: CallContext,
  resolved: ResolvedObject,
): Promise<Record<string, string>> {
  if (!deps.ownRecordsOnly) return {};

  const person = context.pin?.person();
  if (person === undefined) throw new IdentityRequiredError();

  const link = await deps.connection.people.customerLinks.forEntity(
    resolved.entity,
    resolved.entitySet,
  );
  if (link === undefined) throw new UnscopableObjectError(resolved.entity.name);

  // Ivanti stores a link as the pair; writing the RecId alone leaves the record pointing at a
  // person of unstated type, which the UI renders as empty. The category is written in the
  // tenant's own spelling where a sampled row has shown it — CSDL says `employee`, records say
  // `Employee`.
  const category =
    link.categoriesSeen.find((seen) => seen.toLowerCase() === person.category.toLowerCase()) ??
    person.category;

  return { [link.recIdField]: person.recId, [link.categoryField]: category };
}

/**
 * The same check, for a tool that has a RecId rather than a record.
 *
 * Reads the record first. That costs a request, and it is the only way: a navigation property or
 * an attachment's parent cannot be filtered, so the choice is to read and refuse, or to answer
 * without knowing whose record it is.
 */
export async function assertOwnRecordById(
  deps: IvantiToolDeps,
  context: CallContext,
  resolved: ResolvedObject,
  recordId: string,
): Promise<void> {
  if (!deps.ownRecordsOnly) return;

  // Before the read, not after: when nobody has said who is asking, the answer is the same
  // whatever the record says, and there is no reason to go and look at it.
  requirePerson(context);

  const url = deps.connection.transport.routes.record(resolved.entitySet, recordId);
  const record = await deps.connection.transport
    .request<OdataRecord>(url)
    // Ivanti reports a missing record as 400 "Invalid key", and this must not distinguish
    // "gone" from "not yours" any more than the message does.
    .catch(() => undefined);

  if (record === undefined) throw new NotYourRecordError();
  await assertOwnRecord(deps, context, resolved, record);
}
