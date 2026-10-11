// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import { IvantiApiError } from '../http/errors.js';
import type { ExchangeContext } from '../http/exchange.js';
import type { RequestLimiter } from '../http/request-limiter.js';
import type { FetchLike } from '../http/transport.js';
import type { IvantiRoutes } from '../odata/url.js';
import { createAsmxCalls } from './asmx-calls.js';

/**
 * Ivanti's **second** authentication protocol.
 *
 * OData and REST take `Authorization: rest_api_key=<key>`. The ASMX services take none of that:
 * a three-step handshake yields a SID cookie and a CSRF token, and every later call carries both.
 * The two regimes are kept in separate modules so a caller cannot reach for the wrong credential.
 *
 * The session lives for the process. Concurrent first calls share one handshake — a cold start
 * that fired eight tool calls would otherwise open eight sessions.
 */

export interface SessionIdentity {
  /**
   * The role the session **actually** runs as. The `role` argument to `AuthenticateTenantAPIKey`
   * is a *request*: asking for one the account does not hold silently downgrades to its real one,
   * so this is read back from the server rather than assumed.
   */
  role: string;
  roleDisplayName?: string;
  /**
   * Who this connection signs in **as** — the account behind the API key, never the human asking.
   * Anything Ivanti resolves "for the current user" answers for this identity.
   */
  displayName?: string;
  userName?: string;
}

export interface IvantiSession {
  /** POST to an ASMX service, e.g. `call('Services/Workspace.asmx', 'GetRoleWorkspaces', {…})`. */
  call: <T>(servicePath: string, method: string, args?: Record<string, unknown>) => Promise<T>;
  /**
   * POST to an `.ashx` handler — a **third** calling convention on the same session: a
   * form-urlencoded body, the CSRF token as a lowercase `_csrftoken` **header** rather than in the
   * body, and a reply that is text rather than JSON.
   *
   * The path has a folder per handler: `handlers/GridDataHandler/GridDataHandler.ashx`, not
   * `handlers/GridDataHandler.ashx` — the shorter form answers 404. Verified live: without the
   * header the handler answers **551**, with it 200.
   */
  callHandler: (handlerPath: string, form: Record<string, string>) => Promise<string>;
  /**
   * The **multipart** convention, which is the third casing of the same token: `_csrfToken` as a
   * header, mixed-case this time, where the form-urlencoded handlers want it lowercase and the
   * `.asmx` services want it in the body. Content-Type is left to fetch, because only fetch knows
   * the boundary it generated.
   */
  uploadToHandler: (handlerPath: string, form: FormData) => Promise<string>;
  /** Establishes the session if needed and reports who it belongs to. */
  identity: () => Promise<SessionIdentity>;
}

export interface SessionOptions {
  baseUrl: string;
  routes: IvantiRoutes;
  apiKey: string;
  logger: Logger;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** The process-wide cap on requests in flight to the tenant; see `request-limiter.ts`. */
  limiter?: RequestLimiter;
}

interface Handshake {
  sid: string;
  csrf: string;
  identity: SessionIdentity;
}

interface SessionStatus {
  SessionCsrfToken?: string;
  ActiveRole?: string;
  ActiveRoleDisplayName?: string;
  UserName?: string;
}

interface UserData {
  UserRole?: string;
  DisplayName?: string;
}

export const DEFAULT_SESSION_TIMEOUT_MS = 15_000;

export function createSession(options: SessionOptions): IvantiSession {
  const {
    baseUrl,
    routes,
    apiKey,
    logger,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  } = options;

  let session: Handshake | undefined;
  let pending: Promise<Handshake> | undefined;

  // The SID is as much a credential as the key — it is a live session on the service account —
  // and Ivanti echoes submitted values into failures.
  const secretsFor = (sid?: string): string[] => (sid === undefined ? [apiKey] : [apiKey, sid]);
  const contextFor = (sid?: string): ExchangeContext => ({
    fetchImpl,
    logger,
    timeoutMs,
    secrets: secretsFor(sid),
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
  });

  const { postJson, callService, postForm, postMultipart } = createAsmxCalls(contextFor, routes);

  const handshake = async (): Promise<Handshake> => {
    // `tenantId` is the host, not a name someone chose — the same string that is in the URL.
    const tenantId = new URL(baseUrl).hostname;

    const sid = await postJson<string>(
      routes.service('ServiceAPI/FRSHEATIntegration.asmx/AuthenticateTenantAPIKey'),
      { tenantId, apiKey, role: 'Admin' },
    );

    const status = await postJson<SessionStatus>(
      routes.service('Services/Session.asmx/InitializeSession'),
      { _csrfToken: null },
      { sid },
    );

    const csrf = status.SessionCsrfToken;
    if (csrf === undefined || csrf === '') {
      throw new Error('InitializeSession returned no CSRF token; the session is unusable.');
    }

    // InitializeSession already reports the effective role, so the identity is never a guess even
    // when the richer call below fails.
    const identity: SessionIdentity = {
      role: status.ActiveRole ?? 'unknown',
      ...(status.ActiveRoleDisplayName === undefined
        ? {}
        : { roleDisplayName: status.ActiveRoleDisplayName }),
      ...(status.UserName === undefined ? {} : { userName: status.UserName }),
    };

    try {
      const user = await postJson<UserData>(
        routes.service('Services/Session.asmx/GetUserData'),
        { _csrfToken: csrf, tzoffset: 0 },
        { sid },
      );
      if (user.UserRole !== undefined && user.UserRole !== '') identity.role = user.UserRole;
      if (user.DisplayName !== undefined && user.DisplayName !== '') {
        identity.displayName = user.DisplayName;
      }
    } catch (error: unknown) {
      // Non-fatal by design: the session works, only the display name is missing.
      logger.warn('ivanti GetUserData failed; using the role InitializeSession reported', {
        role: identity.role,
        reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
      });
    }

    logger.info('ivanti session established', {
      role: identity.role,
      roleDisplayName: identity.roleDisplayName,
    });

    return { sid, csrf, identity };
  };

  const ensure = async (): Promise<Handshake> => {
    if (session !== undefined) return session;
    pending ??= handshake();

    try {
      session = await pending;
      return session;
    } finally {
      pending = undefined;
    }
  };

  /**
   * Sends on the session, and once more on a new one when Ivanti answers 401.
   *
   * An expired session is indistinguishable from a bad one until it is retried. What is discarded
   * is **the session this request carried**, and only while it is still the current one: calls
   * run concurrently, and a 401 arriving late from a request sent on an old session once threw
   * away the fresh session another call had just made — costing a second handshake, and failing
   * the calls that were already using it.
   */
  const withSession = async <T>(send: (handshake: Handshake) => Promise<T>): Promise<T> => {
    const used = await ensure();
    try {
      return await send(used);
    } catch (error: unknown) {
      if (!(error instanceof IvantiApiError) || error.status !== 401) throw error;
      if (session === used) session = undefined;
      return send(await ensure());
    }
  };

  return {
    uploadToHandler(handlerPath: string, form: FormData): Promise<string> {
      return withSession((handshake) => postMultipart(handshake, handlerPath, form));
    },

    callHandler(handlerPath: string, form: Record<string, string>): Promise<string> {
      return withSession((handshake) => postForm(handshake, handlerPath, form));
    },

    call<T>(servicePath: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
      return withSession((handshake) => callService<T>(handshake, servicePath, method, args));
    },

    identity: async () => (await ensure()).identity,
  };
}
