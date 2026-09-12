import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../../logger.js';
import { IvantiApiError, isIvantiNotFound } from '../../ivanti/http/errors.js';
import { UnknownEntityError } from '../../ivanti/metadata/catalog.js';
import { UnsupportedFilterError } from '../../ivanti/odata/filter.js';
import {
  ValidatedValueError,
  WriteNotStoredError,
} from '../../ivanti/write/validated-write.js';
import { FieldNameError } from './explain-field-error.js';
import { RequiredFieldsError } from './explain-required-fields.js';
import { ObjectNotAllowedError } from './object-gate.js';
import {
  IdentityRequiredError,
  NotYourRecordError,
  UnscopableObjectError,
} from './own-records.js';
import { IdentityConflictError, VerifiedSessionError } from '../../auth/identity-pin.js';
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

    if (error instanceof IvantiApiError) {
      logger.warn('ivanti call failed', { tool, status: error.status });
      const missing = isIvantiNotFound(error)
        ? ' The record or field does not exist — Ivanti reports both as 400 "Invalid key".'
        : '';
      return errorResult(`Ivanti refused the request (${String(error.status)}).${missing}\n${error.body}`);
    }

    logger.error('tool failed', {
      tool,
      error: error instanceof Error ? error.message : 'unknown error',
    });
    return errorResult(error instanceof Error ? error.message : 'Unknown error');
  }
}
