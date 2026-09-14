// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import { IvantiApiError, scrubErrorBody } from '../http/errors.js';
import type { FetchLike } from '../http/transport.js';

/**
 * Ivanti's **third** authentication protocol: CentralConfig, which mints a session for a *named
 * person* rather than for the account holding a key.
 *
 * It is a different host (the ConfigDB tenant), a different credential (an `ApiKey` header, not
 * `Authorization: rest_api_key=`), and a different wire format (XML, where everything else here
 * answers JSON). Keeping it in its own module is the same argument that separates
 * `asmx-session.ts` from `transport.ts`: three credentials that must never be reached for by
 * mistake.
 *
 * **What the session it returns can do is narrow, and the boundary is not negotiable.** It drives
 * OData and `Session.asmx`. Every `Workspace.asmx` method and the admin console answer **551** to
 * it, whatever role it holds — so forms, pick lists, quick actions and the catalog keep running
 * as the service account. See `docs/impersonation-plan.md` §1.
 */

/** The one shape of reply that matters; everything else in it is deliberately dropped. */
export interface ImpersonatedSession {
  /**
   * The SID cookie value, in the form Ivanti's own session store keys on.
   *
   * **Not** what CentralConfig returns. It answers a bare `SessionId`, and a bare `SessionId`
   * sent as a cookie makes `InitializeSession` fail with *"ConnectionParams object is required"* —
   * which reads as a broken endpoint and is really "no session by that id". The tenant prefix and
   * the trailing segment are what make it resolvable. See `composeSid`.
   */
  sid: string;
  /** The login Ivanti matched, echoed back — not necessarily the spelling that was asked for. */
  loginId: string;
  /** When the session key stops being valid, when Ivanti says. */
  expiresAt?: string;
}

