// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import type { EntityMetadata } from '../../ivanti/metadata/csdl.js';
import type { OdataRecord } from '../../ivanti/odata/response.js';
import { tenantCategorySpelling } from '../../ivanti/parent-link.js';
import { NOTE_ENTITY_SET, readNote, resolveNoteObject, toNote } from '../notes/notes.js';
import type { CallContext } from '../tool-definition.js';
import type { IvantiToolDeps } from './deps.js';
import { resolveObject, type ResolvedObject } from './resolve-object.js';

/**
 * The note a change leaves behind, saying why it was made (`WRITE_AUDIT_NOTE`).
 *
 * Asking a model in the instructions to "explain what you changed" works until the turn it does
 * not, and the turn it does not is the one somebody later has to reconstruct. So the explanation
 * is an ARGUMENT of the write tools — absent from the schema when the setting is off — and this
 * writes it onto the record once the change is confirmed.
 *
 * ## Whose note it is
 *
 * The account the API key was issued for, **never the person the conversation is acting as**. The
 * note is posted on the service account's own transport, not `transportFor(context)`, and carries
 * no author override (`add_note` stamps the person in `enduser`; this must not). The person is
 * named in the body, as the one who asked — a record that shows a person as having written text
 * they never saw would be a worse audit trail than none.
 *
 * ## It never undoes or hides the change
 *
 * The change is already made and confirmed when this runs. A note that cannot be written is
 * reported beside the result (`auditWarning`) rather than failing the call: reporting "the update
 * failed" over a record that was updated invites a retry, and a retry of a write mails people.
 */

const MIN_LENGTH = 10;
const MAX_LENGTH = 1_000;
/** One value in a change line. A description pasted whole would bury the reason beside it. */
const VALUE_WIDTH = 120;
const MAX_CHANGE_LINES = 25;

/**
 * The `justification` argument — or nothing, when the deployment turned the notes off.
 *
 * Spread into a tool's `inputSchema`. Required rather than optional because an optional
 * explanation is the one a model skips; `.min` because "n/a" is what it writes when it is allowed
 * to write anything.
 */
export function auditArguments(deps: IvantiToolDeps): { justification?: z.ZodString } {
  if (deps.auditNote !== true) return {};
  return {
    justification: z
      .string()
      .trim()
      .min(MIN_LENGTH)
      .max(MAX_LENGTH)
      .describe(
        'Why this change is being made, in a sentence or two. It is written onto the record as ' +
          'an internal note for the people who read it later — who asked, and the reason.',
      ),
  };
}

