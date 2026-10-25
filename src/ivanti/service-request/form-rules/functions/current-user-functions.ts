// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

// Current-user (session) functions: currentLoginId, currentUser{DisplayName,
// Email,Field,IdentityType,InTeam,OrganizationalUnit(Name),Role,Team,TeamNames,
// RecId}, currentGlobalCurrency, defaultCurrency{Code,Symbol}. Context-dependent,
// so produced from a live `CurrentUserContext` rather than reaching for globals.

import { str, type FunctionTable } from './coercion.js';

export interface CurrentUserContext {
  loginId?: string;
  displayName?: string;
  email?: string;
  // `currentUserIdentityType` source (e.g. `Employee#`).
  identityType?: string;
  roleId?: string;
  team?: string;
  teamNames?: string[];
  teamIds?: string[];
  orgUnitId?: string;
  orgUnitName?: string;
  // The currency symbol (`CurrentGlobalCurrency`) and code (`DefaultCurrencyCode`).
  globalCurrency?: string;
  currencyCode?: string;
  // Backing fields for `currentUserField(name)`.
  fields?: Record<string, unknown>;
}

export function currentUserFunctions(ctx: CurrentUserContext): FunctionTable {
  return {
    currentloginid: () => ctx.loginId ?? null,
    // `CurrentUserName` is the (undocumented) login-name alias rules compare
    // against system fields like `CreatedBy`/`LastModBy`, which store the login id.
    currentusername: () => ctx.loginId ?? null,
    currentuserdisplayname: () => ctx.displayName ?? null,
    currentuseremail: () => ctx.email ?? null,
    currentuserrole: () => ctx.roleId ?? null,
    currentuserteam: () => ctx.team ?? null,
    currentuserteamnames: () => ctx.teamNames ?? null,
    currentuserteamids: () => ctx.teamIds ?? null,
    currentuserorganizationalunit: () => ctx.orgUnitId ?? null,
    currentuserorganizationalunitname: () => ctx.orgUnitName ?? null,
    currentglobalcurrency: () => ctx.globalCurrency ?? null,
    defaultcurrencycode: () => ctx.currencyCode ?? 'USD',
    defaultcurrencysymbol: () => ctx.globalCurrency ?? null,
    currentuserfield: (a) => ctx.fields?.[str(a[0])] ?? null,
    currentuserinteam: (a): boolean => {
      const team = a[0];
      return (
        typeof team === 'string' &&
        (ctx.teamNames ?? []).map((t) => t.toLowerCase()).includes(team.toLowerCase())
      );
    },
    currentuseridentitytype: (): string => {
      let identity = ctx.identityType ?? '';
      if (identity.endsWith('#')) {
        identity = identity.slice(0, -1);
      }
      return identity.replace('#', '.');
    },
    // The signed-in user's own record id (their Employee/Profile RecId), held in
    // the user record's fields.
    currentuserrecid: (): string | null => {
      const recId = ctx.fields?.['RecId'];
      return typeof recId === 'string' ? recId : null;
    },
  };
}
