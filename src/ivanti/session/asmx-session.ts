import type { Logger } from '../../logger.js';
import { IvantiApiError, scrubErrorBody } from '../http/errors.js';
import type { FetchLike } from '../http/transport.js';
import type { IvantiRoutes } from '../odata/url.js';

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
  /** The identity only if a session already exists — never worth a handshake just to label a row. */
  identityIfKnown: () => SessionIdentity | undefined;
}

export interface SessionOptions {
  baseUrl: string;
  routes: IvantiRoutes;
  apiKey: string;
  logger: Logger;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
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

  const postJson = async <T>(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<T> => {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          // No `Authorization` header: the SID cookie and CSRF token are the credential here,
          // and sending the API key as well confuses some deployments.
          'Content-Type': 'application/json; charset=UTF-8',
          Accept: 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new IvantiApiError(
        {
          status: 0,
          method: 'POST',
          url,
          body: scrubErrorBody(cause instanceof Error ? cause.message : String(cause), apiKey),
        },
        `Ivanti session call did not complete: ${cause instanceof Error ? cause.message : 'unknown'}`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new IvantiApiError({
        status: response.status,
        method: 'POST',
        url,
        body: scrubErrorBody(text, apiKey),
      });
    }

    let parsed: { d?: T };
    try {
      parsed = JSON.parse(text) as { d?: T };
    } catch {
      throw new IvantiApiError(
        { status: 200, method: 'POST', url, body: scrubErrorBody(text, apiKey) },
        'Ivanti session call answered 200 with a body that is not JSON',
      );
    }

    // ASMX wraps every answer in `{ "d": … }`.
    if (parsed.d === undefined) {
      throw new IvantiApiError(
        { status: 200, method: 'POST', url, body: scrubErrorBody(text, apiKey) },
        'Ivanti session call answered without the expected `d` envelope',
      );
    }
    return parsed.d;
  };

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
      { Cookie: `SID=${sid}` },
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
        { Cookie: `SID=${sid}` },
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

  const callOnce = async <T>(
    servicePath: string,
    method: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    const { sid, csrf } = await ensure();
    return postJson<T>(
      routes.service(`${servicePath}/${method}`),
      // `.asmx` wants the token in the BODY. The `.ashx` handlers want it as a lowercase header
      // instead, which is why they do not share this path.
      { _csrfToken: csrf, ...args },
      { Cookie: `SID=${sid}` },
    );
  };

  const postForm = async (url: string, form: Record<string, string>): Promise<string> => {
    const { sid, csrf } = await ensure();

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `SID=${sid}`,
        // Lowercase, and a header: the `.asmx` services want `_csrfToken` in the body instead.
        _csrftoken: csrf,
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new IvantiApiError({
        status: response.status,
        method: 'POST',
        url,
        body: scrubErrorBody(text, apiKey),
      });
    }
    return text;
  };

  const postMultipart = async (url: string, form: FormData): Promise<string> => {
    const { sid, csrf } = await ensure();

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Cookie: `SID=${sid}`,
        // Mixed-case here. The same token is `_csrftoken` on a form-urlencoded handler and
        // `_csrfToken` in an `.asmx` body — three spellings, one session.
        _csrfToken: csrf,
      },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new IvantiApiError({
        status: response.status,
        method: 'POST',
        url,
        body: scrubErrorBody(text, apiKey),
      });
    }
    return text;
  };

  return {
    async uploadToHandler(handlerPath: string, form: FormData): Promise<string> {
      const url = routes.service(handlerPath);
      try {
        return await postMultipart(url, form);
      } catch (error: unknown) {
        if (error instanceof IvantiApiError && error.status === 401) {
          session = undefined;
          return postMultipart(url, form);
        }
        throw error;
      }
    },

    async callHandler(handlerPath: string, form: Record<string, string>): Promise<string> {
      const url = routes.service(`handlers/${handlerPath}`);
      try {
        return await postForm(url, form);
      } catch (error: unknown) {
        if (error instanceof IvantiApiError && error.status === 401) {
          session = undefined;
          return postForm(url, form);
        }
        throw error;
      }
    },

    async call<T>(
      servicePath: string,
      method: string,
      args: Record<string, unknown> = {},
    ): Promise<T> {
      try {
        return await callOnce<T>(servicePath, method, args);
      } catch (error: unknown) {
        // An expired session is indistinguishable from a bad one until it is retried.
        if (error instanceof IvantiApiError && error.status === 401) {
          session = undefined;
          return callOnce<T>(servicePath, method, args);
        }
        throw error;
      }
    },

    identity: async () => (await ensure()).identity,
    identityIfKnown: () => session?.identity,
  };
}
