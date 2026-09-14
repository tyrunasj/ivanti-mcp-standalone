// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { McpMode } from '../../config/env-schema.js';

/**
 * Which of a person's Ivanti roles an impersonated session opens under.
 *
 * **Selecting one is mandatory, not a refinement.** A session whose `ActiveRole` is empty reads
 * *nothing* — measured: 0 incidents, 0 employees, 0 roles, where the same session under
 * `SelfService` read 628 employees. That is a broken session, not a restricted one, and using it
 * would answer "you have no incidents" with total confidence.
 *
 * **Ivanti labels its own self-service roles**, so nothing here infers one from a name or measures
 * one from workspace counts. `SelfServiceRole` arrives on `GetUserData.userRoleList` and is
 * authoritative; an earlier design ranked roles by object-workspace count, which was wrong twice
 * over — the counts do not separate the classes (`SelfServiceMobile` carries 1 object workspace
 * and `SelfService` carries 0, both self-service), and `GetRoleWorkspaces` answers 551 on every
 * impersonated session anyway.
 */

export interface IvantiRole {
  /** The role id — what `SelectRole` takes, e.g. `ServiceDeskAnalyst`. */
  name: string;
  /** The admin-facing label, e.g. `Service Desk Analyst`. */
  displayName: string;
  /**
   * Ivanti's own `SelfServiceRole` flag.
   *
   * `undefined` means **unknown**, not false: `GetRolesForUser` carries no flags, and it is the
   * only source that answers when the session has no active role. Treating unknown as false would
   * quietly hand an `enduser` deployment an analyst role.
   */
  selfService?: boolean;
}

/** `GetUserData.userRoleList` — note the lower-case `u`, unlike every sibling field. */
interface RawUserRole {
  Name?: string | null;
  DisplayName?: string | null;
  SelfServiceRole?: boolean | null;
}

/** `FRSHEATIntegration.asmx/GetRolesForUser` — the same roles, without the flags. */
interface RawNamedRole {
  Name?: string | null;
  DisplayName?: string | null;
}

export interface UserDataReply {
  UserRole?: string | null;
  userRoleList?: RawUserRole[] | null;
}

export interface RolesForUserReply {
  roleList?: RawNamedRole[] | null;
}

/** Keeps only entries with a usable id; the label falls back to it. */
export function parseUserRoles(reply: UserDataReply): IvantiRole[] {
  return (reply.userRoleList ?? [])
    .filter((role): role is RawUserRole & { Name: string } => Boolean(role.Name))
    .map((role) => ({
      name: role.Name,
      displayName: role.DisplayName ?? role.Name,
      // Only `true` and `false` are answers. A missing flag stays unknown.
      ...(typeof role.SelfServiceRole === 'boolean' ? { selfService: role.SelfServiceRole } : {}),
    }));
}

export function parseNamedRoles(reply: RolesForUserReply): IvantiRole[] {
  return (reply.roleList ?? [])
    .filter((role): role is RawNamedRole & { Name: string } => Boolean(role.Name))
    .map((role) => ({ name: role.Name, displayName: role.DisplayName ?? role.Name }));
}

export interface RoleSource {
  /**
   * `Session.asmx/GetUserData` — the only source carrying `SelfServiceRole`.
   *
   * It needs `tzoffset` (without it, 500) **and** an active role: a session Ivanti opened with an
   * empty `ActiveRole` gets 500 here too. So the richer source fails in exactly the case that
   * most needs a role chosen, which is why the fallback below is not optional.
   */
  userData: () => Promise<UserDataReply>;
  /**
   * `FRSHEATIntegration.asmx/GetRolesForUser` — `sessionKey` + `tenantId` in the body, no cookie
   * and no CSRF. No flags, but it answers for a session with no role at all.
   */
  rolesForUser: () => Promise<RolesForUserReply>;
}

/**
 * The roles this person holds, preferring the source that knows which are self-service.
 *
 * Falls back on an empty list as well as on a throw: an empty `userRoleList` and a failure are
 * the same thing to a caller, and Ivanti produces both.
 */
