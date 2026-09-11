import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../../logger.js';
import { IvantiApiError, isIvantiNotFound } from '../../ivanti/http/errors.js';
import { UnknownEntityError } from '../../ivanti/metadata/catalog.js';
import { UnsupportedFilterError } from '../../ivanti/odata/filter.js';
import { FieldNameError } from './explain-field-error.js';
import { ObjectNotAllowedError } from './object-gate.js';
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
