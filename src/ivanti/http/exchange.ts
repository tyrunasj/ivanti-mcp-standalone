// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import { countIvantiRequest } from '../../usage/call-usage.js';
import type { RequestLimiter } from './request-limiter.js';
import {
  IvantiApiError,
  type IvantiCredential,
  pathOf,
  ResponseTooLargeError,
  scrubErrorBody,
} from './errors.js';

export interface FetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  /** Only a binary read needs these; a fixture that serves no files may omit them. */
  arrayBuffer?: () => Promise<ArrayBuffer>;
  headers?: { get: (name: string) => string | null };
  /** The body as a stream, so a capped read can stop at the cap rather than after the whole file. */
  body?: ReadableStream<Uint8Array> | null;
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
  /** How long a GET may take. */
  timeoutMs: number;
  /**
   * How long anything else may take; `timeoutMs` when absent.
   *
   * Separate because a write runs the tenant's workflow before it answers, and a create that
   * fires business rules, notifications and an assignment routinely takes longer than a read ever
   * should. One timeout for both either hangs reads or cuts writes off — and a write cut off is
   * the worst failure there is, because it may well have been applied.
   */
  writeTimeoutMs?: number;
  /** Every credential the call carries — redacted from anything Ivanti echoes back. */
  secrets: readonly string[];
  /** Whose credential it is, stamped on every error this exchange throws. */
  credential?: IvantiCredential;
  /**
   * The process-wide cap on requests in flight to the tenant, shared by every context that talks
   * to it. A request waits for a slot as long as its own timeout, and is never sent if none frees.
   */
  limiter?: RequestLimiter;
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
  if (context.limiter === undefined) return send(url, init, context, read);
  // The slot covers the whole exchange, body included: Ivanti is busy until the body is sent.
  return context.limiter.run(() => send(url, init, context, read), timeoutFor(init.method, context));
}

const timeoutFor = (method: string, context: ExchangeContext): number =>
  isReadMethod(method) ? context.timeoutMs : (context.writeTimeoutMs ?? context.timeoutMs);

async function send<T>(
  url: string,
  init: ExchangeInit,
  context: ExchangeContext,
  read: (response: FetchResponse) => Promise<T>,
): Promise<{ status: number; body: T }> {
  const { fetchImpl, logger, secrets } = context;
  const timeoutMs = timeoutFor(init.method, context);
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
    const reason = scrubErrorBody(describeFailure(cause, timeoutMs), ...secrets);
    const code = failureCode(cause);
    logger.debug('ivanti request failed', line(0, reason));
    return new IvantiApiError(
      {
        status: 0,
        method: init.method,
        url,
        body: reason,
        ...(code === undefined ? {} : { code }),
        ...(context.credential === undefined ? {} : { credential: context.credential }),
      },
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
    throw new IvantiApiError({
      status: response.status,
      method: init.method,
      url,
      body,
      ...(context.credential === undefined ? {} : { credential: context.credential }),
    });
  }

  let body: T;
  try {
    body = await read(response);
  } catch (cause) {
    // Already says what went wrong — a transport that cannot read the body it was asked for.
    if (cause instanceof IvantiApiError) throw cause;
    // Ivanti answered; the caller declined to hold that much. Not a failure to reach anyone.
    if (cause instanceof ResponseTooLargeError) {
      logger.debug('ivanti request', line(response.status, 'larger than the caller reads'));
      throw cause;
    }
    throw unanswered(cause);
  }

  logger.debug('ivanti request', line(response.status));
  return { status: response.status, body };
}

/** Methods that change nothing, and so get the read timeout. */
export const isReadMethod = (method: string): boolean =>
  ['GET', 'HEAD'].includes(method.toUpperCase());

/**
 * Why a request got no answer, in words an operator can act on.
 *
 * Node's fetch rejects every network failure with the same `TypeError: fetch failed`, and puts
 * the reason — `getaddrinfo ENOTFOUND`, `ECONNRESET`, `unable to verify the first certificate` —
 * in `.cause`. Reporting the message alone made a DNS typo, a firewall and a corporate proxy's
 * certificate indistinguishable: all three read "did not complete: fetch failed".
 */
function describeFailure(cause: unknown, timeoutMs: number): string {
  if (isTimeout(cause)) return `no answer within ${String(timeoutMs)} ms`;

  const parts: string[] = [];
  let current: unknown = cause;
  // Bounded: a cause chain is two or three deep, and a cycle must not hang the error path.
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (!(current instanceof Error)) {
      // A rejection with a bare value; an object says nothing useful as `[object Object]`.
      if (typeof current === 'string' || typeof current === 'number') parts.push(String(current));
      break;
    }
    const code = codeOf(current);
    // `AggregateError` (every address refused) has an empty message and only a code.
    const text = [
      code !== undefined && !current.message.includes(code) ? code : undefined,
      current.message,
    ]
      .filter((part) => part !== undefined && part !== '')
      .join(' ');
    if (text !== '' && !parts.includes(text)) parts.push(text);
    current = current.cause;
  }
  return parts.length === 0 ? 'no reason given' : parts.join(': ');
}

/** The innermost code in the chain, which is the specific one: `ENOTFOUND` over `fetch failed`. */
function failureCode(cause: unknown): string | undefined {
  if (isTimeout(cause)) return 'TimeoutError';
  let found: string | undefined;
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    found = codeOf(current) ?? found;
    current = current.cause;
  }
  return found;
}

function codeOf(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code;
  // Only something code-shaped: this goes into a warn line, which must never carry a message.
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : undefined;
}

/** `AbortSignal.timeout` rejects with a `TimeoutError` — a DOMException, which is an Error. */
const isTimeout = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === 'TimeoutError';

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
