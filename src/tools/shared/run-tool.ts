// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../../logger.js';
import {
  IvantiApiError,
  isIvantiNotFound,
  isIvantiPromptRefusal,
  pathOf,
  ResponseTooLargeError,
} from '../../ivanti/http/errors.js';
import { IvantiBusyError } from '../../ivanti/http/request-limiter.js';
import { isReadMethod } from '../../ivanti/http/exchange.js';
import { MetadataUnavailableError, UnknownEntityError } from '../../ivanti/metadata/catalog.js';
import { noteOutcome } from '../../usage/call-usage.js';
import { noteIfPersonRefused } from './try-read.js';
import { UnsupportedFilterError } from '../../ivanti/odata/filter.js';
import {
  ValidatedValueError,
  WriteNotStoredError,
  WriteUnconfirmedError,
} from '../../ivanti/write/validated-write.js';
import { FieldNameError } from './explain-field-error.js';
import { RequiredFieldsError } from './explain-required-fields.js';
import { ObjectNotAllowedError } from './object-gate.js';
import { ActionNotAllowedError } from './action-gate.js';
import {
  NotYourQueueError,
  NotYourRecordError,
  RecordClosedError,
  UnscopableObjectError,
} from './own-records.js';
import {
  IdentityConflictError,
  IdentityRequiredError,
  VerifiedSessionError,
} from '../../auth/identity-pin.js';
import { SubmitRefusedError } from '../../ivanti/service-request/submit.js';
import {
  AttachmentTypeRefusedError,
  OrphanedAttachmentError,
  ParentNotFoundError,
} from '../../ivanti/attachments/upload.js';
import { errorResult } from './result.js';

export type RefusalLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * One row per refusal class: how loudly it is logged, under what line, and what the model reads.
 *
 * A class missing here falls through to `tool failed` at error level and is counted as a fault of
 * this server, so `run-tool.refusals.test.ts` walks the source for every exported `...Error` and
 * requires it to be a row, a subclass of a row, or named as handled elsewhere.
 * Subclasses need no row of their own; a row for a subclass must precede its base.
 *
 * Levels: `debug` is the caller's mistake, `info` an ordinary answer the operator may want to
 * count, `warn` something the operator should see, `error` an outcome nobody asked for.
 * Fields never carry what the caller sent.
 */
interface Refusal<E extends Error = Error> {
  refusal: abstract new (...args: never[]) => E;
  level: RefusalLevel;
  log: string;
  fields?: (error: E) => Record<string, unknown>;
  reply?: (error: E) => string;
}

const refuse = <E extends Error>(entry: Refusal<E>): Refusal => entry as unknown as Refusal;

