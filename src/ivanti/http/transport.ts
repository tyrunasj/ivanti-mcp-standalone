// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import { IvantiApiError, ResponseTooLargeError, scrubErrorBody } from './errors.js';
import {
  exchange,
  readText,
  type ExchangeContext,
  type FetchLike,
  type FetchResponse,
} from './exchange.js';
import { createIvantiRoutes, type IvantiRoutes } from '../odata/url.js';

export type { FetchLike } from './exchange.js';

/** Reads: `IVANTI_TIMEOUT_MS`. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Everything but a GET: `IVANTI_WRITE_TIMEOUT_MS`. Three times the read timeout because a create
 * runs the tenant's workflow before it answers — measured past 10 s on workflow-heavy objects — and
 * a write that times out may still have been applied, which is the costliest way to fail.
 */
export const DEFAULT_WRITE_TIMEOUT_MS = 30_000;

/**
 * The most `requestBinary` reads when the caller names no cap. Nothing a conversation can hold is
 * anywhere near it; the cap is there so that a 2 GB attachment is refused rather than buffered.
 */
export const DEFAULT_MAX_BINARY_BYTES = 25 * 1024 * 1024;

export interface TransportOptions {
  baseUrl: string;
  /** From `probeBasePath` — `/HEAT` or empty. */
  basePath: string;
  apiKey: string;
  logger: Logger;
  fetchImpl?: FetchLike;
  /** GETs. */
  timeoutMs?: number;
  /** Everything else — creates, updates, deletes, uploads. */
  writeTimeoutMs?: number;
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
   *
   * Never more than `maxBytes` (default `DEFAULT_MAX_BINARY_BYTES`): a declared `Content-Length`
   * over it is refused before the body is read, and an undeclared one is read until it passes the
   * cap and abandoned there. Either way the caller gets a `ResponseTooLargeError`.
   */
  requestBinary: (
    url: string,
    options?: { maxBytes?: number },
  ) => Promise<{ bytes: Uint8Array; contentType: string }>;
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
export function createTransport(options: TransportOptions): IvantiTransport {
  const {
    baseUrl,
    basePath,
    apiKey,
    logger,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    writeTimeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
    sid,
  } = options;

  const context: ExchangeContext = {
    fetchImpl,
    logger,
    timeoutMs,
    writeTimeoutMs,
    secrets: sid === undefined ? [apiKey] : [apiKey, sid],
    credential: sid === undefined ? 'service' : 'person',
  };

  // One credential or the other, never both: sending the key as well would have Ivanti answer
  // for the service account and quietly undo the impersonation.
  const credential: Record<string, string> =
    sid === undefined
      ? // The header Ivanti wants: `rest_api_key=<key>`, with an equals sign.
        { Authorization: `rest_api_key=${apiKey}` }
      : { Cookie: `SID=${sid}` };

  const send = async (
    url: string,
    init: RequestInit,
    // A FormData body is passed through as-is and carries its own content type.
    raw = false,
  ): Promise<{ status: number; text: string }> => {
    const { status, body } = await exchange(
      url,
      {
        method: init.method ?? 'GET',
        headers: {
          ...credential,
          Accept: 'application/json',
          ...(init.body === undefined || raw ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
        // `raw` means the body is already a wire form fetch understands (FormData); everything
        // else is a plain object this layer serialises.
        ...(init.body === undefined
          ? {}
          : { body: raw ? (init.body as FormData) : JSON.stringify(init.body) }),
      },
      context,
      readText,
    );
    return { status, text: body };
  };

  const parse = <T>(text: string, url: string, method: string): T => {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new IvantiApiError(
        { status: 200, method, url, body: scrubErrorBody(text, ...context.secrets) },
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

    async requestBinary(
      url: string,
      { maxBytes = DEFAULT_MAX_BINARY_BYTES }: { maxBytes?: number } = {},
    ): Promise<{ bytes: Uint8Array; contentType: string }> {
      const { body } = await exchange(
        url,
        // The same credential as every other call here. This method once built its own headers,
        // sent the API key whatever `sid` said, and Ivanti logged every download by an
        // impersonated person as the service account.
        { method: 'GET', headers: { ...credential, Accept: '*/*' } },
        context,
        async (response) => ({
          bytes: await readCapped(response, url, maxBytes),
          // What Ivanti says it is. Sniffing would be guessing about somebody's file.
          contentType: response.headers?.get('content-type') ?? 'application/octet-stream',
        }),
      );
      return body;
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

/**
 * A file body, never more than `maxBytes` of it.
 *
 * `arrayBuffer()` reads the whole of whatever arrives before anyone can look at its size, so an
 * attachment of any size used to be held in memory — and again as base64 — only to find out it was
 * too big to return. The declared length refuses the obvious case for free; the stream refuses the
 * rest, including a body that decompresses to far more than its `Content-Length` said.
 */
async function readCapped(
  response: FetchResponse,
  url: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers?.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Released rather than left for the connection to drain.
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(url, maxBytes, declared);
  }

  if (response.body !== undefined && response.body !== null) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(url, maxBytes);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  // A fixture with no stream. Bounded after the fact, which still bounds what is handed back.
  if (response.arrayBuffer === undefined) {
    throw new IvantiApiError(
      { status: 200, method: 'GET', url },
      'This transport cannot read a file body',
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new ResponseTooLargeError(url, maxBytes, bytes.byteLength);
  return bytes;
}
