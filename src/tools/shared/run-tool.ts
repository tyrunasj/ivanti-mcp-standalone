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
import { UnknownEntityError } from '../../ivanti/metadata/catalog.js';
import { noteOutcome, notePersonRefused } from '../../usage/call-usage.js';
import { UnsupportedFilterError } from '../../ivanti/odata/filter.js';
import {
  ValidatedValueError,
  WriteNotStoredError,
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
    if (error instanceof IvantiApiError && error.status === 401 && error.credential === 'person') {
      notePersonRefused();
    }

    // Refused here, never sent: the caller's query was the problem, so this is a rejection
    // rather than a failure and does not belong in the error log.
    if (error instanceof UnsupportedFilterError) {
      logger.debug('tool refused a filter', { tool, kind: error.unsupported.kind });
      return errorResult(error.message);
    }

    if (error instanceof ObjectNotAllowedError) {
      logger.debug('tool refused an object', { tool, ref: error.ref });
      return errorResult(error.message);
    }

    if (error instanceof ActionNotAllowedError) {
      logger.debug('tool refused an action', { tool });
      return errorResult(error.message);
    }

    // Refusals about who is asking. All of them are ordinary answers the model can act on — the
    // conversation has not said who it is helping, or has tried to become someone else — so none
    // of them is an error in the log. The one thing recorded is that it happened, never the name
    // that was claimed.
    if (
      error instanceof IdentityRequiredError ||
      error instanceof IdentityConflictError ||
      error instanceof VerifiedSessionError
    ) {
      logger.info('tool refused on identity', { tool, reason: error.name });
      return errorResult(error.message);
    }

    // A closed record is final. Ivanti marks it read-only and then accepts the write anyway, so
    // this refusal is the only thing between a caller and a silently-edited closed ticket.
    if (error instanceof RecordClosedError) {
      logger.debug('write refused, record closed', { tool });
      return errorResult(error.message);
    }

    if (error instanceof NotYourQueueError) {
      logger.info('tool refused a question about someone else', { tool });
      return errorResult(error.message);
    }

    if (error instanceof NotYourRecordError) {
      logger.info('tool refused a record that is not the caller\'s', { tool });
      return errorResult(error.message);
    }

    if (error instanceof UnscopableObjectError) {
      logger.warn('object has no person link', { tool, object: error.object });
      return errorResult(error.message);
    }

    // Refused before anything was written: the value was not on the list.
    if (error instanceof ValidatedValueError) {
      logger.debug('tool refused a validated value', { tool, field: error.field });
      return errorResult(error.message);
    }

    // The write happened and did not take. This is the one failure that must never read as
    // success, so it is logged at error level even though the caller can act on it.
    if (error instanceof WriteNotStoredError) {
      logger.error('ivanti write did not store', { tool });
      return errorResult(error.message);
    }

    // Ivanti refused the submit inside a 200 and created nothing. The caller can fix it from
    // the message, so it is a rejection rather than a failure.
    if (error instanceof SubmitRefusedError) {
      logger.debug('service request refused', { tool });
      return errorResult(error.message);
    }

    // The tenant refused the extension, which is a rename rather than a retry.
    if (error instanceof AttachmentTypeRefusedError) {
      logger.debug('upload refused, file type', { tool });
      return errorResult(error.message);
    }

    // Nothing was sent: the record the file would hang off is not there.
    if (error instanceof ParentNotFoundError) {
      logger.debug('upload refused, no such parent', { tool });
      return errorResult(error.message);
    }

    // The file is in Ivanti and on no record. Logged at error level because nobody asked for
    // that outcome and someone has to clean it up.
    if (error instanceof OrphanedAttachmentError) {
      logger.error('attachment uploaded but not attached', {
        tool,
        attachmentId: error.attachmentId,
      });
      return errorResult(error.message);
    }

    if (error instanceof RequiredFieldsError) {
      logger.debug('tool reported required fields', { tool, fields: error.fields.length });
      return errorResult(error.message);
    }

    if (error instanceof FieldNameError) {
      logger.debug('tool rejected a field name', { tool, fields: error.fields.length });
      return errorResult(error.message);
    }

    if (error instanceof UnknownEntityError) {
      logger.debug('tool rejected a name', { tool, entity: error.entity });
      return errorResult(error.message);
    }

    // Never sent: this server's own cap on requests to the tenant stayed full. Not Ivanti's
    // failure, and not a write that may have been applied — the model is told to try again.
    if (error instanceof IvantiBusyError) {
      logger.warn('ivanti request cap reached; request not sent', { tool, limit: error.limit });
      return errorResult(`${error.message} Nothing was changed. Try again in a moment.`);
    }

    // Ivanti answered, with more than the caller agreed to hold. Nothing failed.
    if (error instanceof ResponseTooLargeError) {
      logger.debug('tool refused a response too large to read', { tool });
      return errorResult(error.message);
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
const isUnanswered = (error: IvantiApiError): boolean =>
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