/** What the caller gave, read from arguments typed before the setting was known. */
export function justificationOf(args: object): string | undefined {
  const value = (args as { justification?: unknown }).justification;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

const clip = (value: unknown): string => {
  const text =
    value === null || value === undefined || value === ''
      ? '(empty)'
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : (JSON.stringify(value) ?? '(unreadable)');
  return text.length > VALUE_WIDTH ? `${text.slice(0, VALUE_WIDTH - 1)}…` : text;
};

/** `Status: Open → Resolved`; the old value is left out when it was not read. */
export function describeChange(field: string, before: unknown, after: unknown, readBefore = true): string {
  return readBefore ? `${field}: ${clip(before)} → ${clip(after)}` : `${field} → ${clip(after)}`;
}

/**
 * A record named the way the person who reads the note knows it: its number when it has one
 * (`incident 11173`), otherwise its id, and its title when it has one.
 */
export function describeRecord(object: string, recordId: string, row?: OdataRecord): string {
  const numberField = Object.keys(row ?? {}).find((name) => /^[A-Za-z]+Number$/.test(name));
  const number = numberField === undefined ? undefined : row?.[numberField];
  const title = ['Subject', 'Name', 'Title', 'Summary']
    .map((field) => row?.[field])
    .find((value): value is string => typeof value === 'string' && value.trim() !== '');
  return (
    `${object} ${typeof number === 'number' || typeof number === 'string' ? String(number) : recordId}` +
    (title === undefined ? '' : ` (${clip(title)})`)
  );
}

/**
 * Whether Ivanti hangs journal notes off this object.
 *
 * Read from the object's own relationships rather than assumed: a lookup table or a setting has
 * nothing to hang a note on, and a POST aimed at one is stored on nothing. Not a failure when it
 * is absent — there is simply nowhere to say it.
 */
export function canHoldNotes(entity: EntityMetadata): boolean {
  return entity.relationships.some((relationship) => /^journal/i.test(relationship.target));
}

export interface AuditNoteInput {
  /** The object the note goes on. For a delete, the record's parent: the record itself is gone. */
  parent: ResolvedObject;
  recordId: string;
  /** What was done, in a line: `Updated Incident 10042 (Printer jammed)`. */
  action: string;
  /** What changed, a line each. */
  changes?: readonly string[];
  justification: string | undefined;
}

function body(context: CallContext, input: AuditNoteInput, justification: string): string {
  const requestedBy = context.pin?.person()?.displayName;
  const changes = (input.changes ?? []).slice(0, MAX_CHANGE_LINES);
  const omitted = (input.changes?.length ?? 0) - changes.length;
  return [
    input.action,
    ...(changes.length === 0
      ? []
      : ['', ...changes.map((line) => `• ${line}`), ...(omitted > 0 ? [`• …and ${String(omitted)} more`] : [])]),
    '',
    `Why: ${justification}`,
    '',
    `Made through the Ivanti MCP server by an AI assistant${
      requestedBy === undefined ? '' : `, in conversation with ${requestedBy}`
    }. This note is posted by the server's own account.`,
  ].join('\n');
}

/**
 * Leaves the note, and answers with what to put in the tool's result: `{}` when the setting is
 * off, otherwise `auditNote`, plus an `auditWarning` when a note was owed and not written.
 * Never throws — the change it describes has already happened.
 */
export async function leaveAuditNote(
  deps: IvantiToolDeps,
  context: CallContext,
  input: AuditNoteInput,
): Promise<Record<string, unknown>> {
  if (deps.auditNote !== true) return {};

  const failed = (reason: string): Record<string, unknown> => ({
    auditNote: { noted: false, reason },
    auditWarning:
      'The change was made, but the note explaining it was NOT left on the record: ' +
      `${reason} Say so. Do not repeat the change to retry the note — leave it with add_note.`,
  });

  if (!canHoldNotes(input.parent.entity)) {
    return {
      auditNote: {
        noted: false,
        reason: `${input.parent.entity.name} has no journal to hold a note, so none was left.`,
      },
    };
  }

  const justification = input.justification;
  if (justification === undefined) return failed('no justification was given.');

  try {
    // The service account's transport on purpose — see the file header.
    const transport = deps.connection.transport;
    await resolveNoteObject(deps);
    const category = await tenantCategorySpelling(transport, NOTE_ENTITY_SET, input.parent.entity.name);

    const created = await transport.request<OdataRecord>(transport.routes.entitySet(NOTE_ENTITY_SET), {
      method: 'POST',
      body: {
        Subject: 'AI assistant change',
        NotesBody: body(context, input, justification),
        ParentLink_RecID: input.recordId,
        ParentLink_Category: category,
        // Internal: the reasoning is for colleagues, not a reply to the customer.
        PublishToWeb: false,
      },
    });
    const note = created === undefined ? undefined : toNote(created);
    if (note === undefined) return failed('Ivanti accepted the note without answering with one.');

    // A POST that answers with a note is not proof the note is on THIS record.
    const stored = await readNote(transport, note.recId);
    const parentId = stored?.['ParentLink_RecID'];
    if (typeof parentId !== 'string' || parentId.toLowerCase() !== input.recordId.toLowerCase()) {
      deps.logger.error('ivanti audit note did not land', { object: input.parent.entitySet });
      return failed('reading it back did not find it on the record.');
    }

    deps.logger.info('ivanti audit note added', { object: input.parent.entitySet });
    return { auditNote: { noted: true, noteId: note.recId, visibleToCustomer: stored?.['PublishToWeb'] === true } };
  } catch (error: unknown) {
    deps.logger.warn('ivanti audit note failed', { object: input.parent.entitySet });
    return failed(`${error instanceof Error ? error.message.slice(0, 200) : 'Ivanti refused it'}.`);
  }
}

/**
 * The note for a record that no longer exists: its journal went with it, so it goes on the record
 * it hung from (a task's incident). A record with no parent leaves nothing to write on — said, and
 * not a warning: there was never anywhere to say it.
 */
export async function noteOnParent(
  deps: IvantiToolDeps,
  context: CallContext,
  deleted: OdataRecord,
  input: Pick<AuditNoteInput, 'action' | 'justification'>,
): Promise<Record<string, unknown>> {
  if (deps.auditNote !== true) return {};

  const recordId = deleted['ParentLink_RecID'];
  const category = deleted['ParentLink_Category'];
  const nowhere = (reason: string): Record<string, unknown> => ({ auditNote: { noted: false, reason } });
  if (typeof recordId !== 'string' || recordId === '' || typeof category !== 'string' || category === '') {
    return nowhere('The record is deleted along with its journal and belonged to no parent record, so there was nowhere to leave a note.');
  }

  let parent: ResolvedObject;
  try {
    parent = await resolveObject(deps, category);
  } catch {
    return nowhere(`The record's parent is a ${category}, which this server cannot reach, so no note was left on it.`);
  }
  return leaveAuditNote(deps, context, { ...input, parent, recordId });
}
