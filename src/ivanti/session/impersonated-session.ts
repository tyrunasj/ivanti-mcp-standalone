// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { McpMode } from '../../config/env-schema.js';
import type { Logger } from '../../logger.js';
import { IvantiApiError, scrubErrorBody } from '../http/errors.js';
import type { FetchLike } from '../http/transport.js';
import type { IvantiRoutes } from '../odata/url.js';
import type { CentralConfig } from './central-config.js';
import { chooseRole, readRoles, selectRole, type IvantiRole } from './roles.js';

/**
 * One Ivanti session belonging to **a named person**, for the life of one conversation.
 *
 * Held beside the identity pin rather than inside it: the pin answers *who* this conversation is
 * helping, which is a question the server answers on its own; this is Ivanti's answer to *what
 * they may see*, and it only exists when impersonation is configured and reachable.
 *
 * **It carries the record surface only.** OData accepts its SID cookie and applies the person's
 * own access. `Session.asmx` accepts it. Everything else — `Workspace.asmx`, so forms, pick
 * lists and quick actions, and the admin console — answers **551** to it, whatever role it holds,
 * and keeps running as the service account. That split is measured, not chosen; see
 * `docs/notes.md`.
 */
export interface ImpersonatedSession {
  /** The cookie value for both OData and ASMX: `<tenantId>#<sessionId>#1`. */
  readonly sid: string;
  /** The login Ivanti matched, which is not necessarily the spelling that was asked for. */
  readonly loginId: string;
  /** The role actually in force, read back from Ivanti rather than assumed. */
  readonly role: string;
  /** Every role this person holds, for `switch_role` to report without a second round trip. */
  readonly roles: readonly IvantiRole[];
  /** Something the caller should be told — a fallback role, a portal-only account. */
  readonly note?: string;
  /** POST to an ASMX service as this person. Only `Session.asmx` will answer. */
  call: <T>(servicePath: string, method: string, args?: Record<string, unknown>) => Promise<T>;
  /** Re-points the session at another of their roles, returning what Ivanti actually applied. */
  switchTo: (role: string) => Promise<string>;
  /** Best-effort; a session nobody releases expires on its own. */
  release: () => Promise<void>;
}

export interface OpenImpersonatedSessionOptions {
  centralConfig: CentralConfig;
  routes: IvantiRoutes;
  /** The tenant hostname — Ivanti's `tenantId`, and the same string in the URL. */
  tenantHost: string;
  login: string;
  mode: McpMode;
  enduserRole: string;
  pinnedRole?: string;
  logger: Logger;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface SessionStatus {
  SessionCsrfToken?: string | null;
  ActiveRole?: string | null;
}

export const DEFAULT_IMPERSONATION_TIMEOUT_MS = 15_000;

/**
 * Opens the session and establishes a role, or throws with a reason worth reading.
 *
 * The role step is not optional. A session Ivanti opens with an empty `ActiveRole` reads **zero of
 * everything** — measured — so using one would answer "you have no tickets" with total confidence.
 * Where no role can be established the whole thing is refused instead.
 */
export async function openImpersonatedSession(
  options: OpenImpersonatedSessionOptions,
): Promise<ImpersonatedSession> {
  const {
    centralConfig,
    routes,
    tenantHost,
    login,
    mode,
    enduserRole,
    pinnedRole,
    logger,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_IMPERSONATION_TIMEOUT_MS,
  } = options;

  const opened = await centralConfig.authenticate(login);

  const post = async <T>(url: string, body: Record<string, unknown>, sid?: string): Promise<T> => {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          Accept: 'application/json',
          ...(sid === undefined ? {} : { Cookie: `SID=${sid}` }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: unknown) {
      throw new IvantiApiError(
        { status: 0, method: 'POST', url, body: '' },
        `Ivanti is unreachable: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      // The SID is a live credential and Ivanti echoes submitted values into failures.
      throw new IvantiApiError({
        status: response.status,
        method: 'POST',
        url,
        body: scrubErrorBody(text, opened.sid),
      });
    }

    const parsed: unknown = text === '' ? {} : JSON.parse(text);
    return (parsed as { d?: T }).d ?? (parsed as T);
  };

  const initialize = (): Promise<SessionStatus> =>
    post<SessionStatus>(
      routes.service('Services/Session.asmx/InitializeSession'),
      { _csrfToken: null },
      opened.sid,
    );

  const status = await initialize();
  const csrf = status.SessionCsrfToken ?? '';
  if (csrf === '') {
    await centralConfig.release(opened.sid);
    throw new Error(
      `Ivanti opened a session for ${opened.loginId} but issued no CSRF token, so it cannot be used.`,
    );
  }

  const call = async <T>(
    servicePath: string,
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<T> =>
    // `.asmx` wants the token in the BODY — the `.ashx` handlers want it as a header, which is why
    // they do not share this path. (They are unreachable here in any case.)
    post<T>(routes.service(`${servicePath}/${method}`), { _csrfToken: csrf, ...args }, opened.sid);

  const roles = await readRoles(
    {
      // `tzoffset` is required: without it this answers 500, which reads as a broken session.
      userData: () => call('Services/Session.asmx', 'GetUserData', { tzoffset: 0 }),
      // A different convention: body only, no cookie and no CSRF, on the integration service.
      rolesForUser: () =>
        post(routes.service('ServiceAPI/FRSHEATIntegration.asmx/GetRolesForUser'), {
          sessionKey: opened.sid,
          tenantId: tenantHost,
        }),
    },
    logger,
  );

  const choice = chooseRole(roles, {
    mode,
    enduserRole,
    ...(pinnedRole === undefined ? {} : { pinnedRole }),
    activeRole: status.ActiveRole ?? '',
  });

  if (!choice.ok) {
    await centralConfig.release(opened.sid);
    throw new Error(choice.refusal);
  }

  // Mutable behind a getter: `switchTo` changes what Ivanti will answer, and a session object
  // still reporting the old role would have `switch_role` confirm a change that did not happen.
  let currentRole = choice.mustSelect ? await selectRole({ call }, choice.role) : choice.role;

  if (choice.note !== undefined) {
    logger.warn('impersonated session opened under a different role than configured', {
      login: opened.loginId,
      role: currentRole,
      note: choice.note,
    });
  }

  return {
    sid: opened.sid,
    loginId: opened.loginId,
    get role(): string {
      return currentRole;
    },
    roles,
    ...(choice.note === undefined ? {} : { note: choice.note }),
    call,
    switchTo: async (next: string): Promise<string> => {
      currentRole = await selectRole({ call }, next);
      return currentRole;
    },
    release: () => centralConfig.release(opened.sid),
  };
}