export interface CentralConfigOptions {
  /** The ConfigDB tenant, e.g. `https://config-<tenant>/`. */
  configUrl: string;
  /** The tenant being impersonated *into* — its hostname is Ivanti's `tenantId`. */
  tenantHost: string;
  /** The `CentralConfigApiKey` group key. Never the tenant API key. */
  apiKey: string;
  logger: Logger;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface CentralConfig {
  /**
   * Startup check: is CentralConfig reachable, and is the key accepted?
   *
   * **It does not prove that impersonation will work**, and the difference matters. It calls
   * `GetTenantTimeout`, which answers 200 for a tenant it has never heard of — returning a
   * default `120` where the real tenant answers `18000` — so a wrong `IVANTI_BASE_URL` host
   * passes this and fails at the first `act_as`. That is an acceptable trade: `act_as` refuses
   * with a reason, and the alternative does not exist.
   *
   * `FindActiveTenantRecord` *would* catch a wrong tenant — it answers an empty body for an
   * unknown one — and is deliberately not used: it returns the tenant's `DBConnectionString` and
   * `PrimaryEncryptionKey`. Pulling the database credentials across the wire on every boot is not
   * worth catching a typo. `GetTenantTimeout` returns one integer and nothing else.
   */
  probe: () => Promise<void>;
  /** Opens a session as `login`, or throws with a reason a human can act on. */
  authenticate: (login: string) => Promise<ImpersonatedSession>;
  /** Best-effort release. A leaked session expires on its own; a failed release is not an error. */
  release: (sid: string) => Promise<void>;
}

export const DEFAULT_CENTRAL_CONFIG_TIMEOUT_MS = 15_000;

/**
 * The session-store key: `<tenantId>#<sessionId>#<n>`.
 *
 * Measured against a working handshake, which answers exactly this shape
 * (`tenant.example.com#ABC…#1`), while CentralConfig answers only the middle segment. The
 * trailing `1` is that form's own value; nothing observed varies it.
 */
export function composeSid(tenantHost: string, sessionId: string): string {
  return `${tenantHost}#${sessionId}#1`;
}

/** XML, one level deep, no namespaces — a parser would be more machinery than the reply deserves. */
function element(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`, 'i').exec(xml);
  return match?.[1];
}

/**
 * Turns Ivanti's refusal into something a person can act on.
 *
 * *"Can't find user name X"* is the trap: it does **not** mean the login is wrong. It means no
 * **enabled** user has that name — `Disabled` is a separate field from `Status`, and they
 * disagree freely. Six accounts here read `Status: Active` throughout while the call refused the
 * ones whose `Disabled` bit was set, so anyone reading the literal message goes looking for a
 * typo that is not there.
 */
function explainRefusal(status: string | undefined, login: string): string {
  if (status !== undefined && /can.?t find user/i.test(status)) {
    return (
      `Ivanti has no enabled user named ${login}. The account may exist but be disabled — ` +
      `that is a different field from Status, and an account can read Active while disabled.`
    );
  }
  if (status !== undefined && /accessdenied/i.test(status)) {
    return (
      `Ivanti refused to open a session for ${login} (AccessDenied). The usual cause is that ` +
      `the account is disabled.`
    );
  }
  return `Ivanti refused to open a session for ${login}${status === undefined ? '' : `: ${status}`}.`;
}

export function createCentralConfig(options: CentralConfigOptions): CentralConfig {
  const {
    configUrl,
    tenantHost,
    apiKey,
    logger,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_CENTRAL_CONFIG_TIMEOUT_MS,
  } = options;

  const service = (method: string, query: Record<string, string>): string => {
    const url = new URL(`CentralConfig/CentralConfig.asmx/${method}`, configUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
  };

  const get = async (url: string): Promise<string> => {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        // The key is a header here. It is not `Authorization`, and it is not the tenant key.
        headers: { ApiKey: apiKey, Accept: 'application/xml' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: unknown) {
      throw new IvantiApiError(
        { status: 0, method: 'GET', url: redactQuery(url), body: '' },
        `CentralConfig is unreachable: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new IvantiApiError({
        status: response.status,
        method: 'GET',
        url: redactQuery(url),
        // The reply carries the tenant's database credentials even when it fails.
        body: scrubErrorBody(text, apiKey),
      });
    }
    return text;
  };

  return {
    async probe(): Promise<void> {
      // A wrong key answers 401 here, which is the whole point: this distinguishes "misconfigured"
      // from "unreachable" at startup rather than at the first act_as.
      await get(service('GetTenantTimeout', { tenantId: tenantHost }));
    },

    async authenticate(login): Promise<ImpersonatedSession> {
      const xml = await get(
        service('AuthenticateAPI', { userName: login, tenantId: tenantHost }),
      );

      const sessionId = element(xml, 'SessionId');
      if (sessionId === undefined || sessionId === '') {
        // Deliberately not including the body: it carries ConnectionString on success and is not
        // worth the risk of a partial success reaching a log.
        throw new Error(explainRefusal(element(xml, 'AuthenticationStatus'), login));
      }

      // Everything else in the reply — ConnectionString, ProviderName, the session key — is
      // dropped here and never stored. Only these three leave this function.
      const session: ImpersonatedSession = {
        sid: composeSid(tenantHost, sessionId),
        loginId: element(xml, 'LoginId') ?? login,
        ...(element(xml, 'SessionKeyExpire') === undefined
          ? {}
          : { expiresAt: element(xml, 'SessionKeyExpire') }),
      };
      return session;
    },

    async release(sid): Promise<void> {
      try {
        await get(service('RemoveSession', { sessionId: sid, tenantId: tenantHost }));
      } catch (error: unknown) {
        // A session nobody released expires by itself. Failing the conversation's teardown over
        // it would turn a tidy-up into an error the caller sees.
        logger.debug('releasing the impersonated session failed; it will expire on its own', {
          reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
        });
      }
    },
  };
}

/**
 * The login is in the query string, and a query string is the one part of a URL this codebase
 * logs. `$filter` routinely carries a person's name; so does this.
 */
function redactQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}
