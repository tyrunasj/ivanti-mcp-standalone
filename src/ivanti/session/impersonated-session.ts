// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { McpMode } from '../../config/env-schema.js';
import type { Logger } from '../../logger.js';
import { IvantiApiError, scrubErrorBody } from '../http/errors.js';
import type { FetchLike } from '../http/transport.js';
import type { IvantiRoutes } from '../odata/url.js';
import type { IvantiSession, SessionIdentity } from './asmx-session.js';
import type { CentralConfig } from './central-config.js';
import {
  chooseRole,
  flagsKnown,
  parseUserRoles,
  readRoles,
  selectRole,
  type IvantiRole,
} from './roles.js';

/**
 * One Ivanti session belonging to **a named person**, for the life of one conversation.
 *
 * Held beside the identity pin rather than inside it: the pin answers *who* this conversation is
 * helping, which is a question the server answers on its own; this is Ivanti's answer to *what
 * they may see*, and it only exists when impersonation is configured and reachable.
 *
 * **It carries every surface — once `SelectRole` has been called.** An earlier version of this
 * file said the opposite: that `Workspace.asmx`, the service catalog and the admin console answer
 * 551 to a CentralConfig session whatever role it holds. They do — until `SelectRole` is called,
 * even naming the role `InitializeSession` already reported. That call *activates* the session;
 * skipping it when the role already matched was what made the form surface look unreachable.
 * Controlled on a live tenant (same role, same CSRF): two `InitializeSession` calls stayed at 551,
 * one `InitializeSession` plus `SelectRole` answered 200. See `docs/notes.md`.
 */
export interface ImpersonatedSession extends IvantiSession {
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