export const REFUSALS: readonly Refusal[] = [
  // Refused here, never sent: the caller's query was the problem — a rejection, not a failure.
  refuse({
    refusal: UnsupportedFilterError,
    level: 'debug',
    log: 'tool refused a filter',
    fields: (e) => ({ kind: e.unsupported.kind }),
  }),
  refuse({
    refusal: ObjectNotAllowedError,
    level: 'debug',
    log: 'tool refused an object',
    fields: (e) => ({ ref: e.ref }),
  }),
  refuse({ refusal: ActionNotAllowedError, level: 'debug', log: 'tool refused an action' }),
  // Who is asking: the conversation has not said, or has tried to become someone else. Ordinary
  // answers, so none is an error; the name that was claimed is never recorded.
  ...[IdentityRequiredError, IdentityConflictError, VerifiedSessionError].map((refusal) =>
    refuse({
      refusal,
      level: 'info',
      log: 'tool refused on identity',
      fields: (e: Error) => ({ reason: e.name }),
    }),
  ),
  // A closed record is final. Ivanti marks it read-only and then accepts the write anyway, so
  // this refusal is the only thing between a caller and a silently-edited closed ticket.
  refuse({ refusal: RecordClosedError, level: 'debug', log: 'write refused, record closed' }),
  refuse({
    refusal: NotYourQueueError,
    level: 'info',
    log: 'tool refused a question about someone else',
  }),
  refuse({
    refusal: NotYourRecordError,
    level: 'info',
    log: "tool refused a record that is not the caller's",
  }),
  refuse({
    refusal: UnscopableObjectError,
    level: 'warn',
    log: 'object has no person link',
    fields: (e) => ({ object: e.object }),
  }),
  // Refused before anything was written: the value was not on the list.
  refuse({
    refusal: ValidatedValueError,
    level: 'debug',
    log: 'tool refused a validated value',
    fields: (e) => ({ field: e.field }),
  }),
  // The write happened and did not take. The one failure that must never read as success, so it
  // is logged at error level even though the caller can act on it.
  refuse({ refusal: WriteNotStoredError, level: 'error', log: 'ivanti write did not store' }),
  // The write was accepted and only the read-back failed. Whatever the cause (busy, timeout,
  // gateway, refusal), the record exists: never "nothing was changed", never "try again". Listed
  // ahead of IvantiBusyError's reply, which says the opposite.
  refuse({ refusal: WriteUnconfirmedError, level: 'warn', log: 'ivanti write sent, read-back failed' }),
  // Ivanti refused the submit inside a 200 and created nothing.
  refuse({ refusal: SubmitRefusedError, level: 'debug', log: 'service request refused' }),
  // The tenant refused the extension, which is a rename rather than a retry.
  refuse({ refusal: AttachmentTypeRefusedError, level: 'debug', log: 'upload refused, file type' }),
  // Nothing was sent: the record the file would hang off is not there.
  refuse({ refusal: ParentNotFoundError, level: 'debug', log: 'upload refused, no such parent' }),
  // The file is in Ivanti and on no record; someone has to clean it up.
  refuse({
    refusal: OrphanedAttachmentError,
    level: 'error',
    log: 'attachment uploaded but not attached',
    fields: (e) => ({ attachmentId: e.attachmentId }),
  }),
  refuse({
    refusal: RequiredFieldsError,
    level: 'debug',
    log: 'tool reported required fields',
    fields: (e) => ({ fields: e.fields.length }),
  }),
  refuse({
    refusal: FieldNameError,
    level: 'debug',
    log: 'tool rejected a field name',
    fields: (e) => ({ fields: e.fields.length }),
  }),
  refuse({
    refusal: UnknownEntityError,
    level: 'debug',
    log: 'tool rejected a name',
    fields: (e) => ({ entity: e.entity }),
  }),
  // The schema could not be read just now: whether the name exists is unknown, and nothing was
  // written. A transient outage, so the model is told to try again, not to rename anything.
  refuse({ refusal: MetadataUnavailableError, level: 'warn', log: 'ivanti metadata unavailable' }),
  // Never sent: this server's own cap on requests to the tenant stayed full. Not Ivanti's
  // failure, and not a write that may have been applied — the model is told to try again.
  refuse({
    refusal: IvantiBusyError,
    level: 'warn',
    log: 'ivanti request cap reached; request not sent',
    fields: (e) => ({ limit: e.limit }),
    reply: (e) => `${e.message} Nothing was changed. Try again in a moment.`,
  }),
  // Ivanti answered, with more than the caller agreed to hold. Nothing failed.
  refuse({
    refusal: ResponseTooLargeError,
    level: 'debug',
    log: 'tool refused a response too large to read',
  }),
];

/**
 * Turns a thrown failure into a result the model can read and recover from.
 *
 * An exception escaping a handler becomes a JSON-RPC error, which most clients surface as "the
 * tool failed" with nothing actionable. A tool result with `isError` keeps the explanation in
 * front of the model, which is the difference between one retry and a dead end.
 *
 * Arguments are never logged: they carry ticket text, names and other personal data.
 */