export async function readRoles(
  source: RoleSource,
  logger: { debug: (message: string, context?: Record<string, unknown>) => void },
): Promise<IvantiRole[]> {
  try {
    const roles = parseUserRoles(await source.userData());
    if (roles.length > 0) return roles;
    logger.debug('GetUserData reported no roles; asking GetRolesForUser');
  } catch (error: unknown) {
    // Expected whenever the session has no active role, which is a normal state here.
    logger.debug('GetUserData unavailable; asking GetRolesForUser', {
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
  }

  return parseNamedRoles(await source.rolesForUser());
}

export interface SessionCaller {
  call: <T>(servicePath: string, method: string, args?: Record<string, unknown>) => Promise<T>;
}

/**
 * Re-points an established session at another of the person's roles, and reports what it actually
 * became.
 *
 * **`Session.asmx/SelectRole`, not `FRSHEATIntegration.asmx/SetRoleForUserSession`.** This one is
 * on the single ASMX service an impersonated session may use, and it needs no re-authentication —
 * it rewrites Ivanti's own session state. (`Account/SelectRole` is a third thing: the signed-out
 * MVC form, which needs an anti-forgery token only available while signed out.)
 *
 * The reply carries the new `ActiveRole`, so the role is **read back rather than assumed** without
 * a second call — `AuthenticateTenantAPIKey` already set the precedent that a requested role is a
 * request, and silently answers with a different one.
 */
export async function selectRole(caller: SessionCaller, role: string): Promise<string> {
  const status = await caller.call<{ ActiveRole?: string | null }>(
    'Services/Session.asmx',
    'SelectRole',
    // Same spelling as `GetRoleWorkspaces` takes, which is not an accident on Ivanti's side.
    { sRole: role },
  );
  const effective = status.ActiveRole;
  return effective === undefined || effective === null || effective === '' ? role : effective;
}

export interface RoleChoiceOptions {
  mode: McpMode;
  /** `ENDUSER_ROLE` — the self-service role an end-user session should open under. */
  enduserRole: string;
  /** `IVANTI_IMPERSONATION_ROLE` — pins the role in `full` mode. */
  pinnedRole?: string;
  /** What `InitializeSession` reported, which may be empty. */
  activeRole: string;
}

export type RoleChoice =
  | {
      ok: true;
      /** The role to run under. */
      role: string;
      /** True when it differs from the active one, so `SelectRole` has to be called. */
      mustSelect: boolean;
      /** Said in a log line and in the tool response. Empty when nothing surprising happened. */
      note?: string;
    }
  | { ok: false; refusal: string };

const named = (roles: IvantiRole[], name: string): IvantiRole | undefined =>
  roles.find((role) => role.name.toLowerCase() === name.toLowerCase());

/**
 * Picks the role, or refuses with something a person can act on.
 *
 * Pure, because it is the part worth testing exhaustively: the I/O around it is three POSTs.
 */
export function chooseRole(roles: IvantiRole[], options: RoleChoiceOptions): RoleChoice {
  const { mode, enduserRole, pinnedRole, activeRole } = options;
  const decide = (role: string, note?: string): RoleChoice => ({
    ok: true,
    role,
    mustSelect: role.toLowerCase() !== activeRole.toLowerCase(),
    ...(note === undefined ? {} : { note }),
  });

  if (roles.length === 0 && activeRole === '') {
    return {
      ok: false,
      refusal:
        'Ivanti opened the session with no role and reported none available. A session with no ' +
        'role reads nothing at all, so it is refused rather than used.',
    };
  }

  if (mode === 'enduser') {
    const configured = named(roles, enduserRole);
    if (configured !== undefined) return decide(configured.name);

    // Ivanti's own flag, never a guess from the name. Unknown is not self-service.
    const anySelfService = roles.find((role) => role.selfService === true);
    if (anySelfService !== undefined) {
      return decide(
        anySelfService.name,
        `${enduserRole} is not held by this person; using their self-service role ` +
          `${anySelfService.name} instead.`,
      );
    }

    if (activeRole === '') {
      return {
        ok: false,
        refusal:
          `This person holds no self-service role — ${enduserRole} is not among theirs and ` +
          `Ivanti reports no other — and the session has no role to fall back to.`,
      };
    }

    // Not a lockout: the object gate still applies whatever the role turns out to be. But an
    // enduser deployment running an agent role is something an operator must be able to see.
    return decide(
      activeRole,
      `This person holds no self-service role (${enduserRole} is not among theirs), so the ` +
        `session keeps the role Ivanti made active: ${activeRole}.`,
    );
  }

  // full mode.
  if (pinnedRole !== undefined) {
    const pinned = named(roles, pinnedRole);
    if (pinned === undefined) {
      // Never silently ignored: a deployment that asked for a role and got a weaker one has been
      // told something false about what this session can reach.
      return {
        ok: false,
        refusal:
          `IVANTI_IMPERSONATION_ROLE is ${pinnedRole}, which this person does not hold. ` +
          `They hold: ${roles.map((role) => role.name).join(', ') || 'no roles Ivanti will report'}.`,
      };
    }
    return decide(pinned.name);
  }

  // Whatever Ivanti made active is the most faithful reading of "act as them", as long as it is
  // not the self-service portal — a `full` deployment is IT staff doing IT work.
  if (activeRole !== '' && named(roles, activeRole)?.selfService !== true) return decide(activeRole);

  const working = roles.find((role) => role.selfService !== true);
  if (working !== undefined) {
    return decide(
      working.name,
      activeRole === ''
        ? `Ivanti opened the session with no role; using ${working.name}.`
        : `The active role ${activeRole} is a self-service role; using ${working.name}.`,
    );
  }

  if (activeRole === '') {
    return {
      ok: false,
      refusal:
        'Ivanti opened the session with no role, and this person holds none that can be ' +
        'selected. A session with no role reads nothing at all.',
    };
  }

  // They only have self-service roles. That is a real answer about this person, not a failure.
  return decide(
    activeRole,
    `This person holds only self-service roles, so the session runs as ${activeRole}.`,
  );
}
