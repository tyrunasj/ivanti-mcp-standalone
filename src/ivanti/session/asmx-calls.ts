// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { IvantiApiError, scrubErrorBody } from '../http/errors.js';
import { exchange, readText, type ExchangeContext } from '../http/exchange.js';
import type { IvantiRoutes } from '../odata/url.js';

/**
 * The four ways of speaking to Ivanti's ASMX/ASHX surface, written once.
 *
 * Two session kinds use them — the service account's (`asmx-session.ts`) and a named person's
 * (`impersonated-session.ts`) — and differ only in where the SID comes from and which credential
 * the exchange is stamped with, both of which arrive as `contextFor`. The envelope rule and the
 * three spellings of the CSRF token live here and nowhere else:
 *
 * - `.asmx` services: JSON, the token in the BODY as `_csrfToken`, the answer wrapped in `{ d }`.
 * - `.ashx` form handlers: form-urlencoded, the token as a LOWERCASE `_csrftoken` header.
 * - multipart handlers: the token as a MIXED-case `_csrfToken` header and no Content-Type, because
 *   only fetch knows the boundary it generated.
 */

/** A live session: the cookie and the token that goes with it. */
export interface AsmxCredentials {
  sid: string;
  csrf: string;
}

export interface PostJsonOptions {
  /** The session cookie, when there is one yet. */
  sid?: string;
  /**
   * Whether the answer must be wrapped in `{ "d": … }` (default). Pass `false` for a call that
   * does not promise the envelope — `FRSHEATIntegration.asmx/GetRolesForUser` — which then also
   * accepts an empty body and an unwrapped answer.
   */
  envelope?: boolean;
}

export interface AsmxCalls {
  postJson: <T>(url: string, body: Record<string, unknown>, options?: PostJsonOptions) => Promise<T>;
  /** `Services/X.asmx` + method, the token in the body. */
  callService: <T>(
    credentials: AsmxCredentials,
    servicePath: string,
    method: string,
    args?: Record<string, unknown>,
  ) => Promise<T>;
  /** `handlers/<handlerPath>`, form-urlencoded; the reply is text. */
  postForm: (
    credentials: AsmxCredentials,
    handlerPath: string,
    form: Record<string, string>,
  ) => Promise<string>;
  /** A multipart upload to `handlerPath`; the reply is text. */
  postMultipart: (credentials: AsmxCredentials, handlerPath: string, form: FormData) => Promise<string>;
}

export function createAsmxCalls(
  contextFor: (sid?: string) => ExchangeContext,
  routes: IvantiRoutes,
): AsmxCalls {
  const postJson = async <T>(
    url: string,
    body: Record<string, unknown>,
    { sid, envelope = true }: PostJsonOptions = {},
  ): Promise<T> => {
    const context = contextFor(sid);
    const { body: text } = await exchange(
      url,
      {
        method: 'POST',
        headers: {
          // No `Authorization` header: the SID cookie and CSRF token are the credential here,
          // and sending the API key as well confuses some deployments.
          'Content-Type': 'application/json; charset=UTF-8',
          Accept: 'application/json',
          ...(sid === undefined ? {} : { Cookie: `SID=${sid}` }),
        },
        body: JSON.stringify(body),
      },
      context,
      readText,
    );

    const fail = (message: string): IvantiApiError =>
      new IvantiApiError(
        { status: 200, method: 'POST', url, body: scrubErrorBody(text, ...context.secrets) },
        message,
      );

    let parsed: { d?: T };
    try {
      // Unguarded, a login page answering 200 escaped as a raw `SyntaxError` — which `runTool`
      // reports as a fault in this server rather than as something Ivanti said.
      parsed = (envelope || text !== '' ? JSON.parse(text) : {}) as { d?: T };
    } catch {
      throw fail('Ivanti session call answered 200 with a body that is not JSON');
    }

    if (parsed.d !== undefined) return parsed.d;
    if (envelope) throw fail('Ivanti session call answered without the expected `d` envelope');
    return parsed as T;
  };

  return {
    postJson,

    callService: <T>(
      { sid, csrf }: AsmxCredentials,
      servicePath: string,
      method: string,
      args: Record<string, unknown> = {},
    ): Promise<T> =>
      postJson<T>(routes.service(`${servicePath}/${method}`), { _csrfToken: csrf, ...args }, { sid }),

    async postForm({ sid, csrf }, handlerPath, form): Promise<string> {
      const { body } = await exchange(
        routes.service(`handlers/${handlerPath}`),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: `SID=${sid}`,
            _csrftoken: csrf,
          },
          body: new URLSearchParams(form).toString(),
        },
        contextFor(sid),
        readText,
      );
      return body;
    },

    async postMultipart({ sid, csrf }, handlerPath, form): Promise<string> {
      const { body } = await exchange(
        routes.service(handlerPath),
        { method: 'POST', headers: { Cookie: `SID=${sid}`, _csrfToken: csrf }, body: form },
        contextFor(sid),
        readText,
      );
      return body;
    },
  };
}