export async function runTool(
  tool: string,
  logger: Logger,
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error: unknown) {
    // For the usage line: which refusal, by class — most of them never set `name`, and it is the
    // refusals a model keeps hitting that point at the description that failed to warn it.
    noteOutcome(
      error instanceof IvantiApiError
        ? `ivanti ${String(error.status)}`
        : error instanceof Error
          ? error.constructor.name
          : 'fault',
    );
    // Only the person's own credential: a 401 on the service account's key says nothing about the
    // person's session, and re-opening that over it throws away a session that was fine.
    noteIfPersonRefused(error);
    if (error instanceof WriteUnconfirmedError) noteIfPersonRefused(error.cause);

    const refusal = REFUSALS.find((entry) => error instanceof entry.refusal);
    if (refusal !== undefined && error instanceof Error) {
      const fields = refusal.fields?.(error);
      logger[refusal.level](refusal.log, { tool, ...fields });
      return errorResult(refusal.reply?.(error) ?? error.message);
    }

    if (error instanceof IvantiApiError) {
      // Unreachable, down, or no longer accepting our credential: nothing the model sends can fix
      // any of those, so they are the operator's to see at info. 401 belongs here because it means
      // the key or the session stopped working. No body: Ivanti echoes what was submitted, and the
      // body is already on the debug `ivanti request failed` line. The code is not a body — it
      // is `ENOTFOUND` or `CERT_HAS_EXPIRED`, the one thing that says which of those it was.
      if (error.status === 0 || error.status >= 500 || error.status === 401) {
        logger.warn('ivanti unavailable', {
          tool,
          status: error.status,
          method: error.method,
          path: pathOf(error.url),
          ...(error.code === undefined ? {} : { code: error.code }),
        });
      } else {
        // A refusal of what the model asked for, and the model is told why below.
        logger.debug('ivanti refused the request', { tool, status: error.status });
      }

      if (isUnanswered(error)) return errorResult(noAnswer(error));

      // The transition, not the request. Saying "does not exist" here — which the bare ISM_4000
      // match used to do — sends a caller hunting for a field name that was never wrong.
      //
      // Names no tool: quick actions are not registered in `enduser` without an allowlist, nor on
      // the odata tier, and advice to call a tool that is not there is a dead end.
      if (isIvantiPromptRefusal(error)) {
        return errorResult(
          'Ivanti refused this transition with a prompt the API cannot answer. THE GATE IS ' +
            'USUALLY ON THIS VALUE, NOT ON THE FIELD — measured, the same field on the same ' +
            'record accepted two neighbouring values seconds later, so try those first. Where ' +
            'quick actions are available, one may perform the transition, but a tenant can gate ' +
            'a status that has no action behind it, in which case it can only be changed in the ' +
            `Ivanti web client — do not keep hunting for an action that may not exist.\n${error.body}`,
        );
      }

      const missing = isIvantiNotFound(error)
        ? ' The record or field does not exist — Ivanti reports both as 400 "Invalid key".'
        : '';
      return errorResult(`Ivanti refused the request (${String(error.status)}).${missing}\n${error.body}`);
    }

    // Not Ivanti and not a refusal: a bug here. The error is logged whole, stack included.
    noteOutcome('fault');
    logger.error('tool failed', { tool, error });
    return errorResult(error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Nothing came back — which is not the same as no.
 *
 * Status 0 (a timeout, a reset, a dropped connection) and a gateway's 502 or 504 all mean the
 * request may well have reached Ivanti and nothing returned to say what became of it. Reported as
 * "Ivanti refused the request (0)", a create that ran past the timeout read as a refusal; the
 * model tried again and filed the ticket twice. For a write the only safe next step is to look.
 */
export const isUnanswered = (error: IvantiApiError): boolean =>
  error.status === 0 || error.status === 502 || error.status === 504;

function noAnswer(error: IvantiApiError): string {
  const why =
    error.status === 0 ? error.body : `${String(error.status)} from a gateway in front of Ivanti`;
  if (isReadMethod(error.method)) {
    return (
      `Ivanti did not answer (${why}). This is not a refusal, and nothing about the request was ` +
      'wrong — Ivanti was slow or unreachable. Trying once more is safe; if it fails the same ' +
      'way, say that Ivanti is not responding rather than changing the request.'
    );
  }
  return (
    `Ivanti did not answer this ${error.method} (${why}), so whether it was applied is unknown. ` +
    'THIS IS NOT A REFUSAL, AND IT MAY HAVE TAKEN EFFECT. Before trying again, check: read back ' +
    'the record it would have changed, or search for the one it would have created. Retrying ' +
    'without looking can do it twice.'
  );
}
