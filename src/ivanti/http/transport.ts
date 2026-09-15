// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import { IvantiApiError, scrubErrorBody } from './errors.js';
import { createIvantiRoutes, type IvantiRoutes } from '../odata/url.js';

export const DEFAULT_TIMEOUT_MS = 10_000;

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    /** A string for every JSON call; `FormData` only for a multipart upload. */
    body?: string | FormData;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  /** Only a binary read needs these; a fixture that serves no files may omit them. */
  arrayBuffer?: () => Promise<ArrayBuffer>;
  headers?: { get: (name: string) => string | null };
}>;

export interface TransportOptions {
  baseUrl: string;
  /** From `probeBasePath` — `/HEAT` or empty. */
  basePath: string;
  apiKey: string;
  logger: Logger;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /**
   * Authenticate as an impersonated session instead of with the API key.
   *
   * Measured: OData accepts a `SID` cookie with **no** `Authorization` header at all, and then
   * applies that person's own access — a self-service role reads none of the incidents an analyst
   * reads. So this is not a second way of saying the same thing; it changes what comes back.
   */
  sid?: string;
}

export interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface IvantiTransport {
  readonly routes: IvantiRoutes;
  /** Parsed JSON, or `undefined` for a 204. */
  request: <T>(url: string, init?: RequestInit) => Promise<T | undefined>;
  /** Same, but the caller requires a body — a 204 is an error. */
  requestRequired: <T>(url: string, init?: RequestInit) => Promise<T>;
  requestText: (url: string, init?: RequestInit) => Promise<string>;
  /**
   * A multipart upload on the same credential.
   *
   * Separate from `request` because the body must survive untouched — `request` JSON-stringifies
   * whatever it is given — and because the `Content-Type` header must **not** be set: only fetch
   * knows the boundary it generated, and supplying the header without it makes Ivanti read the
   * body as empty.
   */
  requestMultipart: <T>(url: string, form: FormData) => Promise<T | undefined>;
  /**
   * A file, as bytes rather than as text.
   *
   * `requestText` would decode whatever came back as UTF-8, which silently corrupts anything that
   * is not — a PNG read that way is not a PNG any more. So this reads the body as bytes and hands
   * back what Ivanti said it was.
   */
  requestBinary: (url: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
  /**
   * The same surface, authenticating as an impersonated session.
   *
   * OData and REST only — which is the whole of this module. The form and admin surfaces refuse a
   * CentralConfig session whatever role it holds, and they are not reachable from here anyway.
   */
  asPerson: (sid: string) => IvantiTransport;
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
    sid,
  } = options;

  const send = async (
    url: string,
    init: RequestInit,
    // A FormData body is passed through as-is and carries its own content type.
    raw = false,
  ): Promise<{ status: number; text: string }> => {
    const method = init.method ?? 'GET';
    const started = Date.now();

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          // One credential or the other, never both: sending the key as well would have Ivanti
          // answer for the service account and quietly undo the impersonation.
          ...(sid === undefined
            ? // The header Ivanti wants: `rest_api_key=<key>`, with an equals sign.
              { Authorization: `rest_api_key=${apiKey}` }
            : { Cookie: `SID=${sid}` }),
          Accept: 'application/json',
          ...(init.body === undefined || raw ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
        // `raw` means the body is already a wire form fetch understands (FormData); everything
        // else is a plain object this layer serialises.
        ...(init.body === undefined
          ? {}
          : { body: raw ? (init.body as FormData) : JSON.stringify(init.body) }),
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

    // Reading the body is still the request, and still under the timeout. Outside the try it threw
    // a RAW `TimeoutError`/`TypeError` rather than an `IvantiApiError` — and the metadata catalog
    // evicts a cached failure only for `IvantiApiError` with `status: 0`, so one interrupted body
    // read poisoned that URL's schema for the life of the process. `$metadata` is the largest
    // document this server fetches (~325 KB), which is exactly where a mid-body failure is
    // likeliest. A reset, a proxy dropping a long transfer and a decompression error all land here
    // too, not only the timeout.
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
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
    routes: createIvantiRoutes(baseUrl, basePath),

    // Same everything, one credential swapped. Callers memoise per session rather than per call
    // — see `transportFor` — so this is not a per-request allocation.
    asPerson: (nextSid: string): IvantiTransport => createTransport({ ...options, sid: nextSid }),

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

    async requestMultipart<T>(url: string, form: FormData): Promise<T | undefined> {
      const { status, text } = await send(
        url,
        { method: 'POST', body: form },
        true,
      );
      if (status === 204 || text.trim() === '') return undefined;
      return parse<T>(text, url, 'POST');
    },

    async requestBinary(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          // The same one-or-the-other rule `send` applies, and it has to be applied here too:
          // this is the only method that does not go through `send`, so it ignored the `sid` it
          // was built with and fetched the FILE BYTES on the service account while every other
          // call on the same transport — including the OData DELETE of that same attachment —
          // used the person's SID. It predates impersonation and was simply not revisited.
          //
          // Not a demonstrated cross-person leak: the caller reads the attachment row on the
          // person's credential first, and in `enduser` re-checks the parent. What it did break
          // is attribution — Ivanti logged the download as the service account — and it rested on
          // an assumption where the rest of this codebase rests on a measurement.
          ...(sid === undefined
            ? { Authorization: `rest_api_key=${apiKey}` }
            : { Cookie: `SID=${sid}` }),
          Accept: '*/*',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new IvantiApiError({
          status: response.status,
          method: 'GET',
          url,
          body: scrubErrorBody(await response.text(), apiKey),
        });
      }

      if (response.arrayBuffer === undefined) {
        throw new IvantiApiError(
          { status: 200, method: 'GET', url },
          'This transport cannot read a file body',
        );
      }

      logger.debug('ivanti file read', { path: pathOf(url), status: response.status });

      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        // What Ivanti says it is. Sniffing would be guessing about somebody's file.
        contentType: response.headers?.get('content-type') ?? 'application/octet-stream',
      };
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