  // Everything from here on can throw, and until the session is handed back to the caller
  // nobody else can release it. Three paths released explicitly and the rest did not:
  // `InitializeSession` failing, `GetRolesForUser` failing and either `SelectRole` failing all
  // threw straight out with the session still open on the tenant. `act_as` then reports "could
  // not open an Ivanti session as them", the model retries with the person's email instead of
  // their login, and each attempt mints another session that survives until the tenant timeout
  // — measured at 18,000 s here. One wrapper covers every exit rather than three of them.
  try {

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

    // The form-urlencoded handlers: `handlers/<path>`, the token as a LOWERCASE header.
    const callHandler = async (handlerPath: string, form: Record<string, string>): Promise<string> => {
      const url = routes.service(`handlers/${handlerPath}`);
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: `SID=${opened.sid}`,
            _csrftoken: csrf,
          },
          body: new URLSearchParams(form).toString(),
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
        throw new IvantiApiError({
          status: response.status,
          method: 'POST',
          url,
          body: scrubErrorBody(text, opened.sid),
        });
      }
      return text;
    };

    // The multipart upload: the token as a MIXED-case header, and no Content-Type — only fetch
    // knows the boundary it generated, and naming the type without it makes Ivanti read the body
    // as empty. Three spellings of one token, one session.
    const uploadToHandler = async (handlerPath: string, form: FormData): Promise<string> => {
      const url = routes.service(handlerPath);
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { Cookie: `SID=${opened.sid}`, _csrfToken: csrf },
          body: form,
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
        throw new IvantiApiError({
          status: response.status,
          method: 'POST',
          url,
          body: scrubErrorBody(text, opened.sid),
        });
      }
      return text;
    };

    // `tzoffset` is required: without it this answers 500, which reads as a broken session.
    const userData = (): Promise<Record<string, unknown>> =>
      call('Services/Session.asmx', 'GetUserData', { tzoffset: 0 });

    let roles = await readRoles(
      {
        userData,
        // A different convention: body only, no cookie and no CSRF, on the integration service.
        rolesForUser: () =>
          post(routes.service('ServiceAPI/FRSHEATIntegration.asmx/GetRolesForUser'), {
            sessionKey: opened.sid,
            tenantId: tenantHost,
          }),
      },
      logger,
    );

    const decision = {
      mode,
      enduserRole,
      ...(pinnedRole === undefined ? {} : { pinnedRole }),
    };
    const choice = chooseRole(roles, { ...decision, activeRole: status.ActiveRole ?? '' });

    if (!choice.ok) {
      throw new Error(choice.refusal);
    }

    // **Always selected, never skipped — even when it is the role Ivanti already reported.**
    //
    // `SelectRole` does not merely change the role, it ACTIVATES the session. A CentralConfig
    // session whose role was only ever *reported* by `InitializeSession` answers **551** to every
    // `Workspace.asmx` method, the service catalog and the admin console; after one `SelectRole`
    // call naming that same role, all of them answer 200. Controlled on a live tenant: two
    // `InitializeSession` calls and no `SelectRole` stayed at 551, while one `InitializeSession`
    // plus `SelectRole` — same role, same CSRF — returned 7 workspaces.
    //
    // Skipping the call when `choice.mustSelect` was false is what once made the whole form surface
    // look unreachable. `mustSelect` is kept because it still says whether the role *changed*, which
    // is worth reporting; it no longer decides whether to call.
    //
    // Mutable behind a getter: `switchTo` changes what Ivanti will answer, and a session object
    // still reporting the old role would have `switch_role` confirm a change that did not happen.
    let currentRole = await selectRole({ call }, choice.role);
    let note = choice.note;

    // The first choice was made blind when the roles arrived without flags — `GetRolesForUser` is
    // the only source that answers a role-less session, and it carries none. Blind means the
    // full-mode branch could only take the first entry Ivanti happened to list, which is how a
    // portal role gets opened in an agent deployment.
    //
    // Selecting a role usually makes `GetUserData` answer, and it answers WITH the flags — so try
    // again on real data. **Usually, not always**: measured against a live tenant, one account gets
    // 500 from `GetUserData` whether or not a role is active, so its flags are not merely
    // unavailable-yet but unobtainable. When that happens the choice stands on list order, and the
    // caller is told so rather than left to assume it was informed.
    if (!flagsKnown(roles)) {
      // `chooseRole` returns no note when a CONFIGURED role name matched one the person holds —
      // that is the one branch where the absent flags changed nothing, because the role was named
      // rather than inferred.
      const chosenByConfiguration = choice.note === undefined;
      let why: string | undefined;
      const flagged = await userData()
        .then(parseUserRoles)
        .catch((error: unknown) => {
          why = error instanceof Error ? error.message.slice(0, 120) : 'unknown';
          return [] as IvantiRole[];
        });

      logger.debug('re-read the roles now that the session has one', {
        login: opened.loginId,
        // Whether Ivanti answered, and whether it answered with the flags — the two ways this
        // second pass can come to nothing, which otherwise look identical from outside.
        answered: flagged.length,
        withFlags: flagsKnown(flagged),
        ...(why === undefined ? {} : { reason: why }),
      });

      if (flagged.length > 0 && flagsKnown(flagged)) {
        roles = flagged;
        const confirmed = chooseRole(flagged, { ...decision, activeRole: currentRole });
        if (!confirmed.ok) {
              throw new Error(confirmed.refusal);
        }
        if (confirmed.mustSelect) {
          logger.info('re-selecting the role now that Ivanti reports which are self-service', {
            login: opened.loginId,
            from: currentRole,
            to: confirmed.role,
          });
          currentRole = await selectRole({ call }, confirmed.role);
        }
        note = confirmed.note ?? note;
      } else if (chosenByConfiguration) {
        // The flags never arrived, but the role was not guessed: a configured name matched one
        // this person holds, which is a decision. Saying it "was taken from the order Ivanti
        // listed them" would be false, and the old code said it unconditionally.
        logger.debug('role flags unavailable, but the configured role matched', {
          login: opened.loginId,
          role: currentRole,
        });
      } else {
        // Say it plainly. A role picked from an arbitrary order should not read as a decision.
        //
        // The remedy has to name the setting THIS mode accepts: `validateConfig` refuses
        // `IVANTI_IMPERSONATION_ROLE` in `enduser` and exits 78, so the old text sent an operator
        // to a setting that would stop their server from starting — in the mode where this note
        // matters most.
        const setting = mode === 'enduser' ? 'ENDUSER_ROLE' : 'IVANTI_IMPERSONATION_ROLE';
        const blind =
          `Ivanti would not report which of this person's roles are self-service, so ${currentRole} ` +
          `was taken from the order it listed them (${roles.map((role) => role.name).join(', ')}) ` +
          `rather than chosen. Set ${setting} to decide it explicitly.`;
        note = note === undefined ? blind : `${note} ${blind}`;
        logger.warn('role chosen without Ivanti reporting which are self-service', {
          login: opened.loginId,
          role: currentRole,
        });
      }
    }

    if (note !== undefined) {
      logger.warn('impersonated session opened under a different role than configured', {
        login: opened.loginId,
        role: currentRole,
        note,
      });
    }

    // The role the session runs under, in the shape `workspaces.ts` and `form-context.ts` read it.
    // Live rather than captured: `switchTo` changes it, and a catalog built after a switch must see
    // the switched role.
    const identity = (): SessionIdentity => ({ role: currentRole, userName: opened.loginId });

    return {
      sid: opened.sid,
      loginId: opened.loginId,
      get role(): string {
        return currentRole;
      },
      roles,
      ...(note === undefined ? {} : { note }),
      call,
      callHandler,
      uploadToHandler,
      identity: () => Promise.resolve(identity()),
      identityIfKnown: identity,
      switchTo: async (next: string): Promise<string> => {
        currentRole = await selectRole({ call }, next);
        return currentRole;
      },
      release: () => centralConfig.release(opened.sid),
    };
  } catch (error) {
    // Teardown must never replace the error the caller needs to see.
    await centralConfig.release(opened.sid).catch(() => undefined);
    throw error;
  }
}
