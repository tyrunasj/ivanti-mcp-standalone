import type { Logger } from '../logger.js';
import { IvantiApiError, scrubErrorBody } from './errors.js';
import { createOdataRoutes, type OdataRoutes } from './odata-url.js';

export const DEFAULT_TIMEOUT_MS = 10_000;

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export interface TransportOptions {
  baseUrl: string;
  /** From `probeBasePath` — `/HEAT` or empty. */
  basePath: string;
  apiKey: string;
  logger: Logger;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface IvantiTransport {
  readonly routes: OdataRoutes;
  /** Parsed JSON, or `undefined` for a 204. */
  request: <T>(url: string, init?: RequestInit) => Promise<T | undefined>;
  /** Same, but the caller requires a body — a 204 is an error. */
  requestRequired: <T>(url: string, init?: RequestInit) => Promise<T>;
  requestText: (url: string, init?: RequestInit) => Promise<string>;
}

/**
 * The authenticated HTTP layer for Ivanti's `rest_api_key` surfaces — OData, REST and
 * `$metadata`.
 *
 * The ASMX surface is deliberately **not** here: it authenticates with a SID cookie and a CSRF
 * token rather than this header, and has its own session lifecycle. Keeping the two apart is
 * what stops a caller reaching for the wrong credential.
 */
/** The path without the query string, for logs. Falls back to nothing rather than throwing. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

export function createTransport(options: TransportOptions): IvantiTransport {
  const {
    baseUrl,
    basePath,
    apiKey,
    logger,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const send = async (url: string, init: RequestInit): Promise<{ status: number; text: string }> => {
    const method = init.method ?? 'GET';
    const started = Date.now();

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          // The header Ivanti wants: `rest_api_key=<key>`, with an equals sign.
          Authorization: `rest_api_key=${apiKey}`,
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      // A timeout or a connection failure is not an Ivanti answer; say so rather than
      // inventing a status.
      throw new IvantiApiError(
        {
          status: 0,
          method,
          url,
          body: scrubErrorBody(cause instanceof Error ? cause.message : String(cause), apiKey),
        },
        `Ivanti ${method} did not complete: ${cause instanceof Error ? cause.message : 'unknown error'}`,
        );
    }

    const text = await response.text();
    // The path, never the query: a `$filter` carries whatever the caller searched for, which for
    // Ivanti routinely means a person's name. Without the path, a failure line says only that
    // *something* returned 400.
    logger.debug('ivanti request', {
      method,
      path: pathOf(url),
      status: response.status,
      ms: Date.now() - started,
    });

    if (!response.ok) {
      throw new IvantiApiError({
        status: response.status,
        method,
        url,
        body: scrubErrorBody(text, apiKey),
      });
    }

    return { status: response.status, text };
  };

  const parse = <T>(text: string, url: string, method: string): T => {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new IvantiApiError(
        { status: 200, method, url, body: scrubErrorBody(text, apiKey) },
        'Ivanti answered 200 with a body that is not JSON',
      );
    }
  };

  return {
    routes: createOdataRoutes(baseUrl, basePath),

    async request<T>(url: string, init: RequestInit = {}): Promise<T | undefined> {
      const { status, text } = await send(url, init);
      if (status === 204 || text.trim() === '') return undefined;
      return parse<T>(text, url, init.method ?? 'GET');
    },

    async requestRequired<T>(url: string, init: RequestInit = {}): Promise<T> {
      const { text } = await send(url, init);
      if (text.trim() === '') {
        throw new IvantiApiError(
          { status: 200, method: init.method ?? 'GET', url },
          'Ivanti answered 200 with an empty body where a record was expected',
        );
      }
      return parse<T>(text, url, init.method ?? 'GET');
    },

    async requestText(url: string, init: RequestInit = {}): Promise<string> {
      // `Accept: application/json` on `$metadata` makes Ivanti answer **500** — it tries to
      // negotiate CSDL into JSON and throws. Measured live; the same URL answers 200 with
      // 325 KB of XML when asked for XML. Callers may still override.
      return (await send(url, { ...init, headers: { Accept: 'application/xml', ...init.headers } }))
        .text;
    },
  };
}
