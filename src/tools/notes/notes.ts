// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { buildQuery, quoteOdataString, readTotal, withQuery } from '../../ivanti/odata/query.js';
import { readCollection, type OdataRecord } from '../../ivanti/odata/response.js';
import type { IvantiToolDeps } from '../shared/deps.js';
import type { ResolvedObject } from '../shared/resolve-object.js';

/**
 * Notes, which are an extension of a group Business Object rather than an object of their own.
 *
 * `Journal` is a **group** object — Ivanti calls it "Activity History" and describes it as
 * maintaining emails and notes — and what a person writes is the `journal__notes` extension. That
 * distinction is the whole reason these tools exist:
 *
 * - Reading through the group relationship returns Ivanti's own traffic. On this tenant **7 of 7**
 *   journals on incidents are `JournalType: Email` — escalation and assignment notices — so "what
 *   has happened on this ticket" is noise unless the type is filtered. Querying the extension
 *   returns notes and nothing else.
 * - Creating on the group object needs `JournalType` set by hand and puts the text in `Subject`.
 *   Creating on the extension sets the type itself, defaults `Category` to `Memo`, and has a real
 *   `NotesBody` field for the text.
 *
 * A note is reached only **through its ticket**, never by naming the note object. That keeps
 * `ENDUSER_BUSINESS_OBJECTS` meaning what it says — the tickets an audience may touch — and means
 * a note can only be read or written on a record the caller already owns.
 */

/** The extension Ivanti ships for human-written notes. */
export const NOTE_OBJECT = 'journal__notes';

/** Its entity set: the CSDL name plus a literal `s`, which is how Ivanti pluralises. */
export const NOTE_ENTITY_SET = 'journal__notess';

export interface Note {
  recId: string;
  subject?: string;
  body?: string;
  category?: string;
  author?: string;
  written?: string;
  /** Whether the self-service portal shows it — the line between a reply and an internal note. */
  visibleToCustomer: boolean;
}

function text(row: OdataRecord, field: string): string | undefined {
  const value = row[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function toNote(row: OdataRecord): Note | undefined {
  const recId = text(row, 'RecId');
  if (recId === undefined) return undefined;

  return {
    recId,
    ...(text(row, 'Subject') === undefined ? {} : { subject: text(row, 'Subject') }),
    ...(text(row, 'NotesBody') === undefined ? {} : { body: text(row, 'NotesBody') }),
    ...(text(row, 'Category') === undefined ? {} : { category: text(row, 'Category') }),
    ...(text(row, 'CreatedBy') === undefined ? {} : { author: text(row, 'CreatedBy') }),
    ...(text(row, 'CreatedDateTime') === undefined
      ? {}
      : { written: text(row, 'CreatedDateTime') }),
    visibleToCustomer: row['PublishToWeb'] === true,
  };
}

/** The note object, resolved through the catalog so a tenant without it says so clearly. */
export async function resolveNoteObject(deps: IvantiToolDeps): Promise<ResolvedObject> {
  const entity = await deps.connection.metadata.entity(NOTE_OBJECT);
  return { entity, entitySet: NOTE_ENTITY_SET };
}

/**
 * The notes on one record, newest first.
 *
 * `visibleOnly` drops anything the self-service portal would not show. An agent's internal
 * commentary lives on the same object as a reply to the customer, and `PublishToWeb` is the only
 * thing that tells them apart — so an end user reading their own ticket must not see the rest.
 */
export async function readNotes(
  deps: IvantiToolDeps,
  parentRecId: string,
  options: { visibleOnly: boolean; top: number },
): Promise<OdataRecord[]> {
  const conditions = [`ParentLink_RecID eq ${quoteOdataString(parentRecId)}`];
  if (options.visibleOnly) conditions.push('PublishToWeb eq true');

  const url = withQuery(
    deps.connection.transport.routes.entitySet(NOTE_ENTITY_SET),
    buildQuery({
      filter: conditions.join(' and '),
      orderBy: 'CreatedDateTime desc',
      top: options.top,
      count: true,
    }),
  );

  return readCollection<OdataRecord>(await deps.connection.transport.request<OdataRecord>(url), url);
}

/**
 * How many journal entries of any kind sit on a record.
 *
 * Read off the **group** object rather than the notes extension, because that is where Ivanti's
 * own traffic lives — emails, escalations, assignment notices. `list_notes` uses it to say what
 * it did not return: a bare `returned: 0` on a record carrying eight escalation entries reads as
 * "nothing has happened here", which is the opposite of true.
 */
export async function countJournalEntries(
  deps: IvantiToolDeps,
  parentRecId: string,
): Promise<number> {
  const url = withQuery(
    deps.connection.transport.routes.entitySet('journals'),
    buildQuery({ filter: `ParentLink_RecID eq ${quoteOdataString(parentRecId)}`, top: 1, count: true }),
  );
  const payload = await deps.connection.transport.request<OdataRecord>(url);
  const rows = readCollection<OdataRecord>(payload, url);
  return readTotal(payload, rows.length)?.total ?? rows.length;
}
