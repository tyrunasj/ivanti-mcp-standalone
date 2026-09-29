// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import { countIvantiRequest } from '../../usage/call-usage.js';
import { IvantiApiError, pathOf, scrubErrorBody } from './errors.js';

export interface FetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  /** Only a binary read needs these; a fixture that serves no files may omit them. */
  arrayBuffer?: () => Promise<ArrayBuffer>;
  headers?: { get: (name: string) => string | null };
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    /** A string for every JSON or form call; `FormData` only for a multipart upload. */
    body?: string | FormData;
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

export interface ExchangeInit {
  method: string;
  headers: Record<string, string>;
  body?: string | FormData;
}

export interface ExchangeContext {
  fetchImpl: FetchLike;
  logger: Logger;
  timeoutMs: number;
  /** Every credential the call carries — redacted from anything Ivanti echoes back. */
  secrets: readonly string[];
}

export const readText = (response: FetchResponse): Promise<string> => response.text();

/**
 * One request to Ivanti, on any surface — OData, REST, ASMX, the handlers, CentralConfig.
 *
 * Each surface had its own copy of fetch-read-check, and the copies had drifted: only the OData
 * one logged, none logged a timeout, and three let a dropped connection escape as a raw
 * `TypeError` that `runTool` then reported as a bug in this server. Here every Ivanti failure is
 * an `IvantiApiError` — status 0 when Ivanti never answered — and every request is one debug line.
 *
 * Reading the body is still the request, and still under the timeout. A reset, a proxy dropping a
 * long transfer, a decompression error: all of them land mid-body, and the metadata catalog evicts
 * a cached failure only for `status: 0` — so a raw error from the read poisoned that URL's schema
 * for the life of the process. `$metadata` (~325 KB) is where that is likeliest.
 *
 * The debug line carries the query and, for a write, the field names — never a body's values,
 * which are ticket text. Nothing above debug may carry the query: a `$filter` routinely holds a
 * person's name.
 */
export async function exchange<T>(
  url: string,
  init: ExchangeInit,
  context: ExchangeContext,
  read: (response: FetchResponse) => Promise<T>,
): Promise<{ status: number; body: T }> {
  const { fetchImpl, logger, timeoutMs, secrets } = context;
  const started = Date.now();
  // Counted when sent, not when answered: a timeout cost the call as much as a reply did.
  countIvantiRequest();

  const line = (status: number, error?: string): Record<string, unknown> => ({
    method: init.method,
    path: pathOf(url),
    ...queryOf(url, secrets),
    ...fieldsOf(init.body),
    status,
    ms: Date.now() - started,
    ...(error === undefined ? {} : { error }),
  });

  const unanswered = (cause: unknown): IvantiApiError => {
    const reason = scrubErrorBody(cause instanceof Error ? cause.message : String(cause), ...secrets);
    logger.debug('ivanti request failed', line(0, reason));
    return new IvantiApiError(
      { status: 0, method: init.method, url, body: reason },
      `Ivanti ${init.method} did not complete: ${reason}`,
    );
  };

  let response: FetchResponse;
  try {
    response = await fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw unanswered(cause);
  }

  if (!response.ok) {
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw unanswered(cause);
    }
    const body = scrubErrorBody(text, ...secrets);
    logger.debug('ivanti request failed', line(response.status, body));
    throw new IvantiApiError({ status: response.status, method: init.method, url, body });
  }

  let body: T;
  try {
    body = await read(response);
  } catch (cause) {
    // Already says what went wrong — a transport that cannot read the body it was asked for.
    if (cause instanceof IvantiApiError) throw cause;
    throw unanswered(cause);
  }

  logger.debug('ivanti request', line(response.status));
  return { status: response.status, body };
}

/**
 * A parameter whose value is a credential, by name. CentralConfig's `RemoveSession` takes the
 * person's live SID as `?sessionId=` — on a call whose own credential is the ConfigDB key, so
 * redacting `secrets` alone would have logged it.
 */
const CREDENTIAL_PARAMETER =
  /^(session_?id|session_?key|sid|api_?key|access_token|token|password|secret)$/i;

/** Decoded, so a `$filter` reads as written rather than percent-encoded. */
function queryOf(url: string, secrets: readonly string[]): { query?: Record<string, string> } {
  try {
    const query = Object.fromEntries(
      [...new URL(url).searchParams].map(([name, value]) => [
        name,
        CREDENTIAL_PARAMETER.test(name) ? '[REDACTED]' : scrubErrorBody(value, ...secrets),
      ]),
    );
    return Object.keys(query).length === 0 ? {} : { query };
  } catch {
    return {};
  }
}

/** The names a body carries, never its values. */
function fieldsOf(body: string | FormData | undefined): { fields?: string[] } {
  if (body === undefined) return {};
  if (typeof body !== 'string') return { fields: [...new Set(body.keys())] };
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? { fields: Object.keys(parsed) }
      : {};
  } catch {
    // Not JSON, so the form-urlencoded body of an `.ashx` handler.
    return { fields: [...new Set(new URLSearchParams(body).keys())] };
  }
}
