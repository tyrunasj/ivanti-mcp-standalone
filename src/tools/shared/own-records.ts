// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { OdataRecord } from '../../ivanti/odata/response.js';
import { quoteOdataString } from '../../ivanti/odata/query.js';
import type { PinnedPerson } from '../../auth/identity-pin.js';
import type { CallContext } from '../tool-definition.js';
import type { IvantiToolDeps } from './deps.js';
import type { ResolvedObject } from './resolve-object.js';
import { isIvantiNotFound } from '../../ivanti/http/errors.js';

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

  return {
    [link.recIdField]: person.recId,
    [link.categoryField]: category,
    ...authorFields(person.loginId),
  };
}

/**
 * Who authored this, as opposed to who typed it.
 *
 * Ivanti fills `CreatedBy` from the session by default, which would put **this server's service
 * account** on every ticket an end user raises — so the record would say the service desk filed
 * it against them, and nothing would say who actually asked. `CreatedBy` accepts an override and
 * keeps it; `LastModBy` does **not** (measured: a write reported it as changed and stored the
 * session account regardless). That split is right rather than unfortunate — the person authored
 * it, this server performed it, and the two fields now say exactly that.
 *
 * The attribution is only as strong as the identity behind it: verified under `oauth`, and an
 * unverified claim otherwise. That is the same exposure the phone line has, and design §5 accepts
 * it for the same reason.
 */
export function authorFields(loginId: string | undefined): Record<string, string> {
  return loginId === undefined || loginId === '' ? {} : { CreatedBy: loginId };
}

/**
 * Collapses "not there" into "not yours", for a scoped caller.
 *
 * `assertOwnRecordById` and `assertRecordWritable` already do this, because they read the record
 * themselves. A tool that reads FIRST and checks ownership afterwards — `get_record`, `fetch`,
 * `get_attachment_details` — cannot: the read throws Ivanti's `400 Invalid key` before any
 * ownership code runs, so a missing record and someone else's record came back in two different
 * shapes. Measured in `enduser`:
 *
 * ```
 * someone else's incident → "No such record is available to you."
 * a RecId that is nobody's → "Ivanti refused the request (400). The record or field does not exist"
 * ```
 *
 * That is an existence oracle: a RecId leaked through a URL, an email or a pasted ticket body can
 * be confirmed live, and asking under two object names attributes it to one of them. There is no
 * enumeration path — RecIds are 128-bit — but the design says these must be indistinguishable, and
 * they were not.
 *
 * In `full` mode the distinction is kept: an analyst debugging a typo is not an adversary, and
 * "the record does not exist" is the useful answer there.
 */
export function hideMissingRecord(deps: IvantiToolDeps, error: unknown): never {
  if (deps.ownRecordsOnly && isIvantiNotFound(error)) throw new NotYourRecordError();
  throw error instanceof Error ? error : new Error(String(error));
}

/**
 * The same, for a tool that got an empty body rather than a rejection — Ivanti's other way of
 * saying a record is not there. Returns the message the tool should use, or undefined when the
 * caller is not scoped and the tool's own wording is better.
 */
export function missingRecordMessage(deps: IvantiToolDeps): string | undefined {
  return deps.ownRecordsOnly ? new NotYourRecordError().message : undefined;
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

/**
 * A record Ivanti marks read-only, which it then lets you write to anyway.
 *
 * A closed ticket carries `ReadOnly: true` — measured across statuses, it is true for `Closed` and
 * false for `Resolved`, `Active` and `Logged`, which is exactly the lifecycle rule: a resolved
 * ticket can still be reopened, a closed one is final. `IsInFinalState` looks like the same signal
 * and is **not** — it reads false even on closed records here.
 *
 * Ivanti does not enforce its own flag: a PATCH against a closed incident answered 200 and stored
 * the change. So this is enforced here or nowhere.
 */
export class RecordClosedError extends Error {
  constructor(what: string) {
    super(
      `That ${what} is closed, and closed is final — it cannot be edited, acted on, reopened ` +
        'OR DELETED. If there is more to do, raise a new one that references it. (A resolved ' +
        'record is different: that one can still be reopened. Ivanti will accept a write to a ' +
        'closed record without complaining, which is why this is refused here.)',
    );
    this.name = 'RecordClosedError';
  }
}

/**
 * The check every write to an existing record makes: is it the caller's, and is it still open.
 *
 * One read serves both, because both questions are answered by the same record — and a write path
 * that fetched twice would pay for the ownership check even where the record turns out to be
 * closed.
 */
export async function assertRecordWritable(
  deps: IvantiToolDeps,
  context: CallContext,
  resolved: ResolvedObject,
  recordId: string,
): Promise<OdataRecord | undefined> {
  if (deps.ownRecordsOnly) requirePerson(context);

  const url = deps.connection.transport.routes.record(resolved.entitySet, recordId);
  const record = await deps.connection.transport
    .request<OdataRecord>(url)
    .catch(() => undefined);

  // A record that is not there is the caller's own tool to explain — each one says something
  // different and better than a generic line here. In `enduser` it is not explained at all,
  // because "gone" and "not yours" must read identically.
  if (record === undefined) {
    if (deps.ownRecordsOnly) throw new NotYourRecordError();
    return undefined;
  }

  if (record['ReadOnly'] === true) throw new RecordClosedError(resolved.entity.name);

  if (deps.ownRecordsOnly) await assertOwnRecord(deps, context, resolved, record);
  return record;
}

/**
 * Someone else's name is not a way to ask about them.
 *
 * Three tools take a `person`, and all three had the same hole: the check was written as "if a
 * person is pinned **and** the name differs, refuse", so pinning nobody skipped it entirely. In
 * `enduser` that made the boundary depend on call *order* — open a fresh session, pass `person`,
 * and read a colleague's approval queue or service catalogue. Found by driving the tools rather
 * than by reading them, which is the only way this kind of hole shows up.
 *
 * So: `enduser` requires a pinned person **and** requires the named one to be them. `full` keeps
 * taking any name, because an analyst looking at a colleague's queue is the job.
 */
export class NotYourQueueError extends Error {
  constructor(who: string) {
    super(
      `This server answers for ${who} only. Asking about someone else would let anyone read ` +
        'a colleague\'s queue by naming them.',
    );
    this.name = 'NotYourQueueError';
  }
}

export function resolveSubject(
  deps: IvantiToolDeps,
  context: CallContext,
  named: string | undefined,
  /** Which of the pinned person's identifiers this tool matches on — login, or RecId. */
  pick: (person: PinnedPerson) => string | undefined,
): string | undefined {
  const pinned = context.pin?.person();

  if (!deps.ownRecordsOnly) {
    return named ?? (pinned === undefined ? undefined : pick(pinned));
  }

  if (pinned === undefined) throw new IdentityRequiredError();

  const self = pick(pinned);
  if (named !== undefined && named !== '' && named.toLowerCase() !== self?.toLowerCase()) {
    throw new NotYourQueueError(pinned.displayName);
  }
  return self;
}
